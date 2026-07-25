"""Cost tracking and pipeline analytics."""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession
from app.models.application import Application
from app.models.llm_usage import LlmUsage
from app.schemas.api import (
    AnalyticsOverview,
    ModelUsage,
    ProviderUsage,
    TrackerStats,
    UsagePoint,
    UsageSummary,
)
from app.services.dashboard import build_overview
from app.services.llm.models import provider_for_model

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/overview", response_model=AnalyticsOverview)
def analytics_overview(user: CurrentUser, db: DbSession) -> AnalyticsOverview:
    """The dashboard aggregate: funnel + rates, content stats, leaderboards,
    applications-over-time, and a recent-activity feed. All derived from the
    user's own data — no external calls, no LLM."""
    return build_overview(db, user.id)


@router.get("/usage", response_model=UsageSummary)
def usage_summary(
    user: CurrentUser,
    db: DbSession,
    days: int = Query(default=30, ge=1, le=365),
) -> UsageSummary:
    since = datetime.now(UTC) - timedelta(days=days)

    totals = db.execute(
        select(
            func.coalesce(func.sum(LlmUsage.input_tokens), 0),
            func.coalesce(func.sum(LlmUsage.output_tokens), 0),
            func.coalesce(func.sum(LlmUsage.cost_usd), 0.0),
            func.count(LlmUsage.id),
        ).where(LlmUsage.user_id == user.id, LlmUsage.created_at >= since)
    ).one()

    application_count = db.scalar(
        select(func.count(Application.id)).where(
            Application.user_id == user.id, Application.created_at >= since
        )
    ) or 0

    rows = db.execute(
        select(
            func.date(LlmUsage.created_at),
            func.sum(LlmUsage.input_tokens),
            func.sum(LlmUsage.output_tokens),
            func.sum(LlmUsage.cost_usd),
            func.count(LlmUsage.id),
        )
        .where(LlmUsage.user_id == user.id, LlmUsage.created_at >= since)
        .group_by(func.date(LlmUsage.created_at))
        .order_by(func.date(LlmUsage.created_at))
    ).all()

    by_purpose_rows = db.execute(
        select(LlmUsage.purpose, func.sum(LlmUsage.cost_usd))
        .where(LlmUsage.user_id == user.id, LlmUsage.created_at >= since)
        .group_by(LlmUsage.purpose)
    ).all()

    # Per-model usage; provider is derived from the model name.
    model_rows = db.execute(
        select(
            LlmUsage.model,
            func.sum(LlmUsage.input_tokens),
            func.sum(LlmUsage.output_tokens),
            func.sum(LlmUsage.cost_usd),
            func.count(LlmUsage.id),
        )
        .where(LlmUsage.user_id == user.id, LlmUsage.created_at >= since)
        .group_by(LlmUsage.model)
        .order_by(func.sum(LlmUsage.cost_usd).desc())
    ).all()

    by_model: list[ModelUsage] = []
    provider_agg: dict[str, dict[str, float]] = {}
    for model, in_tok, out_tok, cost, calls in model_rows:
        provider = provider_for_model(str(model))
        by_model.append(
            ModelUsage(
                model=str(model),
                provider=provider,
                input_tokens=int(in_tok or 0),
                output_tokens=int(out_tok or 0),
                cost_usd=round(float(cost or 0.0), 6),
                calls=int(calls or 0),
            )
        )
        agg = provider_agg.setdefault(
            provider, {"input": 0, "output": 0, "cost": 0.0, "calls": 0}
        )
        agg["input"] += int(in_tok or 0)
        agg["output"] += int(out_tok or 0)
        agg["cost"] += float(cost or 0.0)
        agg["calls"] += int(calls or 0)

    by_provider = sorted(
        (
            ProviderUsage(
                provider=p,
                input_tokens=int(a["input"]),
                output_tokens=int(a["output"]),
                cost_usd=round(a["cost"], 6),
                calls=int(a["calls"]),
            )
            for p, a in provider_agg.items()
        ),
        key=lambda x: -x.cost_usd,
    )

    total_cost = round(float(totals[2] or 0.0), 6)
    return UsageSummary(
        total_cost_usd=total_cost,
        total_input_tokens=int(totals[0] or 0),
        total_output_tokens=int(totals[1] or 0),
        total_calls=int(totals[3] or 0),
        applications=application_count,
        average_cost_per_application=(
            round(total_cost / application_count, 6) if application_count else 0.0
        ),
        by_day=[
            UsagePoint(
                date=str(row[0]),
                input_tokens=int(row[1] or 0),
                output_tokens=int(row[2] or 0),
                cost_usd=round(float(row[3] or 0.0), 6),
                calls=int(row[4] or 0),
            )
            for row in rows
        ],
        by_purpose={
            str(purpose): round(float(cost or 0.0), 6) for purpose, cost in by_purpose_rows
        },
        by_model=by_model,
        by_provider=by_provider,
    )


@router.get("/tracker", response_model=TrackerStats)
def tracker_stats(user: CurrentUser, db: DbSession) -> TrackerStats:
    rows = db.execute(
        select(Application.tracker_status, func.count(Application.id))
        .where(Application.user_id == user.id)
        .group_by(Application.tracker_status)
    ).all()

    counts: dict[str, int] = defaultdict(int)
    for tracker_status, count in rows:
        key = tracker_status.value if hasattr(tracker_status, "value") else str(tracker_status)
        counts[key] = int(count)

    return TrackerStats(counts=dict(counts), total=sum(counts.values()))
