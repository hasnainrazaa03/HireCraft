"""Writing studio: standalone cover letters and short-form outreach.

Both generate from the candidate's master résumé (the only source of truth),
optionally in the user's saved writing voice, and are guardrail-checked. The
cover-letter render endpoints reuse the résumé LaTeX/DOCX machinery so a letter
exports to PDF, DOCX, or LaTeX just like a résumé does.
"""

from __future__ import annotations

import contextlib
import re
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession, GenerationUser
from app.api.routes.applications import _write_artifact
from app.core.config import settings
from app.core.logging import get_logger
from app.models.application import Application, ArtifactKind
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.models.saved_cover_letter import SavedCoverLetter
from app.models.writing import WritingProfile
from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.schemas.studio import (
    CoverLetterGenerateRequest,
    CoverLetterRenderRequest,
    CoverLetterResult,
    OutreachGenerateRequest,
    OutreachKindInfo,
    OutreachResult,
    SaveCoverLetterRequest,
    SavedCoverLetterAttachRequest,
    SavedCoverLetterDetail,
    SavedCoverLetterFeedbackRequest,
    SavedCoverLetterSummary,
    ToneInfo,
)
from app.schemas.tailoring import GuardrailReport
from app.schemas.writing import VoiceProfile
from app.services import storage
from app.services.activity import log_event
from app.services.evidence import evidence_lines
from app.services.export.docx import cover_letter_to_docx
from app.services.latex.compiler import LatexCompilationError, compile_latex
from app.services.latex.renderer import render_cover_letter
from app.services.llm.client import (
    LlmConfigurationError,
    LlmError,
    LlmResponseError,
)
from app.services.llm.factory import client_for_user
from app.services.llm.guardrails import GuardrailEngine
from app.services.llm.prompts import COVER_LETTER_TONES, OUTREACH_KINDS
from app.services.pipeline import (
    UsageLedger,
    compose_cover_letter,
    draft_cover_letter,
    generate_outreach,
)
from app.services.scraper import ScrapeError, scrape_job

router = APIRouter(prefix="/studio", tags=["studio"])
logger = get_logger(__name__)

_URL_ONLY = re.compile(r"^https?://\S+$", re.IGNORECASE)


def _resolve_job(
    job_text: str, company: str | None, role: str | None
) -> tuple[str, str | None, str | None]:
    """Turn a job field that may be a URL into real posting text + company/role.

    A user can paste either the description or a link. A bare URL is scraped (via
    the same fetcher tailoring uses, so Ashby/Greenhouse/Lever resolve through
    their APIs), and the company/role are filled from the posting when the user
    left them blank — so the letter is addressed to the actual employer instead
    of "the company". Pasted text is used as-is."""
    text = job_text.strip()
    if not _URL_ONLY.match(text):
        return job_text, company, role
    try:
        scraped = scrape_job(text)
    except ScrapeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Couldn't read that job link — {exc} Paste the description text instead.",
        ) from exc
    return scraped.text, (company or scraped.company), (role or scraped.title)

_TONE_LABELS = {
    "traditional": "Traditional",
    "modern": "Modern",
    "short": "Short & punchy",
    "enthusiastic": "Enthusiastic",
    "formal": "Formal",
    "startup": "Startup",
    "research": "Research-heavy",
    "academic": "Academic",
}
_KIND_LABELS = {
    "recruiter_email": "Recruiter email",
    "linkedin_connection": "LinkedIn connection note",
    "follow_up": "Application follow-up",
    "thank_you": "Post-interview thank-you",
    "interview_followup": "Interview status check-in",
    "referral_request": "Referral request",
    "offer_negotiation": "Offer negotiation",
}


def _owned_resume(db: DbSession, user_id: uuid.UUID, profile_id: uuid.UUID) -> ResumeProfile:
    profile = db.get(ResumeProfile, profile_id)
    if profile is None or profile.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Résumé not found."
        )
    return profile


def _voice_for(db: DbSession, user_id: uuid.UUID) -> VoiceProfile | None:
    profile = db.query(WritingProfile).filter(WritingProfile.user_id == user_id).first()
    if profile is None or not profile.voice:
        return None
    try:
        return VoiceProfile.model_validate(profile.voice)
    except Exception:  # noqa: BLE001 - a malformed voice shouldn't block writing
        return None


def _client_for(user, provider: str | None = None, model: str | None = None):  # noqa: ANN001
    """Build the LLM client for this user's active (or overridden) provider/model."""
    try:
        return client_for_user(user, provider=provider, model=model)
    except LlmConfigurationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


def _record(db: DbSession, user_id: uuid.UUID, ledger: UsageLedger) -> None:
    for purpose, usage in ledger.entries:
        db.add(
            LlmUsage(
                user_id=user_id,
                purpose=purpose,
                model=usage.model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cost_usd=usage.cost_usd,
                latency_ms=usage.latency_ms,
            )
        )
    db.commit()


@router.get("/cover-letters/tones", response_model=list[ToneInfo])
def list_tones(user: CurrentUser) -> list[ToneInfo]:
    return [
        ToneInfo(id=key, label=_TONE_LABELS.get(key, key.title()), description=desc)
        for key, desc in COVER_LETTER_TONES.items()
    ]


@router.get("/outreach/kinds", response_model=list[OutreachKindInfo])
def list_outreach_kinds(user: CurrentUser) -> list[OutreachKindInfo]:
    return [
        OutreachKindInfo(id=key, label=_KIND_LABELS.get(key, key.title()), description=desc)
        for key, desc in OUTREACH_KINDS.items()
    ]


@router.post("/cover-letters/generate", response_model=CoverLetterResult)
def generate_cover_letter(
    payload: CoverLetterGenerateRequest, user: GenerationUser, db: DbSession
) -> CoverLetterResult:
    profile = _owned_resume(db, user.id, payload.resume_profile_id)
    resume = MasterResume.model_validate(profile.content)
    voice = _voice_for(db, user.id) if payload.use_voice else None

    job_text, company, role = _resolve_job(
        payload.job_text, payload.company, payload.role
    )

    ledger = UsageLedger()
    try:
        paragraphs, report = compose_cover_letter(
            resume,
            job_text,
            company=company,
            role=role,
            tone=payload.tone,
            voice=voice,
            evidence=evidence_lines(db, user.id),
            client=_client_for(user),
            ledger=ledger,
        )
    except LlmResponseError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The AI returned an incomplete letter. Please try again.",
        ) from exc
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The AI service is unavailable right now: {exc}",
        ) from exc

    _record(db, user.id, ledger)
    return CoverLetterResult(
        paragraphs=paragraphs,
        guardrail_report=report,
        tone=payload.tone,
        used_voice=voice is not None,
        cost_usd=ledger.cost_usd,
        greeting=_greeting(payload.hiring_manager, company),
        signature=resume.basics.name,
    )


def _greeting(hiring_manager: str | None, company: str | None) -> str:
    """Same salutation the export template builds, so preview matches export."""
    if hiring_manager:
        return f"Dear {hiring_manager},"
    if company:
        return f"Dear Hiring Team at {company},"
    return "Dear Hiring Team,"


@router.post("/cover-letters/render.{fmt}")
def render_cover_letter_file(
    fmt: str, payload: CoverLetterRenderRequest, user: CurrentUser, db: DbSession
) -> Response:
    """Render provided cover-letter paragraphs to PDF, DOCX, or LaTeX.

    Deterministic — no LLM — so exporting an already-generated letter is instant
    and free. The résumé supplies the sender's contact block.
    """
    profile = _owned_resume(db, user.id, payload.resume_profile_id)
    resume = MasterResume.model_validate(profile.content)
    # Not strftime("%B %-d, %Y"): "%-d" is a glibc/BSD extension that raises on
    # Windows, so a dev running the API natively there can't export a letter.
    now = datetime.now(UTC)
    date_line = f"{now:%B} {now.day}, {now.year}"
    safe = storage.safe_filename(
        f"{(payload.company or resume.basics.name)}_cover_letter".replace(" ", "_"),
        fallback="cover_letter",
    )

    if fmt == "docx":
        data = cover_letter_to_docx(
            resume,
            payload.paragraphs,
            company=payload.company,
            role=payload.role,
            hiring_manager=payload.hiring_manager,
            date_line=date_line,
        )
        return Response(
            content=data,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="{safe}.docx"'},
        )

    tex = render_cover_letter(
        resume,
        payload.paragraphs,
        settings.templates_dir,
        company=payload.company,
        role=payload.role,
        hiring_manager=payload.hiring_manager,
        date_line=date_line,
    )

    if fmt in ("tex", "latex"):
        return Response(
            content=tex,
            media_type="application/x-tex",
            headers={"Content-Disposition": f'attachment; filename="{safe}.tex"'},
        )

    if fmt == "pdf":
        try:
            result = compile_latex(tex, job_name=safe)
        except LatexCompilationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Could not typeset this letter: {exc.summary()}",
            ) from exc
        return Response(
            content=result.pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="{safe}.pdf"'},
        )

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Unsupported format {fmt!r}. Use pdf, docx, or tex.",
    )


# --- Saved cover letters -----------------------------------------------------


def _get_owned_letter(
    db: DbSession, user_id: uuid.UUID, letter_id: uuid.UUID
) -> SavedCoverLetter:
    letter = db.get(SavedCoverLetter, letter_id)
    if letter is None or letter.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Saved cover letter not found."
        )
    return letter


def _application_label(
    db: DbSession, user_id: uuid.UUID, application_id: uuid.UUID | None
) -> str | None:
    if application_id is None:
        return None
    app = db.get(Application, application_id)
    if app is None or app.user_id != user_id:
        return None
    company = app.job.company if app.job else None
    role = app.job.title if app.job else None
    return " · ".join(x for x in (company, role) if x) or "Application"


def _signature_for(
    db: DbSession, user_id: uuid.UUID, resume_profile_id: uuid.UUID | None
) -> str:
    if resume_profile_id is None:
        return ""
    profile = db.get(ResumeProfile, resume_profile_id)
    if profile is None or profile.user_id != user_id:
        return ""
    with contextlib.suppress(Exception):
        return MasterResume.model_validate(profile.content).basics.name or ""
    return ""


def _saved_detail(
    db: DbSession, user_id: uuid.UUID, letter: SavedCoverLetter
) -> SavedCoverLetterDetail:
    report = None
    if letter.guardrail_report:
        with contextlib.suppress(Exception):
            report = GuardrailReport.model_validate(letter.guardrail_report)
    return SavedCoverLetterDetail(
        id=letter.id,
        company=letter.company,
        role=letter.role,
        hiring_manager=letter.hiring_manager,
        tone=letter.tone,
        used_voice=letter.used_voice,
        resume_profile_id=letter.resume_profile_id,
        application_id=letter.application_id,
        application_label=_application_label(db, user_id, letter.application_id),
        paragraphs=letter.paragraphs or [],
        job_text=letter.job_text,
        guardrail_report=report,
        greeting=_greeting(letter.hiring_manager, letter.company),
        signature=_signature_for(db, user_id, letter.resume_profile_id),
        created_at=letter.created_at,
        updated_at=letter.updated_at,
    )


def _store_on_application(
    db: DbSession,
    user_id: uuid.UUID,
    app: Application,
    resume: MasterResume,
    letter: SavedCoverLetter,
) -> None:
    """Render the letter and stage it on the application so it shows in that
    application's Cover Letter tab (PDF + LaTeX artifacts + stored paragraphs)."""
    tex = render_cover_letter(
        resume, letter.paragraphs, settings.templates_dir,
        company=letter.company, role=letter.role,
    )
    try:
        compiled = compile_latex(tex, job_name="cover_letter")
    except LatexCompilationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Couldn't typeset the cover letter: {exc.summary()}",
        ) from exc
    _write_artifact(
        db, app, user_id, ArtifactKind.COVER_LETTER_PDF,
        "cover_letter.pdf", compiled.pdf_bytes, "application/pdf",
    )
    _write_artifact(
        db, app, user_id, ArtifactKind.COVER_LETTER_TEX,
        "cover_letter.tex", tex.encode("utf-8"), "application/x-tex",
    )
    app.cover_letter = letter.paragraphs
    app.include_cover_letter = True
    log_event(app, "cover_letter", "Cover letter attached from studio")


def _sync_attached(
    db: DbSession, user_id: uuid.UUID, letter: SavedCoverLetter, resume: MasterResume
) -> None:
    """After a refine/regenerate, keep a linked application's copy in sync."""
    if letter.application_id is None:
        return
    app = db.get(Application, letter.application_id)
    if app is None or app.user_id != user_id:
        return
    _store_on_application(db, user_id, app, resume, letter)


@router.get("/cover-letters/saved", response_model=list[SavedCoverLetterSummary])
def list_saved_cover_letters(
    user: CurrentUser, db: DbSession
) -> list[SavedCoverLetterSummary]:
    rows = (
        db.execute(
            select(SavedCoverLetter)
            .where(SavedCoverLetter.user_id == user.id)
            .order_by(SavedCoverLetter.updated_at.desc())
        )
        .scalars()
        .all()
    )
    return [
        SavedCoverLetterSummary(
            id=letter.id,
            company=letter.company,
            role=letter.role,
            tone=letter.tone,
            used_voice=letter.used_voice,
            application_id=letter.application_id,
            application_label=_application_label(db, user.id, letter.application_id),
            paragraph_count=len(letter.paragraphs or []),
            updated_at=letter.updated_at,
        )
        for letter in rows
    ]


@router.post(
    "/cover-letters/saved",
    response_model=SavedCoverLetterDetail,
    status_code=status.HTTP_201_CREATED,
)
def save_cover_letter(
    payload: SaveCoverLetterRequest, user: CurrentUser, db: DbSession
) -> SavedCoverLetterDetail:
    _owned_resume(db, user.id, payload.resume_profile_id)  # ownership check
    letter = SavedCoverLetter(
        user_id=user.id,
        resume_profile_id=payload.resume_profile_id,
        company=payload.company,
        role=payload.role,
        hiring_manager=payload.hiring_manager,
        tone=payload.tone,
        used_voice=payload.used_voice,
        paragraphs=payload.paragraphs,
        job_text=payload.job_text,
        guardrail_report=(
            payload.guardrail_report.model_dump() if payload.guardrail_report else None
        ),
    )
    db.add(letter)
    db.commit()
    db.refresh(letter)
    return _saved_detail(db, user.id, letter)


@router.get(
    "/cover-letters/saved/{letter_id}", response_model=SavedCoverLetterDetail
)
def get_saved_cover_letter(
    letter_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> SavedCoverLetterDetail:
    return _saved_detail(db, user.id, _get_owned_letter(db, user.id, letter_id))


@router.post(
    "/cover-letters/saved/{letter_id}/refine", response_model=SavedCoverLetterDetail
)
def refine_saved_cover_letter(
    letter_id: uuid.UUID,
    payload: SavedCoverLetterFeedbackRequest,
    user: GenerationUser,
    db: DbSession,
) -> SavedCoverLetterDetail:
    letter = _get_owned_letter(db, user.id, letter_id)
    profile = (
        _owned_resume(db, user.id, letter.resume_profile_id)
        if letter.resume_profile_id
        else None
    )
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The résumé this letter was written from is no longer available.",
        )
    resume = MasterResume.model_validate(profile.content)
    requirements = JobRequirements(title=letter.role, company=letter.company)
    voice = _voice_for(db, user.id) if letter.used_voice else None
    ledger = UsageLedger()
    try:
        paragraphs = draft_cover_letter(
            resume, requirements, letter.job_text or "",
            tone=letter.tone, voice=voice, evidence=evidence_lines(db, user.id),
            feedback=payload.feedback, previous=letter.paragraphs,
            client=_client_for(user), ledger=ledger,
        )
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The AI service is unavailable right now: {exc}",
        ) from exc
    if not paragraphs:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Couldn't produce a grounded revision. Try rewording your request.",
        )
    letter.paragraphs = paragraphs
    # The stored guardrail flags described the OLD paragraphs; keeping them would
    # point the truthfulness panel at text that no longer exists. Re-vet the
    # revision so the flags match what's on the page.
    engine = GuardrailEngine(resume, requirements, evidence=evidence_lines(db, user.id))
    for paragraph in paragraphs:
        engine.vet_paragraph(paragraph)
    letter.guardrail_report = GuardrailReport(
        violations=engine.violations,
        keywords_requested=requirements.all_keywords() if requirements else [],
    ).model_dump()
    _sync_attached(db, user.id, letter, resume)
    _record(db, user.id, ledger)  # commits the session
    db.refresh(letter)
    return _saved_detail(db, user.id, letter)


@router.post(
    "/cover-letters/saved/{letter_id}/regenerate",
    response_model=SavedCoverLetterDetail,
)
def regenerate_saved_cover_letter(
    letter_id: uuid.UUID, user: GenerationUser, db: DbSession
) -> SavedCoverLetterDetail:
    letter = _get_owned_letter(db, user.id, letter_id)
    profile = (
        _owned_resume(db, user.id, letter.resume_profile_id)
        if letter.resume_profile_id
        else None
    )
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The résumé this letter was written from is no longer available.",
        )
    resume = MasterResume.model_validate(profile.content)
    voice = _voice_for(db, user.id) if letter.used_voice else None
    ledger = UsageLedger()
    try:
        paragraphs, report = compose_cover_letter(
            resume, letter.job_text or "",
            company=letter.company, role=letter.role, tone=letter.tone, voice=voice,
            evidence=evidence_lines(db, user.id), client=_client_for(user), ledger=ledger,
        )
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The AI service is unavailable right now: {exc}",
        ) from exc
    if not paragraphs:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Couldn't produce a grounded letter. Try again.",
        )
    letter.paragraphs = paragraphs
    letter.guardrail_report = report.model_dump()
    _sync_attached(db, user.id, letter, resume)
    _record(db, user.id, ledger)  # commits the session
    db.refresh(letter)
    return _saved_detail(db, user.id, letter)


@router.post(
    "/cover-letters/saved/{letter_id}/attach", response_model=SavedCoverLetterDetail
)
def attach_saved_cover_letter(
    letter_id: uuid.UUID,
    payload: SavedCoverLetterAttachRequest,
    user: CurrentUser,
    db: DbSession,
) -> SavedCoverLetterDetail:
    letter = _get_owned_letter(db, user.id, letter_id)
    app = db.get(Application, payload.application_id)
    if app is None or app.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Application not found."
        )
    # Render the sender block from the letter's résumé, falling back to the
    # application's own résumé if that profile is gone.
    profile = db.get(ResumeProfile, letter.resume_profile_id) if letter.resume_profile_id else None
    if profile is None or profile.user_id != user.id:
        profile = db.get(ResumeProfile, app.resume_profile_id)
    resume = MasterResume.model_validate(profile.content)
    # One letter per application: detach any other letter still pointing here, or
    # a later refine of that stale letter would silently overwrite this one.
    for other in db.execute(
        select(SavedCoverLetter).where(
            SavedCoverLetter.application_id == app.id,
            SavedCoverLetter.id != letter.id,
        )
    ).scalars():
        other.application_id = None
    letter.application_id = app.id
    _store_on_application(db, user.id, app, resume, letter)
    db.commit()
    db.refresh(letter)
    return _saved_detail(db, user.id, letter)


@router.delete(
    "/cover-letters/saved/{letter_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_saved_cover_letter(
    letter_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> None:
    letter = _get_owned_letter(db, user.id, letter_id)
    db.delete(letter)
    db.commit()


@router.post("/outreach/generate", response_model=OutreachResult)
def generate_outreach_message(
    payload: OutreachGenerateRequest, user: GenerationUser, db: DbSession
) -> OutreachResult:
    profile = _owned_resume(db, user.id, payload.resume_profile_id)
    resume = MasterResume.model_validate(profile.content)
    voice = _voice_for(db, user.id) if payload.use_voice else None

    ledger = UsageLedger()
    try:
        draft, warnings = generate_outreach(
            resume,
            payload.kind,
            company=payload.company,
            role=payload.role,
            recipient=payload.recipient,
            context=payload.context,
            voice=voice,
            client=_client_for(user),
            ledger=ledger,
        )
    except LlmResponseError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The AI returned an incomplete draft. Please try again.",
        ) from exc
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The AI service is unavailable right now: {exc}",
        ) from exc

    _record(db, user.id, ledger)
    return OutreachResult(
        kind=payload.kind,
        subject=draft.subject,
        body=draft.body,
        used_voice=voice is not None,
        cost_usd=ledger.cost_usd,
        warnings=warnings,
    )
