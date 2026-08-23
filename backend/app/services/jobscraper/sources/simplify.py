"""SimplifyJobs community lists (GitHub). Title/company/location/term/sponsorship
only; no description, so these score on title alone."""
from __future__ import annotations
from ..http import get_json
from ..models import Job
from ..textutil import parse_dt, norm_company

INTERNSHIPS = "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json"
NEW_GRAD = "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json"


def _convert(rows, kind: str) -> list[Job]:
    jobs = []
    for x in rows or []:
        if not x.get("active", True) or not x.get("is_visible", True):
            continue
        title = x.get("title", "")
        if kind == "intern" and "intern" not in title.lower() and "co-op" not in title.lower():
            title = f"{title} (Internship)"
        if kind == "new_grad" and not any(k in title.lower() for k in ("new grad", "entry", "early career", "junior", "associate", "university")):
            title = f"{title} (New Grad)"
        jobs.append(Job(
            source=f"simplify-{kind}",
            company=norm_company(x.get("company_name", "")),
            title=title,
            url=x.get("url", ""),
            location="; ".join(x.get("locations") or []),
            posted_at=parse_dt(x.get("date_posted")),
            terms=list(x.get("terms") or []),
            sponsorship=x.get("sponsorship", "") or "",
            extra={"category": x.get("category"), "degrees": x.get("degrees")},
        ))
    return jobs


def fetch_internships() -> list[Job]:
    return _convert(get_json(INTERNSHIPS), "intern")


def fetch_new_grad() -> list[Job]:
    return _convert(get_json(NEW_GRAD), "new_grad")


def raw_urls() -> list[str]:
    """All listing URLs (used by `discover` to mine ATS board tokens)."""
    out = []
    for src in (INTERNSHIPS, NEW_GRAD):
        for x in get_json(src) or []:
            if x.get("url"):
                out.append(x["url"])
    return out
