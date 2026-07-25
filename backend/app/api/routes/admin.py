"""Admin panel — platform health and usage.

Gated on the existing is_superuser flag. Read-only aggregates: user counts,
generation usage/cost, and recent signups. Deliberately minimal — the numbers
that tell an operator whether the system is healthy and what it's costing.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.deps import AdminUser, DbSession
from app.models.application import Application
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.models.user import User
from app.schemas.api import ApiModel

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
