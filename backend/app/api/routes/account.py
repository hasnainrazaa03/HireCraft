"""Account management: settings, data export, and deletion."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.core.logging import get_logger
from app.models.application import Application
from app.models.job import Job
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.models.user import DEFAULT_NOTIFICATION_PREFS, User
from app.schemas.api import AccountSettingsUpdate, MessageResponse, UserResponse
from app.services import storage

router = APIRouter(prefix="/account", tags=["account"])
logger = get_logger(__name__)


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
