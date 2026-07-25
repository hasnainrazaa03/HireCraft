"""Job-search assistant + application-history analytics (deterministic).

`recommend_resume` scores every résumé the user has against one job's extracted
requirements and names the best fit, plus the weak areas to fix. `history_insights`
rolls up real outcomes per résumé so the user can see which one actually lands
interviews and reuse the content that's working.
"""

from __future__ import annotations

import uuid
from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.application import Application, TrackerStatus
from app.models.resume import ResumeProfile
from app.schemas.assistant import (
    HistoryInsights,
    ResumeOutcome,
    ResumeRanking,
    ResumeRecommendation,
)
from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.services.matching import match_resume_to_job

# Stages that count as "reached an interview" for outcome scoring.
_INTERVIEW_PLUS = {
    TrackerStatus.INTERVIEWING,
    TrackerStatus.TECHNICAL,
    TrackerStatus.BEHAVIORAL,
    TrackerStatus.FINAL,
    TrackerStatus.OFFER,
    TrackerStatus.ACCEPTED,
}
_OFFERS = {TrackerStatus.OFFER, TrackerStatus.ACCEPTED}
_PRE_SUBMIT = {
    TrackerStatus.WISHLIST,
    TrackerStatus.SAVED,
    TrackerStatus.PREPARING,
    TrackerStatus.DRAFT,
}


def recommend_resume(
    db: Session, user_id: uuid.UUID, requirements: JobRequirements,
    *, job_title: str | None = None, company: str | None = None,
) -> ResumeRecommendation:
    profiles = list(
        db.scalars(select(ResumeProfile).where(ResumeProfile.user_id == user_id))
    )
    rankings: list[ResumeRanking] = []
    best_gaps: list[str] = []
    best_missing: list[str] = []
    best_score = -1

    for profile in profiles:
        resume = MasterResume.model_validate(profile.content)
        match = match_resume_to_job(resume, requirements)
        rankings.append(
            ResumeRanking(
                resume_profile_id=profile.id,
                name=profile.name,
                match_score=match.overall_score,
                verdict=match.verdict,
            )
        )
        if match.overall_score > best_score:
            best_score = match.overall_score
            best_gaps = match.gaps
            best_missing = [h.name for h in match.missing_skills]

    rankings.sort(key=lambda r: -r.match_score)
    best_id = rankings[0].resume_profile_id if rankings else None
    return ResumeRecommendation(
        job_title=job_title or requirements.title,
        company=company or requirements.company,
        rankings=rankings,
        best_resume_id=best_id,
        weak_areas=best_gaps[:6],
        missing_skills=best_missing[:10],
    )


def history_insights(db: Session, user_id: uuid.UUID) -> HistoryInsights:
    profiles = {
        p.id: p
        for p in db.scalars(select(ResumeProfile).where(ResumeProfile.user_id == user_id))
    }
    apps = list(
        db.scalars(
            select(Application)
            .where(Application.user_id == user_id)
            .options(selectinload(Application.job))
        )
    )

    per_resume: dict[uuid.UUID, dict[str, int]] = {}
    winning_kw: Counter[str] = Counter()
    for app in apps:
        rid = app.resume_profile_id
        if rid not in profiles:
            continue
        stats = per_resume.setdefault(rid, {"applications": 0, "interviews": 0, "offers": 0, "submitted": 0})
        stats["applications"] += 1
        if app.tracker_status not in _PRE_SUBMIT:
            stats["submitted"] += 1
        if app.tracker_status in _INTERVIEW_PLUS:
            stats["interviews"] += 1
            report = app.guardrail_report or {}
            for kw in report.get("keywords_verified", []) or []:
                winning_kw[str(kw)] += 1
        if app.tracker_status in _OFFERS:
            stats["offers"] += 1

    outcomes: list[ResumeOutcome] = []
    for rid, stats in per_resume.items():
        submitted = stats["submitted"]
        outcomes.append(
            ResumeOutcome(
                resume_profile_id=rid,
                name=profiles[rid].name,
                applications=stats["applications"],
                interviews=stats["interviews"],
                offers=stats["offers"],
                response_rate=round(stats["interviews"] / submitted, 3) if submitted else 0.0,
            )
        )

    # Best = most interviews, then most applications as a tiebreak.
    outcomes.sort(key=lambda o: (o.interviews, o.applications), reverse=True)
    best_id = outcomes[0].resume_profile_id if outcomes and outcomes[0].interviews > 0 else None

    return HistoryInsights(
        resumes=outcomes,
        best_resume_id=best_id,
        total_applications=len(apps),
        winning_keywords=[k for k, _ in winning_kw.most_common(10)],
    )
