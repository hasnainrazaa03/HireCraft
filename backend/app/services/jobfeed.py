"""Scheduled job-feed scraper: run the vendored pipeline, persist what survives.

Mirrors the standalone tool's `run` command — collect → dedupe → filter → score —
then upserts into ``scraped_jobs`` instead of writing SQLite/Excel. Postings that
stop appearing are marked inactive rather than deleted, so a role the user was
looking at doesn't disappear mid-decision.

Each posting also gets HireCraft's own deterministic résumé match, so the feed
shows one number that agrees with the rest of the app alongside the scraper's
track recommendation ("send MHR_ML").
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from app.core.logging import get_logger
from app.models.scraped_job import ScrapedJob
from app.schemas.resume import MasterResume
from app.services.jobscraper.filters import SENIOR_RE, Filters
from app.services.jobscraper.models import Job
from app.services.jobscraper.scorer import Scorer
from app.services.jobscraper.sources import collect, dedupe
from app.services.matching import analyze_job_fit

logger = get_logger(__name__)


def _clip(value: str | None, limit: int) -> str:
    """Fit a scraped string into its column. Boards are inconsistent — a Workday
    posting can carry a multi-location string well past 500 characters — and a
    single long value must not fail the whole run's insert."""
    return (value or "")[:limit]


_CONFIG_DIR = Path(__file__).parent / "jobscraper"


def load_config() -> tuple[dict[str, Any], dict[str, Any]]:
    """The scraper's profile (what roles/terms/levels to keep) and company list."""
    profile = yaml.safe_load((_CONFIG_DIR / "profile.yaml").read_text()) or {}
    companies = yaml.safe_load((_CONFIG_DIR / "companies.yaml").read_text()) or {}
    return profile, companies


def scrape(
    *,
    sources: list[str] | None = None,
    workers: int = 8,
    profile: dict[str, Any] | None = None,
    companies: dict[str, Any] | None = None,
) -> tuple[list[Job], dict[str, Any]]:
    """Fetch → dedupe → filter → score. Returns the surviving jobs and run stats.

    No LLM and no API keys: every source is a public JSON endpoint.
    """
    if profile is None or companies is None:
        loaded_profile, loaded_companies = load_config()
        profile = profile or loaded_profile
        companies = companies or loaded_companies

    filt, scorer = Filters(profile), Scorer(profile)
    only = set(sources) if sources else None

    def want(title: str) -> bool:
        # Cheap pre-filter applied inside the fetchers, so obviously-wrong titles
        # never get their full description downloaded.
        return filt.role_ok(Job("", "", title, "")) and not SENIOR_RE.search(f" {title} ")

    raw, stats = collect(companies, only, want, workers=workers)
    jobs = dedupe(raw)

    kept: list[Job] = []
    drops: dict[str, int] = {}
    for job in jobs:
        filt.apply(job)
        if job.dropped:
            reason = job.dropped.split(":")[0]
            drops[reason] = drops.get(reason, 0) + 1
            continue
        scorer.score(job)
        kept.append(job)

    stats["deduped"] = len(jobs)
    stats["passed"] = len(kept)
    stats["dropped"] = drops
    logger.info(
        "jobfeed.scraped",
        fetched=stats.get("fetched"),
        deduped=stats["deduped"],
        passed=stats["passed"],
        failed=len(stats.get("failed") or []),
        seconds=stats.get("seconds"),
    )
    return kept, stats


def _match(job: Job, resume: MasterResume | None):
    """HireCraft's deterministic fit analysis for a posting (no LLM, no API key).

    Uses ``analyze_job_fit`` rather than ``match_resume_to_job``: a scraped posting
    has no structured requirements, and scoring against an empty requirement set
    returns a vacuous 100 for everything. This reads the actual description.
    """
    if resume is None:
        return None
    try:
        return analyze_job_fit(resume, f"{job.title}\n{job.description}", title=job.title)
    except Exception:  # noqa: BLE001 - a scoring hiccup must not fail the run
        return None


def persist(
    db,  # noqa: ANN001 - Session; typed loosely to avoid an import cycle
    user_id,  # noqa: ANN001 - uuid.UUID
    jobs: list[Job],
    *,
    resume: MasterResume | None = None,
    deactivate_missing: bool = True,
) -> dict[str, int]:
    """Upsert this run's postings for one user; returns {new, updated, deactivated}.

    A posting is identified by the scraper's own content fingerprint, so re-seeing
    it refreshes ``last_seen`` (and any changed detail) rather than duplicating.
    """
    now = datetime.now(UTC)
    existing = {
        row.fingerprint: row
        for row in db.query(ScrapedJob).filter(ScrapedJob.user_id == user_id).all()
    }
    seen: set[str] = set()
    counts = {"new": 0, "updated": 0, "deactivated": 0}

    for job in jobs:
        fingerprint = job.id
        seen.add(fingerprint)
        fit = _match(job, resume)
        row = existing.get(fingerprint)
        if row is None:
            row = ScrapedJob(
                user_id=user_id,
                fingerprint=fingerprint,
                first_seen=now,
                status="new",
            )
            db.add(row)
            counts["new"] += 1
        else:
            counts["updated"] += 1

        row.source = _clip(job.source, 32)
        row.company = _clip(job.company, 255)
        row.title = _clip(job.title, 500)
        row.url = job.url
        row.location = _clip(job.location, 500)
        row.description = (job.description or "")[:20000]
        row.remote = job.remote
        row.posted_at = job.posted_at
        row.level = _clip(job.level, 32) or "unknown"
        row.bucket = _clip(job.bucket, 64)
        row.terms = list(job.terms or [])
        row.sponsorship = job.sponsorship or ""
        row.min_years = job.min_years
        row.flags = list(job.flags or [])
        row.track = _clip(job.track, 32)
        row.track_resume = _clip(job.resume, 120)
        row.track_score = int(job.score or 0)
        row.track_scores = dict(job.track_scores or {})
        row.reasons = list(job.reasons or [])
        if fit is not None:
            row.match_score = fit.score
            row.match_verdict = fit.verdict
            row.interview_chance = fit.interview_chance
            row.match_summary = fit.summary
            row.strengths = list(fit.strengths or [])[:12]
            row.gaps = list(fit.gaps or [])[:12]
        row.last_seen = now
        row.active = True

    if deactivate_missing:
        for fingerprint, row in existing.items():
            # Keep the row (the user may have saved or applied to it) but mark it
            # closed, so the feed can grey it out instead of losing it.
            if fingerprint not in seen and row.active:
                row.active = False
                counts["deactivated"] += 1

    db.commit()
    logger.info("jobfeed.persisted", user_id=str(user_id), **counts)
    return counts
