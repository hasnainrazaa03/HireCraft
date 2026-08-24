"""Scheduled job-feed scraper: run the vendored pipeline, persist what survives.

Mirrors the standalone tool's `run` command — collect → dedupe → filter → score —
then upserts into ``scraped_jobs`` instead of writing SQLite/Excel. Postings that
stop appearing are marked inactive rather than deleted, so a role the user was
looking at doesn't disappear mid-decision.

Fit is deliberately NOT computed here. A score stored at scrape time is against
whichever résumé happened to be default then, and goes stale the moment the user
adds or edits one — so the feed endpoint scores live against the résumé being
viewed instead. This also keeps the scheduled run cheap: no per-user scoring pass
over thousands of postings.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from pathlib import Path
from typing import Any

import yaml

from app.core.logging import get_logger
from app.models.scraped_job import ScrapedJob
from app.services.degrees import classify
from app.services.jobscraper.filters import SENIOR_RE, Filters
from app.services.jobscraper.models import Job
from app.services.jobscraper.scorer import Scorer
from app.services.jobscraper.sources import collect, dedupe

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


# Tracking and referrer parameters differ per source for the same posting, so
# they must not enter its identity.
_TRACKING_PARAMS = re.compile(
    r"^(utm_\w+|gh_src|ref|referer|referrer|source|src|campaign|trk|lever-source.*)$",
    re.IGNORECASE,
)


def posting_key(url: str, fallback: str) -> str:
    """Stable identity for a posting.

    The URL is the only thing two sources agree on. The same Roblox req arrives
    from Greenhouse as "[2027] Software Engineer, Early Career" and from Simplify
    as "Software Engineer - Early Career", and the same xAI req arrives under the
    company names "xAI" and "SpaceXAI" — so a content hash of company, title and
    location stores the posting twice. Where there is no URL, fall back to the
    scraper's own content hash.
    """
    if not url:
        return fallback
    try:
        parsed = urlsplit(url.strip())
    except ValueError:
        return fallback
    if not parsed.netloc:
        return fallback
    query = urlencode(
        sorted((k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=False)
               if not _TRACKING_PARAMS.match(k))
    )
    canonical = urlunsplit((
        parsed.scheme.lower(),
        parsed.netloc.lower(),
        parsed.path.rstrip("/"),
        query,
        "",
    ))
    return hashlib.sha1(canonical.encode()).hexdigest()[:24]


def persist(
    db,  # noqa: ANN001 - Session; typed loosely to avoid an import cycle
    user_id,  # noqa: ANN001 - uuid.UUID
    jobs: list[Job],
    *,
    deactivate_missing: bool = True,
) -> dict[str, int]:
    """Upsert this run's postings for one user; returns {new, updated, deactivated}.

    A posting is identified by its URL (see ``posting_key``), so the same job
    arriving from two boards under different titles refreshes one row rather than
    creating a second.
    Résumé fit is not stored — see the module docstring.
    """
    now = datetime.now(UTC)
    existing = {
        row.fingerprint: row
        for row in db.query(ScrapedJob).filter(ScrapedJob.user_id == user_id).all()
    }
    seen: set[str] = set()
    counts = {"new": 0, "updated": 0, "deactivated": 0}

    for job in jobs:
        fingerprint = posting_key(job.url, job.id)
        if fingerprint in seen:
            # Two sources in the same run carrying one posting; the first wins
            # and the second must not overwrite its (possibly richer) fields.
            continue
        seen.add(fingerprint)
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
        # Never replace a description with nothing. Most feed rows arrive from
        # aggregator lists with no body and are filled in later by fetching the
        # posting; blindly assigning here erased that on the next scrape, so the
        # same job silently lost its description every few hours.
        incoming = (job.description or "")[:20000]
        if len(incoming) > len(row.description or ""):
            row.description = incoming
            row.degree_level = classify(row.description).value
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
