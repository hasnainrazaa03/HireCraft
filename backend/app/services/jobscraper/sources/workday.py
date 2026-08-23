"""Workday 'cxs' JSON API. Search is capped at 20 results/page; we run a few
searches and only fetch full descriptions for titles that pass `want`."""
from __future__ import annotations

import logging
from typing import Callable

from ..http import get_json, post_json
from ..models import Job
from ..textutil import html_to_text, parse_dt, pretty_company

log = logging.getLogger("jobscraper.workday")
QUERIES = ["intern", "internship", "new grad", "university", "early career", "software engineer", "machine learning"]
MAX_PER_QUERY = 200
MAX_DETAILS = 80


def fetch(cfg: dict, want: Callable[[str], bool] | None = None) -> list[Job]:
    tenant, host, site = cfg["tenant"], cfg.get("host", "wd5"), cfg["site"]
    name = cfg.get("name") or pretty_company(tenant)
    base = f"https://{tenant}.{host}.myworkdayjobs.com/wday/cxs/{tenant}/{site}"
    seen: dict[str, dict] = {}
    for q in cfg.get("queries") or QUERIES:
        offset = 0
        while offset < MAX_PER_QUERY:
            data = post_json(f"{base}/jobs", {"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": q})
            if not data:
                break
            posts = data.get("jobPostings") or []
            for p in posts:
                path = p.get("externalPath")
                if path and path not in seen:
                    seen[path] = p
            if len(posts) < 20:
                break
            offset += 20
    jobs, details = [], 0
    for path, p in seen.items():
        title = p.get("title", "")
        if want and not want(title):
            continue
        job = Job(source="workday", company=name, title=title,
                  url=f"https://{tenant}.{host}.myworkdayjobs.com/{site}{path}",
                  location=p.get("locationsText", "") or "",
                  posted_at=parse_dt(p.get("postedOn")), extra={"req": (p.get("bulletFields") or [None])[0]})
        if details < MAX_DETAILS:
            d = get_json(f"{base}{path}")
            details += 1
            info = (d or {}).get("jobPostingInfo") or {}
            if info:
                job.description = html_to_text(info.get("jobDescription"))
                job.location = info.get("location") or job.location
                if info.get("additionalLocations"):
                    job.location += "; " + "; ".join(info["additionalLocations"])
                job.url = info.get("externalUrl") or job.url
                job.posted_at = parse_dt(info.get("startDate")) or job.posted_at
        jobs.append(job)
    return jobs
