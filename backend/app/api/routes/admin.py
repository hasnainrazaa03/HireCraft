"""Admin panel — platform health and usage.

Gated on the existing is_superuser flag. Read-only aggregates: user counts,
generation usage/cost, and recent signups. Deliberately minimal — the numbers
that tell an operator whether the system is healthy and what it's costing.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, or_, select

from app.api.deps import AdminUser, DbSession
from app.core.logging import get_logger
from app.models.application import Application
from app.models.feature_flag import KNOWN_FLAGS
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.models.user import User
from app.schemas.api import ApiModel, MessageResponse
from app.services import feature_flags

logger = get_logger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


class AdminUserRow(ApiModel):
    email: str
    full_name: str | None
    is_verified: bool
    created_at: datetime
    applications: int


class AdminStats(ApiModel):
    total_users: int
    verified_users: int
    active_users_30d: int
    total_applications: int
    total_resumes: int
    total_cost_usd: float
    total_input_tokens: int
    total_output_tokens: int
    total_llm_calls: int
    cost_by_purpose: dict[str, float]
    recent_signups: list[AdminUserRow]


@router.get("/stats", response_model=AdminStats)
def admin_stats(admin: AdminUser, db: DbSession) -> AdminStats:
    since_30d = datetime.now(UTC) - timedelta(days=30)

    total_users = db.scalar(select(func.count(User.id))) or 0
    verified = db.scalar(select(func.count(User.id)).where(User.is_verified.is_(True))) or 0
    # "Active" = signed up in / used the app in the last 30 days (proxy: has a
    # recent LLM call or a recent application).
    active = db.scalar(
        select(func.count(func.distinct(LlmUsage.user_id))).where(
            LlmUsage.created_at >= since_30d
        )
    ) or 0

    total_apps = db.scalar(select(func.count(Application.id))) or 0
    total_resumes = db.scalar(select(func.count(ResumeProfile.id))) or 0

    usage = db.execute(
        select(
            func.coalesce(func.sum(LlmUsage.input_tokens), 0),
            func.coalesce(func.sum(LlmUsage.output_tokens), 0),
            func.coalesce(func.sum(LlmUsage.cost_usd), 0.0),
            func.count(LlmUsage.id),
        )
    ).one()

    by_purpose = db.execute(
        select(LlmUsage.purpose, func.sum(LlmUsage.cost_usd)).group_by(LlmUsage.purpose)
    ).all()

    signup_rows = db.execute(
        select(User, func.count(Application.id))
        .outerjoin(Application, Application.user_id == User.id)
        .group_by(User.id)
        .order_by(User.created_at.desc())
        .limit(10)
    ).all()

    return AdminStats(
        total_users=int(total_users),
        verified_users=int(verified),
        active_users_30d=int(active),
        total_applications=int(total_apps),
        total_resumes=int(total_resumes),
        total_cost_usd=round(float(usage[2] or 0.0), 6),
        total_input_tokens=int(usage[0] or 0),
        total_output_tokens=int(usage[1] or 0),
        total_llm_calls=int(usage[3] or 0),
        cost_by_purpose={
            str(p): round(float(c or 0.0), 6) for p, c in by_purpose
        },
        recent_signups=[
            AdminUserRow(
                email=str(u.email),
                full_name=u.full_name,
                is_verified=u.is_verified,
                created_at=u.created_at,
                applications=int(count),
            )
            for u, count in signup_rows
        ],
    )


# --- Feature flags ----------------------------------------------------------


class FeatureFlagRow(ApiModel):
    key: str
    enabled: bool
    description: str


class FeatureFlagUpdate(ApiModel):
    enabled: bool


@router.get("/flags", response_model=list[FeatureFlagRow])
def list_flags(admin: AdminUser, db: DbSession) -> list[FeatureFlagRow]:
    effective = feature_flags.effective_flags(db)
    return [
        FeatureFlagRow(key=key, enabled=effective[key], description=KNOWN_FLAGS[key][1])
        for key in KNOWN_FLAGS
    ]


@router.put("/flags/{key}", response_model=FeatureFlagRow)
def update_flag(
    key: str, payload: FeatureFlagUpdate, admin: AdminUser, db: DbSession
) -> FeatureFlagRow:
    try:
        feature_flags.set_flag(db, key, payload.enabled)
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown feature flag.") from exc
    db.commit()
    logger.info("admin.flag_set", key=key, enabled=payload.enabled)
    return FeatureFlagRow(key=key, enabled=payload.enabled, description=KNOWN_FLAGS[key][1])


# --- User management (abuse + billing) --------------------------------------


class AdminUserDetail(ApiModel):
    id: uuid.UUID
    email: str
    full_name: str | None
    is_active: bool
    is_verified: bool
    is_superuser: bool
    created_at: datetime
    applications: int
    total_cost_usd: float
    llm_calls: int


class AdminUserPage(ApiModel):
    users: list[AdminUserDetail]
    total: int


@router.get("/users", response_model=AdminUserPage)
def list_users(
    admin: AdminUser,
    db: DbSession,
    q: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> AdminUserPage:
    """Users with per-account usage + cost — the billing/abuse view."""
    base = select(User)
    if q:
        like = f"%{q.lower()}%"
        base = base.where(
            or_(func.lower(User.email).like(like), func.lower(User.full_name).like(like))
        )

    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    users = list(
        db.scalars(base.order_by(User.created_at.desc()).limit(limit).offset(offset))
    )

    # Aggregate cost + call counts per user in one pass.
    cost_rows = dict(
        db.execute(
            select(
                LlmUsage.user_id,
                func.coalesce(func.sum(LlmUsage.cost_usd), 0.0),
            ).group_by(LlmUsage.user_id)
        ).all()
    )
    call_rows = dict(
        db.execute(
            select(LlmUsage.user_id, func.count(LlmUsage.id)).group_by(LlmUsage.user_id)
        ).all()
    )
    app_rows = dict(
        db.execute(
            select(Application.user_id, func.count(Application.id)).group_by(Application.user_id)
        ).all()
    )

    return AdminUserPage(
        users=[
            AdminUserDetail(
                id=u.id,
                email=str(u.email),
                full_name=u.full_name,
                is_active=u.is_active,
                is_verified=u.is_verified,
                is_superuser=u.is_superuser,
                created_at=u.created_at,
                applications=int(app_rows.get(u.id, 0)),
                total_cost_usd=round(float(cost_rows.get(u.id, 0.0)), 6),
                llm_calls=int(call_rows.get(u.id, 0)),
            )
            for u in users
        ],
        total=int(total),
    )


def _get_target(db: DbSession, admin: User, user_id: uuid.UUID) -> User:
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    if target.id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You can't change your own account here.")
    if target.is_superuser:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Can't suspend another admin.")
    return target


@router.post("/users/{user_id}/suspend", response_model=MessageResponse)
def suspend_user(user_id: uuid.UUID, admin: AdminUser, db: DbSession) -> MessageResponse:
    """Disable an account — they can no longer log in or make requests (is_active
    is enforced on every request)."""
    target = _get_target(db, admin, user_id)
    target.is_active = False
    db.commit()
    logger.info("admin.user_suspended", user_id=str(user_id), by=str(admin.id))
    return MessageResponse(message=f"{target.email} has been suspended.")


@router.post("/users/{user_id}/reactivate", response_model=MessageResponse)
def reactivate_user(user_id: uuid.UUID, admin: AdminUser, db: DbSession) -> MessageResponse:
    target = _get_target(db, admin, user_id)
    target.is_active = True
    db.commit()
    logger.info("admin.user_reactivated", user_id=str(user_id), by=str(admin.id))
    return MessageResponse(message=f"{target.email} has been reactivated.")
