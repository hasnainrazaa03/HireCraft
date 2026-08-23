from __future__ import annotations
from ..http import get_json
from ..models import Job
from ..textutil import html_to_text, parse_dt, pretty_company

API = "https://api.ashbyhq.com/posting-api/job-board/{token}"


def fetch(token: str) -> list[Job]:
    data = get_json(API.format(token=token))
    if not data:
        return []
    jobs = []
    for x in data.get("jobs", []):
        if x.get("isListed") is False:
            continue
        locs = [x.get("location") or ""] + [s.get("location", "") for s in x.get("secondaryLocations") or []]
        title = x.get("title", "")
        et = (x.get("employmentType") or "")
        if et.lower() == "intern" and "intern" not in title.lower():
            title = f"{title} (Internship)"
        jobs.append(Job(
            source="ashby",
            company=pretty_company(token),
            title=title,
            url=x.get("jobUrl") or x.get("applyUrl") or "",
            location="; ".join(l for l in locs if l),
            description=x.get("descriptionPlain") or html_to_text(x.get("descriptionHtml")),
            posted_at=parse_dt(x.get("publishedAt")),
            remote=bool(x.get("isRemote")) or None,
            extra={"department": x.get("department"), "team": x.get("team"), "employment_type": et, "token": token},
        ))
    return jobs


def probe(token: str) -> int | None:
    data = get_json(API.format(token=token))
    return len(data.get("jobs", [])) if data else None
