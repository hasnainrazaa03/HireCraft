"""Job search via a free public job board (Arbeitnow).

Arbeitnow publishes an open, keyless job-board API. We proxy it, normalise the
results, and cache a page in Redis for a few minutes to be a polite client. A
fetch failure degrades to an empty list rather than an error — the feature is a
convenience, never load-bearing.
"""

from __future__ import annotations

import contextlib
import json
import re

import httpx
import redis

from app.core.logging import get_logger
from app.core.rate_limit import get_redis
from app.schemas.jobsearch import JobSearchResult

logger = get_logger(__name__)

_ARBEITNOW_URL = "https://www.arbeitnow.com/api/job-board-api"
_CACHE_KEY = "jobsearch:arbeitnow:p{page}"
_CACHE_TTL = 600  # 10 minutes
_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    text = _TAG_RE.sub(" ", html or "")
    return re.sub(r"\s+", " ", text).strip()


def _fetch_page(page: int) -> list[dict]:
    """One page of raw postings, cached in Redis. Returns [] on any failure."""
    key = _CACHE_KEY.format(page=page)
    try:
        cached = get_redis().get(key)
        if cached:
            return json.loads(cached)
    except (redis.RedisError, ValueError):
        pass

    try:
        resp = httpx.get(_ARBEITNOW_URL, params={"page": page}, timeout=10)
        resp.raise_for_status()
        data = resp.json().get("data", [])
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("jobsearch.fetch_failed", page=page, error=str(exc)[:200])
        return []

    with contextlib.suppress(redis.RedisError):
        get_redis().setex(key, _CACHE_TTL, json.dumps(data))
    return data


def search_jobs(
    query: str | None = None, *, remote_only: bool = False, limit: int = 20
) -> list[JobSearchResult]:
    """Search recent postings. ``query`` matches title/company/tags; the board
    has no server-side search, so we fetch a couple of pages and filter here."""
    q = (query or "").strip().lower()
    raw: list[dict] = []
    for page in (1, 2):
        raw.extend(_fetch_page(page))
        if len(raw) >= 200:
            break

    results: list[JobSearchResult] = []
    for job in raw:
        title = job.get("title") or ""
        company = job.get("company_name") or ""
        tags = job.get("tags") or []
        remote = bool(job.get("remote"))
        if remote_only and not remote:
            continue
        if q:
            hay = f"{title} {company} {' '.join(tags)}".lower()
            if q not in hay:
                continue
        snippet = _strip_html(job.get("description", ""))[:600]
        created = job.get("created_at")
        results.append(
            JobSearchResult(
                title=title,
                company=company,
                location=job.get("location") or "",
                url=job.get("url") or "",
                remote=remote,
                tags=[str(t) for t in tags][:8],
                snippet=snippet,
                source="Arbeitnow",
                created_at=int(created) if isinstance(created, (int, float)) else None,
            )
        )
        if len(results) >= limit:
            break
    return results
