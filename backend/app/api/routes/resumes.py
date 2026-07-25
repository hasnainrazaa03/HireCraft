"""Master resume profile CRUD."""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, File, HTTPException, Response, UploadFile, status
from pydantic import ValidationError
from sqlalchemy import select, update

from app.api.deps import CurrentUser, DbSession, GenerationUser
from app.core.config import settings
from app.core.logging import get_logger
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile, ResumeVersion
from app.schemas.analysis import ResumeAnalysis
from app.schemas.api import (
    ResumeParseResponse,
    ResumeProfileCreate,
    ResumeProfileResponse,
    ResumeProfileSummary,
    ResumeProfileUpdate,
    ResumeRewriteResponse,
    ResumeVersionDetail,
    ResumeVersionSummary,
    TemplateInfo,
)
from app.schemas.resume import MasterResume
from app.services import resume_versions, storage
from app.services.analysis import analyze_resume
from app.services.export.docx import resume_to_docx
from app.services.latex.compiler import LatexCompilationError, compile_latex
from app.services.latex.renderer import render_resume
from app.services.latex.templates import TEMPLATES, is_valid, resolve_filename
from app.services.llm.client import LlmConfigurationError, LlmError, LlmResponseError
from app.services.llm.factory import client_for_user
from app.services.parsing.extract import ExtractionError, extract
from app.services.parsing.structure import ParsingError, structure_resume
from app.services.pipeline import UsageLedger, rewrite_resume

logger = get_logger(__name__)

router = APIRouter(prefix="/resumes", tags=["resumes"])


def _get_owned(db: DbSession, user_id: uuid.UUID, profile_id: uuid.UUID) -> ResumeProfile:
    profile = db.get(ResumeProfile, profile_id)
    # Same 404 for "does not exist" and "belongs to someone else", so the API
    # never confirms the existence of another user's resource.
    if profile is None or profile.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Resume profile not found."
        )
    return profile


def _clear_other_defaults(db: DbSession, user_id: uuid.UUID, keep: uuid.UUID | None) -> None:
    stmt = (
        update(ResumeProfile)
        .where(ResumeProfile.user_id == user_id, ResumeProfile.is_default.is_(True))
        .values(is_default=False)
    )
    if keep is not None:
        stmt = stmt.where(ResumeProfile.id != keep)
    db.execute(stmt)


@router.get("", response_model=list[ResumeProfileSummary])
def list_profiles(user: CurrentUser, db: DbSession) -> list[ResumeProfile]:
    return list(
        db.scalars(
            select(ResumeProfile)
            .where(ResumeProfile.user_id == user.id)
            .order_by(ResumeProfile.is_default.desc(), ResumeProfile.updated_at.desc())
        )
    )


@router.post("", response_model=ResumeProfileResponse, status_code=status.HTTP_201_CREATED)
def create_profile(
    payload: ResumeProfileCreate, user: CurrentUser, db: DbSession
) -> ResumeProfile:
    existing = db.scalar(
        select(ResumeProfile).where(
            ResumeProfile.user_id == user.id, ResumeProfile.name == payload.name
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You already have a resume profile named {payload.name!r}.",
        )

    has_any = db.scalar(
        select(ResumeProfile.id).where(ResumeProfile.user_id == user.id).limit(1)
    )
    # The first profile a user creates is their default whether they asked or not.
    is_default = payload.is_default or has_any is None

    profile = ResumeProfile(
        user_id=user.id,
        name=payload.name,
        content=payload.content.model_dump(mode="json"),
        is_default=is_default,
        tags=_clean_tags(payload.tags),
        template=payload.template if payload.template and is_valid(payload.template) else "modern",
    )
    db.add(profile)
    db.flush()
    if is_default:
        _clear_other_defaults(db, user.id, profile.id)
    db.commit()
    db.refresh(profile)
    return profile


@router.post(
    "/upload", response_model=ResumeProfileResponse, status_code=status.HTTP_201_CREATED
)
async def upload_profile(
    user: CurrentUser,
    db: DbSession,
    file: UploadFile = File(..., description="Master Resume JSON file"),
    name: str | None = None,
) -> ResumeProfile:
    """Create a profile from an uploaded Master Resume JSON file."""
    raw = await file.read(settings.max_upload_bytes + 1)
    if len(raw) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {settings.max_upload_bytes // 1024 // 1024} MB limit.",
        )

    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"That file is not valid JSON: {exc}",
        ) from exc

    try:
        resume = MasterResume.model_validate(parsed)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_readable_validation_error(exc),
        ) from exc

    profile_name = name or (file.filename or "Master Resume").rsplit(".", 1)[0]
    return create_profile(
        ResumeProfileCreate(name=profile_name[:120], content=resume), user, db
    )


def _readable_validation_error(exc: ValidationError) -> str:
    lines = []
    for error in exc.errors()[:8]:
        location = ".".join(str(p) for p in error["loc"]) or "(root)"
        lines.append(f"{location}: {error['msg']}")
    suffix = "" if exc.error_count() <= 8 else f" (+{exc.error_count() - 8} more)"
    return "Resume JSON is invalid -- " + "; ".join(lines) + suffix


@router.post("/parse", response_model=ResumeParseResponse)
async def parse_resume(
    user: GenerationUser,
    db: DbSession,
    file: UploadFile = File(..., description="A PDF, DOCX, LaTeX, or text résumé"),
) -> ResumeParseResponse:
    """Extract and structure an uploaded résumé into a draft — NOT saved.

    The client loads the result into the builder for review, then saves it via
    the normal create endpoint. Costs one LLM call; the tighter generation rate
    limit applies.
    """
    raw = await file.read(settings.max_upload_bytes + 1)
    if len(raw) > settings.max_upload_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {settings.max_upload_bytes // 1024 // 1024} MB limit.",
        )
    filename = file.filename or "resume"

    # A .json résumé is already structured — validate it directly, no LLM needed.
    if filename.lower().endswith(".json"):
        try:
            resume = MasterResume.model_validate(json.loads(raw.decode("utf-8")))
        except (json.JSONDecodeError, UnicodeDecodeError, ValidationError) as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=_readable_validation_error(exc)
                if isinstance(exc, ValidationError)
                else f"That JSON file is invalid: {exc}",
            ) from exc
        return ResumeParseResponse(content=resume, cost_usd=0.0, source_filename=filename)

    try:
        text = extract(filename, raw)
    except ExtractionError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    try:
        client = client_for_user(user)
    except LlmConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    try:
        resume, usage = structure_resume(text, client=client)
    except (ParsingError, LlmResponseError) as exc:
        # Couldn't fit the model's output into a valid résumé (or it came back
        # truncated). Recoverable: send them to the builder to finish by hand.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "We read your file but couldn't structure all of it automatically. "
                "Try the builder to finish it, or paste the text instead."
            ),
        ) from exc
    except LlmError as exc:
        # A genuine provider outage or quota exhaustion — nothing the user can fix.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The AI service is unavailable right now: {exc}",
        ) from exc

    db.add(
        LlmUsage(
            user_id=user.id,
            purpose="resume_parse",
            model=usage.model,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cost_usd=usage.cost_usd,
            latency_ms=usage.latency_ms,
        )
    )
    db.commit()
    logger.info("resume.parsed", user_id=str(user.id), cost_usd=usage.cost_usd)
    return ResumeParseResponse(
        content=resume, cost_usd=usage.cost_usd, source_filename=filename
    )


@router.get("/schema", response_model=dict)
def resume_json_schema() -> dict:
    """The Master Resume JSON Schema, for client-side validation and docs."""
    return MasterResume.model_json_schema()


@router.get("/templates", response_model=list[TemplateInfo])
def list_templates() -> list[TemplateInfo]:
    """The available résumé templates a user can pick from."""
    return [TemplateInfo(id=t.id, name=t.name, description=t.description) for t in TEMPLATES]


@router.post("/analyze", response_model=ResumeAnalysis)
def analyze_content(payload: MasterResume, user: CurrentUser) -> ResumeAnalysis:
    """Score arbitrary résumé content — used by the builder for live feedback.

    Fully deterministic (no LLM), so it's instant and free to call on every edit.
    """
    return analyze_resume(payload)


@router.get("/{profile_id}/analysis", response_model=ResumeAnalysis)
def analyze_profile(
    profile_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> ResumeAnalysis:
    """Score a saved résumé: overall grade, per-metric breakdown, findings, ATS."""
    profile = _get_owned(db, user.id, profile_id)
    return analyze_resume(MasterResume.model_validate(profile.content))


@router.post("/{profile_id}/rewrite", response_model=ResumeRewriteResponse)
def rewrite_profile(
    profile_id: uuid.UUID, user: GenerationUser, db: DbSession
) -> ResumeRewriteResponse:
    """AI-improve a résumé's wording, impact, and ordering — no target job.

    The deterministic analyzer first finds concrete weaknesses (weak openers,
    buried metrics, wordy bullets); those are fed to the model so it fixes real
    problems. The same guardrail engine that protects tailoring runs here, so the
    rewrite can never invent numbers, skills, or facts. Nothing is saved — the
    client reviews the diff and before/after scores, then saves as a new version.
    Costs one LLM call; the tighter generation rate limit applies.
    """
    profile = _get_owned(db, user.id, profile_id)
    master = MasterResume.model_validate(profile.content)

    before = analyze_resume(master)

    try:
        client = client_for_user(user)
    except LlmConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    ledger = UsageLedger()
    try:
        improved, report, diff = rewrite_resume(
            master,
            findings=[f"{f.title}: {f.detail}" for f in before.findings],
            client=client,
            ledger=ledger,
        )
    except LlmResponseError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "The AI returned an incomplete rewrite. Please try again in a moment."
            ),
        ) from exc
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The AI service is unavailable right now: {exc}",
        ) from exc

    after = analyze_resume(improved)

    for purpose, usage in ledger.entries:
        db.add(
            LlmUsage(
                user_id=user.id,
                purpose=purpose,
                model=usage.model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cost_usd=usage.cost_usd,
                latency_ms=usage.latency_ms,
            )
        )
    db.commit()
    logger.info(
        "resume.rewritten",
        user_id=str(user.id),
        profile_id=str(profile_id),
        score_before=before.overall_score,
        score_after=after.overall_score,
        cost_usd=ledger.cost_usd,
    )
    return ResumeRewriteResponse(
        content=improved,
        diff=diff,
        guardrail_report=report,
        score_before=before.overall_score,
        score_after=after.overall_score,
        cost_usd=ledger.cost_usd,
    )


@router.get("/{profile_id}/render.{fmt}")
def render_resume_file(
    profile_id: uuid.UUID,
    fmt: str,
    user: CurrentUser,
    db: DbSession,
    template: str | None = None,
) -> Response:
    """Render a résumé to PDF, LaTeX, or DOCX in a chosen (or its own) template.

    Serves both template preview and export. The compile happens in FastAPI's
    threadpool, so a few-second LaTeX run doesn't block the event loop.
    """
    profile = _get_owned(db, user.id, profile_id)
    resume = MasterResume.model_validate(profile.content)
    template_id = template if (template and is_valid(template)) else profile.template
    safe = storage.safe_filename(profile.name.replace(" ", "_"), fallback="resume")

    if fmt == "json":
        return Response(
            content=json.dumps(profile.content, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{safe}.json"'},
        )

    if fmt in ("tex", "latex"):
        tex = render_resume(
            resume, settings.templates_dir, template_name=resolve_filename(template_id)
        )
        return Response(
            content=tex,
            media_type="application/x-tex",
            headers={"Content-Disposition": f'attachment; filename="{safe}.tex"'},
        )

    if fmt == "docx":
        docx_bytes = resume_to_docx(resume)
        return Response(
            content=docx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="{safe}.docx"'},
        )

    if fmt == "pdf":
        tex = render_resume(
            resume, settings.templates_dir, template_name=resolve_filename(template_id)
        )
        try:
            result = compile_latex(tex, job_name=safe)
        except LatexCompilationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Could not typeset this résumé: {exc.summary()}",
            ) from exc
        # inline so the frontend can preview it in an <embed>/<iframe>
        return Response(
            content=result.pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'inline; filename="{safe}.pdf"'},
        )

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Unsupported format {fmt!r}. Use pdf, tex, docx, or json.",
    )


@router.get("/{profile_id}", response_model=ResumeProfileResponse)
def get_profile(profile_id: uuid.UUID, user: CurrentUser, db: DbSession) -> ResumeProfile:
    return _get_owned(db, user.id, profile_id)


@router.patch("/{profile_id}", response_model=ResumeProfileResponse)
def update_profile(
    profile_id: uuid.UUID,
    payload: ResumeProfileUpdate,
    user: CurrentUser,
    db: DbSession,
) -> ResumeProfile:
    profile = _get_owned(db, user.id, profile_id)

    if payload.name is not None:
        profile.name = payload.name
    if payload.tags is not None:
        profile.tags = _clean_tags(payload.tags)
    if payload.template is not None and is_valid(payload.template):
        profile.template = payload.template
    if payload.content is not None:
        # Snapshot the old content before overwriting, so the edit is undoable.
        resume_versions.update_content(
            db,
            profile,
            payload.content.model_dump(mode="json"),
            label=payload.version_label,
        )
    if payload.is_default:
        _clear_other_defaults(db, user.id, profile.id)
        profile.is_default = True

    db.commit()
    db.refresh(profile)
    return profile


# --- Version history --------------------------------------------------------


@router.get("/{profile_id}/versions", response_model=list[ResumeVersionSummary])
def list_versions(
    profile_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> list[ResumeVersion]:
    profile = _get_owned(db, user.id, profile_id)
    return list(profile.versions)  # already ordered newest-first by the relationship


@router.get("/{profile_id}/versions/{version}", response_model=ResumeVersionDetail)
def get_version(
    profile_id: uuid.UUID, version: int, user: CurrentUser, db: DbSession
) -> ResumeVersion:
    profile = _get_owned(db, user.id, profile_id)
    snapshot = next((v for v in profile.versions if v.version == version), None)
    if snapshot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found.")
    return snapshot


@router.post("/{profile_id}/versions/{version}/restore", response_model=ResumeProfileResponse)
def restore_version(
    profile_id: uuid.UUID, version: int, user: CurrentUser, db: DbSession
) -> ResumeProfile:
    profile = _get_owned(db, user.id, profile_id)
    if not resume_versions.rollback(db, profile, version):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Version not found.")
    db.commit()
    db.refresh(profile)
    return profile


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_profile(profile_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    profile = _get_owned(db, user.id, profile_id)
    if profile.applications:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This resume is used by existing applications. Delete those first, "
                "or keep it for your records."
            ),
        )
    db.delete(profile)
    db.commit()


def _clean_tags(tags: list[str]) -> list[str]:
    """Trim, drop blanks, de-dupe (case-insensitive), preserve order."""
    seen: set[str] = set()
    out: list[str] = []
    for tag in tags:
        cleaned = tag.strip()[:40]
        key = cleaned.lower()
        if cleaned and key not in seen:
            seen.add(key)
            out.append(cleaned)
    return out[:20]
