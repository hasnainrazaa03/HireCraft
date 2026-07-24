"""Master resume profile CRUD."""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from pydantic import ValidationError
from sqlalchemy import select, update

from app.api.deps import CurrentUser, DbSession, GenerationUser
from app.core.config import settings
from app.core.crypto import decrypt
from app.core.logging import get_logger
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile, ResumeVersion
from app.schemas.api import (
    ResumeParseResponse,
    ResumeProfileCreate,
    ResumeProfileResponse,
    ResumeProfileSummary,
    ResumeProfileUpdate,
    ResumeVersionDetail,
    ResumeVersionSummary,
)
from app.schemas.resume import MasterResume
from app.services import resume_versions
from app.services.llm.client import GeminiClient, LlmError
from app.services.parsing.extract import ExtractionError, extract
from app.services.parsing.structure import ParsingError, structure_resume

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

    client = None
    if user.encrypted_gemini_key:
        try:
            client = GeminiClient(api_key=decrypt(user.encrypted_gemini_key))
        except Exception:  # noqa: BLE001 - fall back to the shared key
            client = None

    try:
        resume, usage = structure_resume(text, client=client)
    except ParsingError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Couldn't parse your résumé right now: {exc}",
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
