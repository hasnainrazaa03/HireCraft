"""Career insights: deterministic job-match scoring and skill-gap analysis.

No LLM — these read the résumé and the jobs' already-extracted requirements and
compute explainable scores, so they're instant and free to call.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession
from app.models.application import Application
from app.models.resume import ResumeProfile
from app.schemas.assistant import HistoryInsights, ResumeRecommendation
from app.schemas.job import JobRequirements
from app.schemas.matching import JobMatch, SkillGapReport
from app.schemas.resume import MasterResume
from app.services.assistant import history_insights, recommend_resume
from app.services.matching import match_resume_to_job, skill_gaps

router = APIRouter(prefix="/insights", tags=["insights"])


def _pick_resume(db: DbSession, user_id: uuid.UUID, resume_id: uuid.UUID | None) -> ResumeProfile:
    if resume_id is not None:
        profile = db.get(ResumeProfile, resume_id)
        if profile is None or profile.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Résumé not found.")
        return profile
    # Default résumé, else the most recently updated one.
    profile = db.scalar(
        select(ResumeProfile)
        .where(ResumeProfile.user_id == user_id)
        .order_by(ResumeProfile.is_default.desc(), ResumeProfile.updated_at.desc())
    )
    if profile is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Add a résumé first.")
    return profile


@router.get("/applications/{application_id}/match", response_model=JobMatch)
def application_match(
    application_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> JobMatch:
    """How well this application's résumé fits its job — with the reasons why."""
    application = db.scalar(
        select(Application)
        .where(Application.id == application_id, Application.user_id == user.id)
        .options(selectinload(Application.job), selectinload(Application.resume_profile))
    )
    if application is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Application not found.")
    if not application.job or not application.job.requirements:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This job hasn't been analysed yet — run the tailoring pipeline first.",
        )
    resume = MasterResume.model_validate(application.resume_profile.content)
    requirements = JobRequirements.model_validate(application.job.requirements)
    return match_resume_to_job(resume, requirements)


@router.get("/skill-gaps", response_model=SkillGapReport)
def skill_gap_report(
    user: CurrentUser,
    db: DbSession,
    resume_id: uuid.UUID | None = Query(default=None),
) -> SkillGapReport:
    """Across every job you've saved, which skills are most in demand — and which
    of those your résumé is missing. Uses your default résumé unless one is named."""
    profile = _pick_resume(db, user.id, resume_id)
    resume = MasterResume.model_validate(profile.content)

    applications = db.scalars(
        select(Application)
        .where(Application.user_id == user.id)
        .options(selectinload(Application.job))
    ).all()
    requirement_sets: list[JobRequirements] = []
    for app in applications:
        if app.job and app.job.requirements:
            try:
                requirement_sets.append(JobRequirements.model_validate(app.job.requirements))
            except Exception:  # noqa: BLE001 - a malformed record shouldn't break the report
                continue

    return skill_gaps(resume, requirement_sets)


@router.get("/applications/{application_id}/recommend", response_model=ResumeRecommendation)
def recommend_for_application(
    application_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> ResumeRecommendation:
    """Rank every résumé the user has against this job and name the best fit."""
    application = db.scalar(
        select(Application)
        .where(Application.id == application_id, Application.user_id == user.id)
        .options(selectinload(Application.job))
    )
    if application is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Application not found.")
    if not application.job or not application.job.requirements:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This job hasn't been analysed yet — run the tailoring pipeline first.",
        )
    requirements = JobRequirements.model_validate(application.job.requirements)
    return recommend_resume(
        db, user.id, requirements,
        job_title=application.job.title, company=application.job.company,
    )


@router.get("/history", response_model=HistoryInsights)
def application_history_insights(user: CurrentUser, db: DbSession) -> HistoryInsights:
    """Per-résumé outcomes: which résumé actually lands interviews, and the
    keywords the winning applications covered."""
    return history_insights(db, user.id)
