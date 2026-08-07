"""Multi-source job aggregation.

Pulls recent postings from several free, keyless sources — Arbeitnow, Remotive,
RemoteOK, and GitHub job-listing repos (structured ``listings.json`` when a repo
publishes one, else the README table) — normalises them into a single shape,
de-duplicates, and caches each source in Redis so we're a polite client. Any
source that errors is skipped, never fatal: job search is a convenience layer.

We deliberately do **not** scrape LinkedIn/Indeed/etc. — that violates their ToS
and breaks constantly. Official APIs, structured repos, and (elsewhere) the
SSRF-safe single-URL scraper are the sanctioned paths. Keyed aggregators (Adzuna,
JSearch) can be added as new sources here when a key is configured.
"""

from __future__ import annotations

import contextlib
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

import httpx
import redis

from app.core.config import settings
from app.core.logging import get_logger
from app.core.rate_limit import get_redis
from app.schemas.jobsearch import JobSearchResult

logger = get_logger(__name__)

_TAG_RE = re.compile(r"<[^>]+>")
_MD_LINK = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")
_HREF = re.compile(r'href=["\']([^"\']+)["\']')
_URL_RE = re.compile(r"https?://[^\s)\"'<>|]+")

_API_TTL = 900  # 15 min for job-board APIs
_GH_TTL = 1800  # 30 min for GitHub repos


def _strip_html(html: str) -> str:
    return re.sub(r"\s+", " ", _TAG_RE.sub(" ", html or "")).strip()


def _to_unix(value: object) -> int | None:
    """Best-effort → unix seconds. Accepts an int/float, or an ISO/date string."""
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value.strip():
        s = value.strip().replace("Z", "+00:00")
        for parse in (
            lambda x: datetime.fromisoformat(x),
            lambda x: datetime.strptime(x[:10], "%Y-%m-%d"),
        ):
            with contextlib.suppress(ValueError):
                return int(parse(s).timestamp())
    return None


def _cache_get(key: str) -> list[dict] | None:
    with contextlib.suppress(redis.RedisError, ValueError):
        cached = get_redis().get(key)
        if cached:
            return json.loads(cached)
    return None


def _cache_set(key: str, data: list[dict], ttl: int) -> None:
    with contextlib.suppress(redis.RedisError, TypeError):
        get_redis().setex(key, ttl, json.dumps(data))


def _result(**kw) -> dict:
    """A normalised posting as a plain dict (so it's cacheable as JSON)."""
    return {
        "title": (kw.get("title") or "").strip()[:250],
        "company": (kw.get("company") or "").strip()[:200],
        "location": (kw.get("location") or "").strip()[:160],
        "url": (kw.get("url") or "").strip(),
        "remote": bool(kw.get("remote")),
        "tags": [str(t).strip() for t in (kw.get("tags") or []) if str(t).strip()][:8],
        "snippet": (kw.get("snippet") or "")[:600],
        "source": kw.get("source") or "Web",
        "created_at": kw.get("created_at"),
        # Real registrable domain for a logo lookup, when a source hands us one
        # (e.g. GitHub listings carry company_url). Empty → the client guesses
        # from the company name.
        "company_domain": _domain_of(kw.get("company_domain")),
    }


# Application-tracking / aggregator hosts that appear in a listing's
# "company_url" as a redirect. They are never the employer's own domain, so a
# logo built from them would be identical for every company — reject them and
# let the client guess the real domain from the company name instead.
_AGGREGATOR_HOSTS = frozenset({
    "simplify.jobs", "greenhouse.io", "boards.greenhouse.io", "lever.co",
    "jobs.lever.co", "ashbyhq.com", "jobs.ashbyhq.com", "myworkdayjobs.com",
    "workday.com", "icims.com", "smartrecruiters.com", "workable.com",
    "bamboohr.com", "linkedin.com", "indeed.com", "glassdoor.com", "github.com",
})


def _domain_of(url: str | None) -> str:
    """Bare host from a URL (or a bare host), lower-cased, no leading www.

    Used to build a logo URL. Returns "" for anything that isn't a plausible
    employer domain — including known aggregator/ATS hosts — so the client falls
    back to guessing from the company name.
    """
    if not url:
        return ""
    host = url.strip().lower()
    host = re.sub(r"^[a-z]+://", "", host)  # scheme
    host = host.split("/")[0].split("?")[0].split("#")[0]  # path/query
    host = host.split("@")[-1].split(":")[0]  # creds / port
    if host.startswith("www."):
        host = host[4:]
    if "." not in host or " " in host:
        return ""
    # Reject aggregators by registrable suffix ("boards.greenhouse.io" too).
    if any(host == h or host.endswith("." + h) for h in _AGGREGATOR_HOSTS):
        return ""
    return host


# --- Sources ----------------------------------------------------------------


def _fetch_arbeitnow() -> list[dict]:
    key = "jobsearch:arbeitnow"
    if (c := _cache_get(key)) is not None:
        return c
    out: list[dict] = []
    try:
        for page in (1, 2):
            resp = httpx.get(
                "https://www.arbeitnow.com/api/job-board-api",
                params={"page": page}, timeout=10,
            )
            resp.raise_for_status()
            for j in resp.json().get("data", []):
                out.append(_result(
                    title=j.get("title"), company=j.get("company_name"),
                    location=j.get("location"), url=j.get("url"),
                    remote=j.get("remote"), tags=j.get("tags"),
                    snippet=_strip_html(j.get("description", "")),
                    source="Arbeitnow", created_at=_to_unix(j.get("created_at")),
                ))
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("jobsearch.arbeitnow_failed", error=str(exc)[:200])
    _cache_set(key, out, _API_TTL)
    return out


def _fetch_remotive() -> list[dict]:
    key = "jobsearch:remotive"
    if (c := _cache_get(key)) is not None:
        return c
    out: list[dict] = []
    try:
        resp = httpx.get("https://remotive.com/api/remote-jobs", params={"limit": 100}, timeout=12)
        resp.raise_for_status()
        for j in resp.json().get("jobs", []):
            out.append(_result(
                title=j.get("title"), company=j.get("company_name"),
                location=j.get("candidate_required_location") or "Remote",
                url=j.get("url"), remote=True,
                tags=(j.get("tags") or [])[:6],
                snippet=_strip_html(j.get("description", "")),
                source="Remotive", created_at=_to_unix(j.get("publication_date")),
            ))
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("jobsearch.remotive_failed", error=str(exc)[:200])
    _cache_set(key, out, _API_TTL)
    return out


def _fetch_remoteok() -> list[dict]:
    key = "jobsearch:remoteok"
    if (c := _cache_get(key)) is not None:
        return c
    out: list[dict] = []
    try:
        # RemoteOK blocks requests without a browser-ish User-Agent.
        resp = httpx.get(
            "https://remoteok.com/api",
            headers={"User-Agent": settings.scrape_user_agent, "Accept": "application/json"},
            timeout=12,
        )
        resp.raise_for_status()
        for j in resp.json():
            if not isinstance(j, dict) or not j.get("position"):
                continue  # first element is a legal notice
            out.append(_result(
                title=j.get("position"), company=j.get("company"),
                location=j.get("location") or "Remote", url=j.get("url"),
                remote=True, tags=(j.get("tags") or [])[:6],
                snippet=_strip_html(j.get("description", "")),
                source="RemoteOK", created_at=_to_unix(j.get("epoch") or j.get("date")),
            ))
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("jobsearch.remoteok_failed", error=str(exc)[:200])
    _cache_set(key, out, _API_TTL)
    return out


# GitHub -----------------------------------------------------------------

_LISTINGS_PATHS = (
    "{branch}/.github/scripts/listings.json",
    "{branch}/listings.json",
    "{branch}/.github/scripts/listings.py.json",
)


def _fetch_github() -> list[dict]:
    repos = [r.strip() for r in settings.github_job_repos.split(",") if r.strip()]
    out: list[dict] = []
    for repo in repos:
        out.extend(_fetch_github_repo(repo))
    return out


def _fetch_github_repo(repo: str) -> list[dict]:
    key = f"jobsearch:github:{repo}"
    if (c := _cache_get(key)) is not None:
        return c
    out = _github_listings_json(repo) or _github_readme_table(repo)
    _cache_set(key, out, _GH_TTL)
    return out


def _github_listings_json(repo: str) -> list[dict]:
    """Structured listings.json (the Simplify format many repos use/fork)."""
    for branch in ("dev", "main", "master"):
        for tmpl in _LISTINGS_PATHS:
            url = f"https://raw.githubusercontent.com/{repo}/{tmpl.format(branch=branch)}"
            try:
                resp = httpx.get(url, timeout=12)
                if resp.status_code != 200:
                    continue
                data = resp.json()
            except (httpx.HTTPError, ValueError):
                continue
            if not isinstance(data, list):
                continue
            out: list[dict] = []
            for j in data:
                if not isinstance(j, dict) or not j.get("title"):
                    continue
                if j.get("active") is False or j.get("is_visible") is False:
                    continue
                locations = j.get("locations") or []
                loc = ", ".join(str(x) for x in locations)
                sponsorship = j.get("sponsorship") or ""
                terms = j.get("terms") or []
                tags = [t for t in [*terms, sponsorship] if t and t != "Other"]
                snippet_bits = [b for b in [
                    f"Sponsorship: {sponsorship}" if sponsorship else "",
                    f"Terms: {', '.join(terms)}" if terms else "",
                ] if b]
                out.append(_result(
                    title=j.get("title"), company=j.get("company_name"),
                    location=loc, url=j.get("url") or j.get("company_url"),
                    remote="remote" in loc.lower(), tags=tags,
                    snippet=" · ".join(snippet_bits) or "Internship / new-grad listing.",
                    source=f"GitHub · {repo.split('/')[-1]}",
                    created_at=_to_unix(j.get("date_posted") or j.get("date_updated")),
                    company_domain=j.get("company_url"),
                ))
            if out:
                logger.info("jobsearch.github_listings", repo=repo, count=len(out))
                return out
    return []


def _github_readme_table(repo: str) -> list[dict]:
    """Fallback: parse a Markdown job table from the README."""
    md = ""
    for branch in ("main", "master"):
        for name in ("README.md", "readme.md"):
            try:
                resp = httpx.get(f"https://raw.githubusercontent.com/{repo}/{branch}/{name}", timeout=12)
                if resp.status_code == 200 and resp.text:
                    md = resp.text
                    break
            except httpx.HTTPError:
                continue
        if md:
            break
    if not md:
        return []

    out: list[dict] = []
    prev_company = ""
    for line in md.splitlines():
        line = line.strip()
        if not line.startswith("|") or line.count("|") < 3:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        first = _clean_cell(cells[0])
        # Skip header / separator rows.
        if not first or set(first) <= {"-", ":", " "} or first.lower() in ("company", "name", "role"):
            continue
        # "↳" (or blank) means "same company as the row above".
        company = prev_company if first in ("↳", "⤷", "»", "") else first
        prev_company = company
        role = _clean_cell(cells[1]) if len(cells) > 1 else ""
        location = _clean_cell(cells[2]) if len(cells) > 2 else ""
        url = _first_url(line)
        if not role or not company:
            continue
        out.append(_result(
            title=role, company=company, location=location, url=url,
            remote="remote" in location.lower(),
            snippet=f"{role} at {company}." + (f" {location}." if location else ""),
            source=f"GitHub · {repo.split('/')[-1]}",
        ))
        if len(out) >= 300:
            break
    logger.info("jobsearch.github_readme", repo=repo, count=len(out))
    return out


def _clean_cell(cell: str) -> str:
    cell = _MD_LINK.sub(r"\1", cell)          # [text](url) -> text
    cell = re.sub(r"</?br\s*/?>", ", ", cell)  # line breaks become separators…
    cell = _TAG_RE.sub(" ", cell)             # …then drop any remaining markup
    cell = cell.replace("**", "").replace("`", "")
    cell = re.sub(r"[🔒🛂🇺🇸🎓✅❌🌎→]", "", cell)
    return re.sub(r"\s+", " ", cell).strip(" ,")


def _first_url(row: str) -> str:
    m = _HREF.search(row) or _MD_LINK.search(row)
    if m:
        return m.group(1) if _HREF.search(row) else m.group(2)
    m2 = _URL_RE.search(row)
    return m2.group(0) if m2 else ""


_SOURCES = {
    "arbeitnow": _fetch_arbeitnow,
    "remotive": _fetch_remotive,
    "remoteok": _fetch_remoteok,
    "github": _fetch_github,
}


# --- Aggregate --------------------------------------------------------------


_QUERY_STOP = {
    "and", "or", "the", "a", "an", "of", "in", "for", "to", "with", "at", "on",
    "new", "grad", "graduate", "senior", "junior", "sr", "jr", "entry", "level",
}


def _query_tokens(q: str) -> list[str]:
    """Significant search terms — punctuation-split, stopwords and 1-char noise
    dropped — so multi-word queries match on their concepts, not a verbatim phrase."""
    return [t for t in re.findall(r"[a-z0-9+#.]+", q.lower()) if len(t) > 1 and t not in _QUERY_STOP]


def search_jobs(
    query: str | None = None,
    *,
    remote_only: bool = False,
    exclude: list[str] | None = None,
    must_have: list[str] | None = None,
    limit: int = 30,
    sources: list[str] | None = None,
) -> list[JobSearchResult]:
    """Aggregate + filter recent postings across all enabled sources.

    ``exclude`` drops postings whose title/company contains any of the terms
    (e.g. "senior", "sales"); ``must_have`` keeps only postings whose
    title/snippet/tags contain every term (e.g. "python", "remote").
    """
    exclude_terms = [t.strip().lower() for t in (exclude or []) if t.strip()]
    must_terms = [t.strip().lower() for t in (must_have or []) if t.strip()]
    enabled = sources or [s.strip() for s in settings.job_sources.split(",") if s.strip()]
    fns = [(_SOURCES[s]) for s in enabled if s in _SOURCES]

    raw: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(len(fns), 1)) as ex:
        futures = [ex.submit(fn) for fn in fns]
        for fut in as_completed(futures):
            try:
                raw.extend(fut.result() or [])
            except Exception as exc:  # noqa: BLE001 - one bad source shouldn't fail search
                logger.info("jobsearch.source_failed", error=str(exc)[:200])

    q = (query or "").strip().lower()
    q_tokens = _query_tokens(q)
    seen: set[str] = set()
    results: list[JobSearchResult] = []
    for j in raw:
        if remote_only and not j.get("remote"):
            continue
        title_co = f"{j.get('title', '')} {j.get('company', '')}".lower()
        if exclude_terms and any(t in title_co for t in exclude_terms):
            continue
        if must_terms:
            body = f"{title_co} {j.get('snippet', '')} {' '.join(j.get('tags', []))}".lower()
            if not all(t in body for t in must_terms):
                continue
        if q:
            hay = f"{j.get('title', '')} {j.get('company', '')} {' '.join(j.get('tags', []))}".lower()
            # Match the whole phrase (precise) or every significant token, so a
            # multi-word query still finds postings that don't repeat it verbatim.
            if q not in hay and not (q_tokens and all(t in hay for t in q_tokens)):
                continue
        key = (j.get("url") or f"{j.get('title')}|{j.get('company')}").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        results.append(JobSearchResult(**j))

    # Newest first as the default order; the API layer re-scores against the résumé.
    results.sort(key=lambda r: r.created_at or 0, reverse=True)
    return results[:limit]
