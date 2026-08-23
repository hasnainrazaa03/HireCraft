from __future__ import annotations
from ..http import get_json
from ..models import Job
from ..textutil import html_to_text, parse_dt, pretty_company

API = "https://api.lever.co/v0/postings/{token}?mode=json"


def fetch(token: str) -> list[Job]:
    data = get_json(API.format(token=token))
    if not data or not isinstance(data, list):
        return []
    jobs = []
    for x in data:
        cats = x.get("categories") or {}
        desc_parts = [x.get("descriptionPlain") or html_to_text(x.get("description"))]
        for lst in x.get("lists") or []:
            desc_parts.append(f"{lst.get('text', '')}\n{html_to_text(lst.get('content'))}")
        desc_parts.append(x.get("additionalPlain") or "")
        locs = cats.get("allLocations") or [cats.get("location") or ""]
        wp = (x.get("workplaceType") or "").lower()
        jobs.append(Job(
            source="lever",
            company=pretty_company(token),
            title=x.get("text", ""),
            url=x.get("hostedUrl") or x.get("applyUrl") or "",
            location="; ".join(l for l in locs if l),
            description="\n".join(p for p in desc_parts if p),
            posted_at=parse_dt(x.get("createdAt")),
            remote=True if wp == "remote" else None,
            extra={"team": cats.get("team"), "commitment": cats.get("commitment"), "token": token},
        ))
    return jobs


def probe(token: str) -> int | None:
    data = get_json(API.format(token=token))
    return len(data) if isinstance(data, list) else None
