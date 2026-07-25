"""Writing studio: standalone cover letters and short-form outreach.

Both generate from the candidate's master résumé (the only source of truth),
optionally in the user's saved writing voice, and are guardrail-checked. The
cover-letter render endpoints reuse the résumé LaTeX/DOCX machinery so a letter
exports to PDF, DOCX, or LaTeX just like a résumé does.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import CurrentUser, DbSession, GenerationUser
from app.core.config import settings
from app.core.logging import get_logger
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.models.writing import WritingProfile
from app.schemas.resume import MasterResume
from app.schemas.studio import (
    CoverLetterGenerateRequest,
    CoverLetterRenderRequest,
    CoverLetterResult,
    OutreachGenerateRequest,
    OutreachKindInfo,
    OutreachResult,
    ToneInfo,
)
from app.schemas.writing import VoiceProfile
from app.services import storage
from app.services.export.docx import cover_letter_to_docx
from app.services.latex.compiler import LatexCompilationError, compile_latex
from app.services.latex.renderer import render_cover_letter
from app.services.llm.client import (
    LlmConfigurationError,
    LlmError,
    LlmResponseError,
)
from app.services.llm.factory import client_for_user
from app.services.llm.prompts import COVER_LETTER_TONES, OUTREACH_KINDS
from app.services.pipeline import UsageLedger, compose_cover_letter, generate_outreach

router = APIRouter(prefix="/studio", tags=["studio"])
logger = get_logger(__name__)

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
def list_tones() -> list[ToneInfo]:
    return [
        ToneInfo(id=key, label=_TONE_LABELS.get(key, key.title()), description=desc)
        for key, desc in COVER_LETTER_TONES.items()
    ]


@router.get("/outreach/kinds", response_model=list[OutreachKindInfo])
def list_outreach_kinds() -> list[OutreachKindInfo]:
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

    ledger = UsageLedger()
    try:
        paragraphs, report = compose_cover_letter(
            resume,
            payload.job_text,
            company=payload.company,
            role=payload.role,
            tone=payload.tone,
            voice=voice,
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
    )


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
    date_line = datetime.now(UTC).strftime("%B %-d, %Y")
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
