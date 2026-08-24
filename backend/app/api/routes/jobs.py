"""Job search — proxy a free public job board so users can find roles to tailor to."""

from __future__ import annotations

import contextlib
import json
import re
import uuid

import redis
from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.core.logging import get_logger
from app.core.rate_limit import get_redis
from app.models.llm_usage import LlmUsage
from app.models.profile import CareerProfile
from app.models.resume import ResumeProfile
from app.models.scraped_job import ScrapedJob
from app.schemas.jobsearch import JobSearchResult
from app.schemas.resume import MasterResume
from app.services import feature_flags
from app.services.job_rerank import rerank_jobs
from app.services.jobsearch import search_jobs
from app.services.scraper import ScrapeError, scrape_job
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
    exclude: str | None = Query(default=None, max_length=200, description="Comma-separated title keywords to drop"),
    must_have: str | None = Query(default=None, max_length=200, description="Comma-separated terms a posting must contain"),
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

    # No query typed → recommend from the candidate's own targets, not a generic list.
    effective_q = q
    recommending = not (q or "").strip()
    if recommending:
        effective_q = _recommend_query(db, user.id, resume, remote_only)

    exclude_terms = [t for t in (exclude or "").split(",") if t.strip()]
    must_terms = [t for t in (must_have or "").split(",") if t.strip()]
    results = search_jobs(
        effective_q, remote_only=remote_only,
        exclude=exclude_terms, must_have=must_terms, limit=limit,
    )
    # A seed can still be too specific for the boards to match; never strand the
    # recommended feed on an empty state — broaden to the recent pool and let the
    # fit-ranking below surface the relevant roles.
    if recommending and len(results) < 5:
        effective_q = None
        results = search_jobs(
            None, remote_only=remote_only,
            exclude=exclude_terms, must_have=must_terms, limit=limit,
        )

    if resume is not None and results:
        precise = _score(resume, results)
        results.sort(key=lambda r: r.match_score or 0, reverse=True)
        _maybe_rerank(db, user, profile, resume, results, precise, effective_q, remote_only)

    return results


def _recommend_query(
    db: DbSession, user_id: uuid.UUID, resume: MasterResume | None, remote_only: bool
) -> str | None:
    """Seed the no-query feed with the roles the candidate is actually targeting.

    Career-profile ``preferred_roles`` come first (what they *want* next), then
    the résumé's positioning. Pick the first that the boards actually return
    postings for, so the feed opens on relevant, populated results rather than a
    role the sources happen not to carry."""
    candidates: list[str] = []
    cp = db.scalar(select(CareerProfile).where(CareerProfile.user_id == user_id))
    if cp and cp.preferred_roles:
        candidates.extend(r for r in cp.preferred_roles if r and r.strip())
    if resume is not None:
        dq = default_search_query(resume)
        if dq:
            candidates.append(dq)
    for cand in candidates:
        # Sources are cached, so these probes are cheap re-filters, not refetches.
        if search_jobs(cand, remote_only=remote_only, limit=1):
            return cand
    return candidates[0] if candidates else None


def _score(resume: MasterResume, results: list[JobSearchResult]) -> dict[str, float]:
    """Deterministic, LLM-free fit score for every result.

    Returns the *unrounded* deterministic score per job so the LLM re-rank can
    blend on top of a fine-grained base instead of a whole number."""
    precise: dict[str, float] = {}
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
            precise[_job_key(r)] = fit.score_precise
    return precise


# How much the model's semantic judgment counts vs. the deterministic factors in
# the final blended score. The deterministic component is a float, which is what
# keeps the result off whole-number multiples.
_LLM_WEIGHT = 0.55


def _maybe_rerank(
    db: DbSession,
    user: CurrentUser,
    profile: ResumeProfile,
    resume: MasterResume,
    results: list[JobSearchResult],
    precise: dict[str, float],
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
        _apply_rerank(results, cached, precise)
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
    _apply_rerank(results, by_key, precise)

    for purpose, usage in ledger.entries:
        db.add(LlmUsage(
            user_id=user.id, purpose=purpose, model=usage.model,
            input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
            cost_usd=usage.cost_usd, latency_ms=usage.latency_ms,
        ))
    db.commit()


def _apply_rerank(
    results: list[JobSearchResult],
    by_key: dict[str, list],
    precise: dict[str, float],
) -> None:
    """Blend the model's semantic score with the deterministic factor score.

    The final number weighs the LLM's holistic judgment against the deterministic
    breakdown (title/skills/text/seniority), keeping the model's reason. Blending
    a float base is also what makes the score granular instead of the model's
    habitual multiples of five."""
    for r in results:
        hit = by_key.get(_job_key(r))
        if not hit:
            continue
        llm_score, reason = float(hit[0]), (hit[1] or "").strip()
        base = precise.get(_job_key(r), float(r.match_score or llm_score))
        blended = _LLM_WEIGHT * llm_score + (1 - _LLM_WEIGHT) * base
        score = max(1, min(99, round(blended)))
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


def _feed_row_to_result(
    row: ScrapedJob, fit: dict | None = None, *, full: bool = False
) -> JobSearchResult:
    """Render a stored feed posting in the same shape the job cards already use,
    plus the scraper's extras (level, term bucket, sponsorship, track pick).

    ``full`` carries the entire description as well, for the detail panel. It is
    off for list responses: a page of 120 postings would otherwise ship megabytes
    of text to render a 400-character preview on each card.
    """
    tags = [t for t in (row.terms or []) if t]
    if row.level and row.level != "unknown":
        tags.append(row.level.replace("_", " "))
    return JobSearchResult(
        id=str(row.id),
        title=row.title,
        company=row.company,
        location=row.location or "",
        url=row.url,
        remote=bool(row.remote),
        tags=tags[:8],
        snippet=(row.description or "")[:400],
        description=(row.description or "") if full else "",
        source=row.source,
        created_at=int(row.posted_at.timestamp()) if row.posted_at else None,
        match_score=fit["score"] if fit else None,
        verdict=fit["verdict"] if fit else None,
        interview_chance=fit["interview_chance"] if fit else None,
        summary=(fit["summary"] if fit else None) or None,
        strengths=list((fit["strengths"] if fit else []) or []),
        gaps=list((fit["gaps"] if fit else []) or []),
        level=row.level,
        bucket=row.bucket or None,
        terms=list(row.terms or []),
        sponsorship=row.sponsorship or "",
        track=row.track or None,
        track_resume=row.track_resume or None,
        track_score=row.track_score,
        status=row.status,
        active=row.active,
    )


# Re-scoring the whole feed costs ~1.3 ms a posting — fine for a filtered page,
# but ~3 s for all of them, so results are cached per (résumé, posting).
_FIT_TTL = 60 * 30


def _fit_cached(resume_id: str, row: ScrapedJob, resume: MasterResume):
    """Fit analysis for one posting against one résumé, memoised in Redis."""
    key = f"jobfit:{resume_id}:{row.fingerprint}"
    cached = _cache_get_json(key)
    if cached:
        return cached
    fit = analyze_job_fit(resume, f"{row.title}\n{row.description}", title=row.title)
    payload = {
        "score": fit.score,
        "verdict": fit.verdict,
        "interview_chance": fit.interview_chance,
        "summary": fit.summary,
        "strengths": list(fit.strengths or [])[:12],
        "gaps": list(fit.gaps or [])[:12],
    }
    _cache_set_json(key, payload, _FIT_TTL)
    return payload


def _cache_get_json(key: str):
    import contextlib as _c

    import redis as _redis

    with _c.suppress(_redis.RedisError, ValueError):
        raw = get_redis().get(key)
        if raw:
            return json.loads(raw)
    return None


def _cache_set_json(key: str, data: dict, ttl: int) -> None:
    import contextlib as _c

    import redis as _redis

    with _c.suppress(_redis.RedisError, TypeError):
        get_redis().setex(key, ttl, json.dumps(data))


@router.get("/feed", response_model=list[JobSearchResult])
def job_feed(
    user: CurrentUser,
    db: DbSession,
    resume_id: uuid.UUID | None = Query(default=None, description="Score against this résumé"),
    q: str | None = Query(default=None, description="Match title, company, or location"),
    level: str | None = None,
    bucket: str | None = None,
    source: str | None = None,
    location: str | None = None,
    remote_only: bool = False,
    status_filter: str | None = Query(default=None, alias="status"),
    include_closed: bool = False,
    min_score: int = Query(default=0, ge=0, le=100),
    sort: str = Query(default="match", pattern="^(match|newest|company)$"),
    limit: int = Query(default=60, ge=1, le=300),
) -> list[JobSearchResult]:
    """The scheduled scraper's accumulated postings for this user.

    Unlike ``/jobs/search`` (live boards, nothing stored), these are persisted by
    the every-6-hours scrape, so the feed fills up over time.

    ``resume_id`` re-scores every result against that résumé instead of using the
    score stored at scrape time — which was computed against whichever résumé was
    default *then*, and goes stale as soon as the user adds or edits one.
    """
    stmt = select(ScrapedJob).where(ScrapedJob.user_id == user.id)
    if not include_closed:
        stmt = stmt.where(ScrapedJob.active.is_(True))
    if bucket:
        stmt = stmt.where(ScrapedJob.bucket == bucket)
    if level:
        stmt = stmt.where(ScrapedJob.level == level)
    if source:
        stmt = stmt.where(ScrapedJob.source == source)
    if status_filter:
        stmt = stmt.where(ScrapedJob.status == status_filter)
    if remote_only:
        stmt = stmt.where(ScrapedJob.remote.is_(True))
    if location:
        stmt = stmt.where(ScrapedJob.location.ilike(f"%{location}%"))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            ScrapedJob.title.ilike(like)
            | ScrapedJob.company.ilike(like)
            | ScrapedJob.location.ilike(like)
        )

    rows = db.execute(stmt).scalars().all()

    # Fall back to the user's default résumé rather than showing no score: fit is
    # only computed here (nothing is stored at scrape time), so without this an
    # unparameterised request would return unscored cards.
    profile = None
    if resume_id is not None:
        profile = db.get(ResumeProfile, resume_id)
        if profile is None or profile.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Résumé not found.")
    else:
        profile = db.execute(
            select(ResumeProfile)
            .where(ResumeProfile.user_id == user.id)
            .order_by(ResumeProfile.is_default.desc(), ResumeProfile.updated_at.desc())
        ).scalars().first()
    resume = MasterResume.model_validate(profile.content) if profile else None
    scoring_key = str(profile.id) if profile else None

    results: list[JobSearchResult] = []
    for row in rows:
        fit = _fit_cached(scoring_key, row, resume) if resume else None
        score = fit["score"] if fit else None
        if min_score and (score or 0) < min_score:
            continue
        results.append(_feed_row_to_result(row, fit))

    if sort == "newest":
        results.sort(key=lambda r: r.created_at or 0, reverse=True)
    elif sort == "company":
        results.sort(key=lambda r: (r.company or "").lower())
    else:
        results.sort(key=lambda r: (r.match_score or 0), reverse=True)
    return results[:limit]


@router.get("/feed/stats", response_model=dict)
def job_feed_stats(user: CurrentUser, db: DbSession) -> dict:
    """Counts for the feed header: how many postings, how fresh, per bucket."""
    rows = db.execute(
        select(ScrapedJob).where(ScrapedJob.user_id == user.id)
    ).scalars().all()
    active = [r for r in rows if r.active]
    buckets: dict[str, int] = {}
    sources: dict[str, int] = {}
    levels: dict[str, int] = {}
    locations: dict[str, int] = {}
    remote = 0
    for r in active:
        buckets[r.bucket or "Unspecified"] = buckets.get(r.bucket or "Unspecified", 0) + 1
        sources[r.source] = sources.get(r.source, 0) + 1
        levels[r.level or "unknown"] = levels.get(r.level or "unknown", 0) + 1
        if r.remote:
            remote += 1
        # Postings list several sites separated by ; or •; count each city once so
        # the filter offers real places rather than whole location strings.
        for part in re.split(r"[;•|]", r.location or ""):
            city = part.strip()
            if city:
                locations[city] = locations.get(city, 0) + 1
    last = max((r.last_seen for r in rows if r.last_seen), default=None)
    return {
        "total": len(rows),
        "active": len(active),
        "new": sum(1 for r in active if r.status == "new"),
        "closed": len(rows) - len(active),
        "by_bucket": dict(sorted(buckets.items(), key=lambda kv: -kv[1])),
        "by_source": dict(sorted(sources.items(), key=lambda kv: -kv[1])),
        "by_level": dict(sorted(levels.items(), key=lambda kv: -kv[1])),
        "remote": remote,
        # Top places only — the tail is a long list of one-off office addresses.
        "by_location": dict(sorted(locations.items(), key=lambda kv: -kv[1])[:20]),
        "last_run": last.isoformat() if last else None,
    }


@router.post("/feed/{job_id}/fetch", response_model=JobSearchResult)
def fetch_feed_description(
    job_id: uuid.UUID,
    user: CurrentUser,
    db: DbSession,
    resume_id: uuid.UUID | None = None,
) -> JobSearchResult:
    """Pull the full posting for a feed row that arrived without one.

    The aggregator lists (most of the feed) carry title/company/location and a
    link, but no body — so the card has nothing to show and nothing to score
    against. They do carry the ATS URL, and those are the boards the scraper
    already reads natively, so the description can be fetched on demand and kept.
    """
    row = db.get(ScrapedJob, job_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found.")

    if len(row.description or "") < 200 and row.url:
        try:
            scraped = scrape_job(row.url)
        except ScrapeError as exc:
            # A dead or JS-only posting isn't an error the user can fix; return
            # the card unchanged rather than failing the whole modal.
            logger.info("jobfeed.fetch_failed", url=row.url[:120], error=str(exc)[:160])
            scraped = None
        if scraped is not None and scraped.text:
            row.description = scraped.text[:20000]
            row.location = row.location or (scraped.location or "")
            db.commit()
            db.refresh(row)
            # The stored fit for this posting was computed from an empty body.
            with contextlib.suppress(Exception):
                for key in get_redis().scan_iter(f"jobfit:*:{row.fingerprint}"):
                    get_redis().delete(key)

    profile = None
    if resume_id is not None:
        profile = db.get(ResumeProfile, resume_id)
        if profile is not None and profile.user_id != user.id:
            profile = None
    if profile is None:
        profile = db.execute(
            select(ResumeProfile)
            .where(ResumeProfile.user_id == user.id)
            .order_by(ResumeProfile.is_default.desc(), ResumeProfile.updated_at.desc())
        ).scalars().first()
    fit = None
    if profile is not None:
        fit = _fit_cached(str(profile.id), row, MasterResume.model_validate(profile.content))
    # The detail panel renders the whole posting, not the card's preview.
    return _feed_row_to_result(row, fit, full=True)


@router.patch("/feed/{job_id}", response_model=JobSearchResult)
def update_feed_job(
    job_id: uuid.UUID,
    payload: dict,
    user: CurrentUser,
    db: DbSession,
) -> JobSearchResult:
    """Triage a feed posting: new | seen | saved | applied | dismissed."""
    row = db.get(ScrapedJob, job_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found.")
    new_status = str(payload.get("status") or "").strip()
    if new_status not in {"new", "seen", "saved", "applied", "dismissed"}:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown status.")
    row.status = new_status
    db.commit()
    db.refresh(row)
    return _feed_row_to_result(row)
