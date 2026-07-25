"""Job search — proxy a free public job board so users can find roles to tailor to."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.models.resume import ResumeProfile
from app.schemas.jobsearch import JobSearchResult
from app.schemas.resume import MasterResume
from app.services import feature_flags
from app.services.jobsearch import search_jobs
from app.services.matching import analyze_job_fit

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/search", response_model=list[JobSearchResult])
def job_search(
    user: CurrentUser,
    db: DbSession,
    q: str | None = Query(default=None, max_length=200),
    remote_only: bool = False,
    limit: int = Query(default=20, ge=1, le=50),
) -> list[JobSearchResult]:
    """Search recent public job postings, scored against the user's default
    résumé. Deep-links into tailoring; returns [] if the board is unavailable."""
    if not feature_flags.is_enabled(db, "job_search_enabled"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Job search is currently disabled."
        )
    results = search_jobs(q, remote_only=remote_only, limit=limit)

    # Score each against the default résumé (deterministic, no LLM).
    profile = db.scalar(
        select(ResumeProfile)
        .where(ResumeProfile.user_id == user.id)
        .order_by(ResumeProfile.is_default.desc(), ResumeProfile.updated_at.desc())
    )
    if profile is not None:
        try:
            resume = MasterResume.model_validate(profile.content)
            for r in results:
                fit = analyze_job_fit(
                    resume, f"{r.title} {r.company} {' '.join(r.tags)} {r.snippet}"
                )
                r.match_score = fit.score
                r.verdict = fit.verdict
                r.interview_chance = fit.interview_chance
                r.summary = fit.summary
                r.strengths = fit.strengths
                r.gaps = fit.gaps
        except Exception:  # noqa: BLE001 - a bad résumé shouldn't break search
            pass
    return results
