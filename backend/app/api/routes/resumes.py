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
    ProfileIntroResponse,
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
from app.services.latex.compiler import LatexCompilationError
from app.services.latex.renderer import render_and_fit, render_resume
from app.services.latex.templates import TEMPLATES, is_valid, resolve_filename
from app.services.llm.client import LlmConfigurationError, LlmError, LlmResponseError
from app.services.llm.factory import client_for_user
from app.services.parsing.extract import ExtractionError, extract
from app.services.parsing.structure import (
    ParsingError,
    _coerce_valid,
    _repair,
    structure_resume,
)
from app.services.pipeline import (
    UsageLedger,
    generate_profile_intro,
    rewrite_resume,
)

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

    source_filename = source_path = source_type = None
    source_size = None
    if payload.source_ref:
        # Path-prefix check: a ref only ever addresses this user's own stash.
        if not payload.source_ref.startswith(f"{user.id}/resume-sources/"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid source reference."
            )
        try:
            data = storage.read_bytes(payload.source_ref)
            source_path = payload.source_ref
            source_filename = payload.source_ref.rsplit("-", 1)[-1] or "resume"
            source_size = len(data)
            source_type = _CONTENT_TYPES.get(source_filename.rsplit(".", 1)[-1].lower())
        except Exception as exc:  # noqa: BLE001 - never fail a save over the copy
            logger.info("resume.source_missing", error=str(exc)[:200])

    profile = ResumeProfile(
        user_id=user.id,
        name=payload.name,
        content=payload.content.model_dump(mode="json"),
        source_filename=source_filename,
        source_path=source_path,
        source_content_type=source_type,
        source_size_bytes=source_size,
        is_default=is_default,
        tags=_clean_tags(payload.tags),
        template=payload.template if payload.template and is_valid(payload.template) else "modern",
        one_page=payload.one_page,
        # Label for the very first version; inherited by its snapshot on first edit.
        label=payload.version_label or "Original",
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
    # Keep the uploaded file. Parsing is lossy and a template re-render is a
    # different document, so this is the only faithful copy of what the user
    # actually sent. It is attached to the profile when they save (source_ref).
    source_ref: str | None = None
    try:
        source_ref = f"{user.id}/resume-sources/{uuid.uuid4()}-{storage.safe_filename(filename)}"
        storage.save_bytes(source_ref, raw)
    except Exception as exc:  # noqa: BLE001 - the import still works without it
        logger.info("resume.source_not_stashed", error=str(exc)[:200])
        source_ref = None

    logger.info("resume.parsed", user_id=str(user.id), cost_usd=usage.cost_usd)
    return ResumeParseResponse(
        content=resume, cost_usd=usage.cost_usd, source_filename=filename,
        source_ref=source_ref,
    )


@router.get("/schema", response_model=dict)
def resume_json_schema(user: CurrentUser) -> dict:
    """The Master Resume JSON Schema, for client-side validation and docs."""
    return MasterResume.model_json_schema()


@router.get("/templates", response_model=list[TemplateInfo])
def list_templates(user: CurrentUser) -> list[TemplateInfo]:
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


@router.post("/generate-intro", response_model=ProfileIntroResponse)
def generate_intro(
    payload: dict, user: GenerationUser, db: DbSession
) -> ProfileIntroResponse:
    """Draft a headline + summary from the rest of the résumé (builder button).

    Works on whatever content the builder currently holds — no need to save
    first, and no need for a complete contact block: this button is meant to be
    used early. Truthful by construction: it can't cite a number or skill the
    résumé doesn't contain. Costs one LLM call; the tighter generation rate
    limit applies.
    """
    # The intro is written from experience/projects/skills only — name and email
    # never appear in it — but MasterResume requires them, so a half-filled
    # résumé would fail strict body validation and leak raw pydantic errors to
    # the user. Substitute placeholder basics (never echoed), drop the
    # headline/summary we're regenerating, then salvage: blank or invalid entries
    # are dropped exactly as on import. What's left decides whether there's
    # anything real to write from.
    content = dict(payload or {})
    raw_basics = content.get("basics")
    basics = {
        k: v
        for k, v in (raw_basics if isinstance(raw_basics, dict) else {}).items()
        if k not in ("headline", "summary")
    }
    if not str(basics.get("name") or "").strip():
        basics["name"] = "Candidate"
    if not str(basics.get("email") or "").strip():
        basics["email"] = "candidate@example.com"
    content["basics"] = basics

    # Drop blank list items (trailing "Add bullet" placeholders) so a single
    # empty bullet can't make the salvage condemn an otherwise-real entry.
    for section in ("experience", "education", "projects"):
        for entry in content.get(section) or []:
            if not isinstance(entry, dict):
                continue
            for list_key in ("highlights", "technologies", "coursework", "honors"):
                if isinstance(entry.get(list_key), list):
                    entry[list_key] = [
                        s for s in entry[list_key] if isinstance(s, str) and s.strip()
                    ]

    try:
        master = _coerce_valid(_repair(content))
    except (ParsingError, ValidationError):
        master = None

    if master is None or not (
        master.experience or master.projects or master.education
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Add some experience, projects, or education first — the AI "
            "writes your intro from what's already on your résumé.",
        )

    try:
        client = client_for_user(user)
    except LlmConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    ledger = UsageLedger()
    try:
        intro = generate_profile_intro(master, client=client, ledger=ledger)
    except LlmResponseError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The AI returned an incomplete draft. Please try again in a moment.",
        ) from exc
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The AI service is unavailable right now: {exc}",
        ) from exc

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
        "resume.generated_intro", user_id=str(user.id), cost_usd=ledger.cost_usd
    )
    return ProfileIntroResponse(
        headline=intro.headline, summary=intro.summary, cost_usd=ledger.cost_usd
    )


@router.get("/{profile_id}/render.{fmt}")
def render_resume_file(
    profile_id: uuid.UUID,
    fmt: str,
    user: CurrentUser,
    db: DbSession,
    template: str | None = None,
    one_page: bool | None = None,
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
        # A per-request override wins; otherwise honor the résumé's saved
        # preference. When on, render_and_fit escalates compaction until it fits.
        fit_one_page = one_page if one_page is not None else profile.one_page
        try:
            result, _, _rendered = render_and_fit(
                resume,
                settings.templates_dir,
                template_name=resolve_filename(template_id),
                one_page=fit_one_page,
                job_name=safe,
            )
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
    if payload.one_page is not None:
        profile.one_page = payload.one_page
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
    was_default = profile.is_default
    db.delete(profile)
    db.flush()

    # Deleting the default used to leave the account with none: only the very
    # first résumé is auto-defaulted, so nothing would ever reclaim the flag and
    # the library showed no default from then on. Promote the most recently
    # updated survivor.
    if was_default:
        replacement = db.scalar(
            select(ResumeProfile)
            .where(ResumeProfile.user_id == user.id)
            .order_by(ResumeProfile.updated_at.desc())
            .limit(1)
        )
        if replacement is not None:
            replacement.is_default = True

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


_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
    "tex": "application/x-tex",
    "txt": "text/plain",
    "json": "application/json",
    "md": "text/markdown",
}


@router.get("/{profile_id}/original")
def download_original(profile_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    """The file this résumé was imported from, byte-for-byte.

    Parsing is lossy and a template render is a different document, so this is
    the only way back to exactly what the user uploaded.
    """
    profile = _get_owned(db, user.id, profile_id)
    if not profile.source_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This résumé was built in the app, so there's no uploaded original.",
        )
    try:
        data = storage.read_bytes(profile.source_path)
    except storage.StorageError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="The original file is no longer available."
        ) from exc
    name = profile.source_filename or "resume"
    return Response(
        content=data,
        media_type=profile.source_content_type or "application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{storage.safe_filename(name)}"',
            "Cache-Control": "no-store",
        },
    )
