"""Account management: settings, data export, and deletion."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.core.crypto import decrypt, encrypt
from app.core.logging import get_logger
from app.models.application import Application
from app.models.job import Job
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.models.user import DEFAULT_NOTIFICATION_PREFS, User
from app.schemas.api import AccountSettingsUpdate, MessageResponse, UserResponse
from app.schemas.profile import ApiKeyStatus, ApiKeyUpdate
from app.services import storage
from app.services.llm.client import GeminiClient, LlmError

router = APIRouter(prefix="/account", tags=["account"])
logger = get_logger(__name__)


class _ApiKeyProbe(BaseModel):
    """Minimal schema for the key-validation probe call."""

    ok: bool = True


@router.patch("/settings", response_model=UserResponse)
def update_settings(
    payload: AccountSettingsUpdate, user: CurrentUser, db: DbSession
) -> User:
    if payload.theme is not None:
        user.theme = payload.theme
    if payload.full_name is not None:
        user.full_name = payload.full_name or None
    if payload.notification_prefs is not None:
        # Merge onto known keys only, so an unknown key can't pollute prefs.
        merged = {**DEFAULT_NOTIFICATION_PREFS, **user.notification_prefs}
        for key, value in payload.notification_prefs.items():
            if key in DEFAULT_NOTIFICATION_PREFS:
                merged[key] = bool(value)
        user.notification_prefs = merged
    db.commit()
    db.refresh(user)
    return user


@router.get("/api-key", response_model=ApiKeyStatus)
def api_key_status(user: CurrentUser) -> ApiKeyStatus:
    """Whether the user has their own key, and a last-4 hint — never the key."""
    if not user.encrypted_gemini_key:
        return ApiKeyStatus(configured=False)
    try:
        hint = decrypt(user.encrypted_gemini_key)[-4:]
    except Exception:  # noqa: BLE001 - a stale ciphertext shouldn't 500 this
        hint = None
    return ApiKeyStatus(configured=True, hint=f"…{hint}" if hint else None)


@router.put("/api-key", response_model=ApiKeyStatus)
def set_api_key(payload: ApiKeyUpdate, user: CurrentUser, db: DbSession) -> ApiKeyStatus:
    """Validate a Gemini key with a tiny live call, then store it encrypted."""
    key = payload.api_key.strip()
    try:
        # A cheap generate confirms the key works before we save it, so a bad
        # key fails here rather than silently on the user's next tailoring run.
        GeminiClient(api_key=key).generate_structured(
            prompt="Return the JSON {\"ok\": true}.",
            schema=_ApiKeyProbe,
            temperature=0.0,
            max_output_tokens=32,
        )
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"That key didn't work: {exc}",
        ) from exc

    user.encrypted_gemini_key = encrypt(key)
    db.commit()
    logger.info("account.api_key_set", user_id=str(user.id))
    return ApiKeyStatus(configured=True, hint=f"…{key[-4:]}")


@router.delete("/api-key", response_model=MessageResponse)
def clear_api_key(user: CurrentUser, db: DbSession) -> MessageResponse:
    user.encrypted_gemini_key = None
    db.commit()
    return MessageResponse(message="Your API key has been removed. Runs use the shared key.")


@router.get("/export")
def export_data(user: CurrentUser, db: DbSession) -> JSONResponse:
    """Return everything HireCraft holds for this user as one JSON document."""
    resumes = db.scalars(
        select(ResumeProfile).where(ResumeProfile.user_id == user.id)
    ).all()
    jobs = db.scalars(select(Job).where(Job.user_id == user.id)).all()
    applications = db.scalars(
        select(Application).where(Application.user_id == user.id)
    ).all()
    usage = db.scalars(select(LlmUsage).where(LlmUsage.user_id == user.id)).all()

    document = {
        "exported_at": datetime.now(UTC).isoformat(),
        "account": {
            "id": str(user.id),
            "email": user.email,
            "full_name": user.full_name,
            "is_verified": user.is_verified,
            "theme": user.theme,
            "notification_prefs": user.notification_prefs,
            "created_at": user.created_at.isoformat(),
        },
        "resume_profiles": [
            {"id": str(r.id), "name": r.name, "content": r.content, "is_default": r.is_default}
            for r in resumes
        ],
        "jobs": [
            {"id": str(j.id), "title": j.title, "company": j.company, "url": j.url}
            for j in jobs
        ],
        "applications": [
            {
                "id": str(a.id),
                "pipeline_status": a.pipeline_status.value,
                "tracker_status": a.tracker_status.value,
                "tailored_resume": a.tailored_resume,
                "total_cost_usd": a.total_cost_usd,
                "created_at": a.created_at.isoformat(),
            }
            for a in applications
        ],
        "llm_usage": [
            {
                "purpose": u.purpose,
                "model": u.model,
                "input_tokens": u.input_tokens,
                "output_tokens": u.output_tokens,
                "cost_usd": u.cost_usd,
                "created_at": u.created_at.isoformat(),
            }
            for u in usage
        ],
    }
    filename = f"hirecraft-export-{user.id}.json"
    return JSONResponse(
        content=document,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("", response_model=MessageResponse)
def delete_account(user: CurrentUser, db: DbSession) -> MessageResponse:
    """Permanently delete the account and everything belonging to it."""
    user_id = user.id
    try:
        storage.delete_prefix(str(user_id))
    except storage.StorageError:
        logger.warning("account.artifact_cleanup_failed", user_id=str(user_id))

    # All child rows cascade via the ORM relationships / FK ondelete.
    db.delete(user)
    db.commit()
    logger.info("account.deleted", user_id=str(user_id))
    return MessageResponse(message="Your account and all its data have been deleted.")
