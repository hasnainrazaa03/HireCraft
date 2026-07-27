"""Job search — proxy a free public job board so users can find roles to tailor to."""

from __future__ import annotations

import contextlib
import json

import redis
from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.core.logging import get_logger
from app.core.rate_limit import get_redis
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.schemas.jobsearch import JobSearchResult
from app.schemas.resume import MasterResume
from app.services import feature_flags
from app.services.job_rerank import rerank_jobs
from app.services.jobsearch import search_jobs
from app.services.llm.client import LlmConfigurationError, LlmError
from app.services.llm.factory import client_for_user
from app.services.matching import analyze_job_fit, default_search_query
from app.services.pipeline import UsageLedger

logger = get_logger(__name__)

router = APIRouter(prefix="/jobs", tags=["jobs"])

_RERANK_TTL = 3600  # 1h; keyed by résumé version + query, so repeat views are free.


def _verdict(score: int) -> str:
    return (
        "Excellent Match" if score >= 82
        else "Great Match" if score >= 68
        else "Good Match" if score >= 50
        else "Fair Match"
    )


def _chance(score: int) -> str:
    return "High" if score >= 70 else "Medium" if score >= 48 else "Low"


def _job_key(r: JobSearchResult) -> str:
    return r.url or f"{r.source}|{r.title}|{r.company}"


@router.get("/search", response_model=list[JobSearchResult])
def job_search(
    user: CurrentUser,
    db: DbSession,
    q: str | None = Query(default=None, max_length=200),
    remote_only: bool = False,
    limit: int = Query(default=20, ge=1, le=50),
) -> list[JobSearchResult]:
    """Search recent public job postings, scored against the user's default
    résumé. Deep-links into tailoring; returns [] if the board is unavailable.

    With no query, the feed is seeded from the résumé (role + skills) so it opens
    on relevant roles. Results are scored deterministically, then the top handful
    are re-ranked by the model for a sharper, semantic fit — cached per résumé
    version + query, and a no-op if the résumé or AI is unavailable."""
    if not feature_flags.is_enabled(db, "job_search_enabled"):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Job search is currently disabled."
        )

    profile = db.scalar(
        select(ResumeProfile)
        .where(ResumeProfile.user_id == user.id)
        .order_by(ResumeProfile.is_default.desc(), ResumeProfile.updated_at.desc())
    )
    resume: MasterResume | None = None
    if profile is not None:
        with contextlib.suppress(Exception):
            resume = MasterResume.model_validate(profile.content)

    # No query typed → recommend from the résumé instead of a generic list.
    effective_q = q
    if not (q or "").strip() and resume is not None:
        effective_q = default_search_query(resume) or None

    results = search_jobs(effective_q, remote_only=remote_only, limit=limit)

    if resume is not None and results:
        _score(resume, results)
        results.sort(key=lambda r: r.match_score or 0, reverse=True)
        _maybe_rerank(db, user, profile, resume, results, effective_q, remote_only)

    return results


def _score(resume: MasterResume, results: list[JobSearchResult]) -> None:
    """Deterministic, LLM-free fit score for every result."""
    for r in results:
        with contextlib.suppress(Exception):
            fit = analyze_job_fit(
                resume,
                f"{r.title} {r.company} {' '.join(r.tags)} {r.snippet}",
                title=r.title,
            )
            r.match_score = fit.score
            r.verdict = fit.verdict
            r.interview_chance = fit.interview_chance
            r.summary = fit.summary
            r.strengths = fit.strengths
            r.gaps = fit.gaps


def _maybe_rerank(
    db: DbSession,
    user: CurrentUser,
    profile: ResumeProfile,
    resume: MasterResume,
    results: list[JobSearchResult],
    query: str | None,
    remote_only: bool,
) -> None:
    """Refine the top-N scores with one cached LLM call; never fatal."""
    if len(results) < 3:
        return
    cache_key = (
        f"jobrerank:{profile.id}:{profile.updated_at.timestamp():.0f}:"
        f"{(query or '').lower()}:{int(remote_only)}"
    )
    cached = _rerank_cache_get(cache_key)
    if cached is not None:
        _apply_rerank(results, cached)
        return

    try:
        client = client_for_user(user)
    except LlmConfigurationError:
        return  # no key configured — deterministic scores stand.

    ledger = UsageLedger()
    try:
        ranked = rerank_jobs(resume, results, client=client, ledger=ledger)
    except LlmError as exc:
        logger.info("job_rerank.skipped", error=str(exc)[:200])
        return

    # index → {job_key: [score, reason]} so the cache survives a re-fetch whose
    # ordering differs slightly.
    by_key = {
        _job_key(results[i]): [score, reason]
        for i, (score, reason) in ranked.items()
    }
    _rerank_cache_set(cache_key, by_key)
    _apply_rerank(results, by_key)

    for purpose, usage in ledger.entries:
        db.add(LlmUsage(
            user_id=user.id, purpose=purpose, model=usage.model,
            input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
            cost_usd=usage.cost_usd, latency_ms=usage.latency_ms,
        ))
    db.commit()


def _apply_rerank(results: list[JobSearchResult], by_key: dict[str, list]) -> None:
    for r in results:
        hit = by_key.get(_job_key(r))
        if not hit:
            continue
        score, reason = int(hit[0]), (hit[1] or "").strip()
        r.match_score = score
        r.verdict = _verdict(score)
        r.interview_chance = _chance(score)
        if reason:
            r.summary = reason
    results.sort(key=lambda r: r.match_score or 0, reverse=True)


def _rerank_cache_get(key: str) -> dict | None:
    with contextlib.suppress(redis.RedisError, ValueError):
        cached = get_redis().get(key)
        if cached:
            return json.loads(cached)
    return None


def _rerank_cache_set(key: str, data: dict) -> None:
    with contextlib.suppress(redis.RedisError, TypeError):
        get_redis().setex(key, _RERANK_TTL, json.dumps(data))
