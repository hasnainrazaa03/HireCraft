"""Dashboard analytics aggregation.

Turns the raw application / résumé / artifact tables into the funnel, rates,
leaderboards, and activity feed the dashboard renders. Kept out of the route so
it can be unit-tested against an in-memory database without the HTTP layer.

Everything here is derived from data the user's own actions already produced —
no external calls, no LLM. The one modelling caveat is the tracker: it stores a
single current stage, not history, so "interviewing" and "offers" mean *reached
that stage or beyond*, and a closed application tells us nothing about how far
it got. The rate definitions below are chosen to stay honest under that limit.
"""

from __future__ import annotations

import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.application import (
    Application,
    ApplicationArtifact,
    ArtifactKind,
    PipelineStatus,
    TrackerStatus,
)
from app.models.job import Job
from app.models.resume import ResumeProfile, ResumeVersion
from app.schemas.analysis import ResumeAnalysis
from app.schemas.api import (
    ActivityItem,
    AnalyticsOverview,
    ContentStats,
    FunnelStats,
    NamedCount,
    TimePoint,
)
from app.schemas.resume import MasterResume
from app.services.analysis import analyze_resume

_ACTIVE_PIPELINE = {
    PipelineStatus.PENDING,
    PipelineStatus.SCRAPING,
    PipelineStatus.EXTRACTING,
    PipelineStatus.OPTIMIZING,
    PipelineStatus.RENDERING,
}
# Stages that precede actually submitting an application.
_PRE_SUBMIT = {
    TrackerStatus.WISHLIST,
    TrackerStatus.SAVED,
    TrackerStatus.PREPARING,
    TrackerStatus.DRAFT,
}
_CLOSED = {
    TrackerStatus.REJECTED,
    TrackerStatus.GHOSTED,
    TrackerStatus.WITHDRAWN,
    TrackerStatus.ARCHIVED,
}
# Reached the interview stage or beyond.
_INTERVIEW_PLUS = {
    TrackerStatus.INTERVIEWING,
    TrackerStatus.TECHNICAL,
    TrackerStatus.BEHAVIORAL,
    TrackerStatus.FINAL,
    TrackerStatus.OFFER,
    TrackerStatus.ACCEPTED,
}
_OFFERS = {TrackerStatus.OFFER, TrackerStatus.ACCEPTED}
# A response is any signal back from the employer — a rejection counts, a
# ghosting explicitly does not.
_RESPONDED = {
    TrackerStatus.ASSESSMENT,
    TrackerStatus.SCREENING,
    TrackerStatus.REJECTED,
    *_INTERVIEW_PLUS,
}


def _rate(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def build_overview(
    db: Session, user_id: uuid.UUID, *, days: int = 90, top_n: int = 8
) -> AnalyticsOverview:
    apps = list(
        db.execute(
            select(Application, Job)
            .join(Job, Application.job_id == Job.id, isouter=True)
            .where(Application.user_id == user_id)
            .order_by(Application.created_at.desc())
        ).all()
    )

    funnel = _funnel(apps)
    content = _content_stats(db, user_id, apps)
    over_time = _applications_over_time(apps, days=days)
    top_companies, top_titles = _company_and_title_leaders(apps, top_n=top_n)
    top_keywords = _keyword_leaders(apps, top_n=top_n)
    best_resume = _best_resume(db, apps)
    activity = _activity(db, user_id, apps)

    return AnalyticsOverview(
        funnel=funnel,
        content=content,
        applications_over_time=over_time,
        top_companies=top_companies,
        top_titles=top_titles,
        top_keywords=top_keywords,
        best_resume=best_resume,
        activity=activity,
    )


def _funnel(apps: list) -> FunnelStats:
    total = len(apps)
    submitted = 0
    active = 0
    applied = 0
    interviewing = 0
    offers = 0
    closed = 0
    responded = 0

    for app, _job in apps:
        if app.pipeline_status in _ACTIVE_PIPELINE:
            active += 1
        status = app.tracker_status
        if status not in _PRE_SUBMIT:
            submitted += 1
        if status == TrackerStatus.APPLIED:
            applied += 1
        if status in _INTERVIEW_PLUS:
            interviewing += 1
        if status in _OFFERS:
            offers += 1
        if status in _CLOSED:
            closed += 1
        if status in _RESPONDED:
            responded += 1

    return FunnelStats(
        total=total,
        submitted=submitted,
        active=active,
        applied=applied,
        interviewing=interviewing,
        offers=offers,
        closed=closed,
        response_rate=_rate(responded, submitted),
        interview_rate=_rate(interviewing, submitted),
        offer_rate=_rate(offers, submitted),
    )


def _content_stats(db: Session, user_id: uuid.UUID, apps: list) -> ContentStats:
    resume_count = (
        db.scalar(
            select(func.count(ResumeProfile.id)).where(
                ResumeProfile.user_id == user_id
            )
        )
        or 0
    )
    resume_versions = (
        db.scalar(
            select(func.count(ResumeVersion.id))
            .join(ResumeProfile, ResumeVersion.resume_profile_id == ResumeProfile.id)
            .where(ResumeProfile.user_id == user_id)
        )
        or 0
    )
    tailored = sum(1 for app, _ in apps if app.tailored_resume)
    cover_letters = (
        db.scalar(
            select(func.count(ApplicationArtifact.id))
            .join(Application, ApplicationArtifact.application_id == Application.id)
            .where(
                Application.user_id == user_id,
                ApplicationArtifact.kind == ArtifactKind.COVER_LETTER_PDF,
            )
        )
        or 0
    )

    # Average résumé quality across the user's saved résumés. Deterministic and
    # cheap (no LLM), so it's honest to compute live rather than store.
    scores: list[int] = []
    profiles = db.scalars(
        select(ResumeProfile).where(ResumeProfile.user_id == user_id)
    ).all()
    for profile in profiles:
        try:
            analysis: ResumeAnalysis = analyze_resume(
                MasterResume.model_validate(profile.content)
            )
            scores.append(analysis.overall_score)
        except Exception:  # noqa: BLE001 - a malformed draft shouldn't break the dashboard
            continue
    avg_score = round(sum(scores) / len(scores)) if scores else None

    return ContentStats(
        resume_count=int(resume_count),
        resume_versions=int(resume_versions),
        tailored_resumes=tailored,
        cover_letters=int(cover_letters),
        avg_resume_score=avg_score,
    )


def _applications_over_time(apps: list, *, days: int) -> list[TimePoint]:
    since = datetime.now(UTC) - timedelta(days=days)
    counts: Counter[str] = Counter()
    for app, _job in apps:
        created = app.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
        if created < since:
            continue
        counts[created.date().isoformat()] += 1
    return [TimePoint(date=day, count=counts[day]) for day in sorted(counts)]


def _company_and_title_leaders(
    apps: list, *, top_n: int
) -> tuple[list[NamedCount], list[NamedCount]]:
    companies: Counter[str] = Counter()
    titles: Counter[str] = Counter()
    for _app, job in apps:
        if job is None:
            continue
        if job.company:
            companies[job.company.strip()] += 1
        if job.title:
            titles[job.title.strip()] += 1
    return (
        [NamedCount(name=n, count=c) for n, c in companies.most_common(top_n)],
        [NamedCount(name=n, count=c) for n, c in titles.most_common(top_n)],
    )


def _keyword_leaders(apps: list, *, top_n: int) -> list[NamedCount]:
    """The ATS keywords the user has genuinely covered, across all tailorings.

    Uses ``keywords_verified`` — the ones the guardrail confirmed are actually
    in the résumé — not what any model claimed.
    """
    keywords: Counter[str] = Counter()
    for app, _job in apps:
        report = app.guardrail_report or {}
        for keyword in report.get("keywords_verified", []) or []:
            keywords[str(keyword)] += 1
    return [NamedCount(name=n, count=c) for n, c in keywords.most_common(top_n)]


def _best_resume(db: Session, apps: list) -> NamedCount | None:
    """The résumé that has produced the most interviews (or, failing any, the
    most applications). Rewards the résumé actually landing conversations."""
    interviews: Counter[uuid.UUID] = Counter()
    usage: Counter[uuid.UUID] = Counter()
    for app, _job in apps:
        if app.resume_profile_id is None:
            continue
        usage[app.resume_profile_id] += 1
        if app.tracker_status in _INTERVIEW_PLUS:
            interviews[app.resume_profile_id] += 1

    ranking = interviews if interviews else usage
    if not ranking:
        return None
    profile_id, count = ranking.most_common(1)[0]
    profile = db.get(ResumeProfile, profile_id)
    if profile is None:
        return None
    return NamedCount(name=profile.name, count=count)


def _activity(db: Session, user_id: uuid.UUID, apps: list) -> list[ActivityItem]:
    """A recent-activity feed synthesised from real timestamps.

    We have no dedicated events log, so the feed is derived from the durable
    facts we do store: applications created/completed, offers, and résumé
    versions saved. Everything shown actually happened.
    """
    items: list[ActivityItem] = []

    for app, job in apps[:25]:
        label = job.title if job and job.title else "Application"
        subtitle = job.company if job and job.company else None
        items.append(
            ActivityItem(
                kind="application",
                title=f"Started tailoring for {label}",
                subtitle=subtitle,
                at=_aware(app.created_at),
                ref=str(app.id),
            )
        )
        if app.tracker_status in _OFFERS:
            items.append(
                ActivityItem(
                    kind="offer",
                    title=f"Offer — {label}",
                    subtitle=subtitle,
                    at=_aware(app.updated_at),
                    ref=str(app.id),
                )
            )
        elif app.pipeline_status == PipelineStatus.COMPLETED:
            items.append(
                ActivityItem(
                    kind="completed",
                    title=f"Tailored résumé ready — {label}",
                    subtitle=subtitle,
                    at=_aware(app.updated_at),
                    ref=str(app.id),
                )
            )

    version_rows = db.execute(
        select(ResumeVersion, ResumeProfile.name)
        .join(ResumeProfile, ResumeVersion.resume_profile_id == ResumeProfile.id)
        .where(ResumeProfile.user_id == user_id)
        .order_by(ResumeVersion.created_at.desc())
        .limit(15)
    ).all()
    for version, name in version_rows:
        items.append(
            ActivityItem(
                kind="resume_version",
                title=f"Saved {name} v{version.version}",
                subtitle=version.label,
                at=_aware(version.created_at),
                ref=str(version.resume_profile_id),
            )
        )

    items.sort(key=lambda i: i.at, reverse=True)
    return items[:12]


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value
