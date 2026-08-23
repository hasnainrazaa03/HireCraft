from __future__ import annotations
import re
from ..http import get_json, request
from ..models import Job
from ..textutil import html_to_text, parse_dt, norm_company

API = "https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true"


HOSTED = "https://job-boards.greenhouse.io/{token}/jobs/{id}"
EMBED = "https://job-boards.greenhouse.io/embed/job_app?for={token}&token={id}"
_hosted_ok: dict[str, bool] = {}


def _hosted_board_ok(token: str, sample_id) -> bool:
    """Does the Greenhouse-hosted job page stay on greenhouse.io (some boards, e.g. Zipline,
    redirect it back to their own generic careers page; others 403 it)?"""
    if token not in _hosted_ok:
        r = request("GET", HOSTED.format(token=token, id=sample_id), retries=0, timeout=15)
        # ok if it stays on greenhouse.io, or redirects to a company page dedicated to that job
        _hosted_ok[token] = r is not None and ("greenhouse.io" in r.url or str(sample_id) in r.url.split("?")[0])
    return _hosted_ok[token]


def job_url(x: dict, token: str) -> str:
    """Always link to a page that shows exactly this job with its Apply form.
    1. the company's own page when it is dedicated to the job (job id in the path);
    2. otherwise the Greenhouse-hosted page, if the board doesn't redirect it away;
    3. otherwise the Greenhouse embed page, which works for every board."""
    url = x.get("absolute_url", "") or ""
    jid = str(x.get("id", ""))
    path = url.split("?")[0]
    if not jid:
        return url
    if jid in path:
        return url
    if _hosted_board_ok(token, jid):
        return HOSTED.format(token=token, id=jid)
    return EMBED.format(token=token, id=jid)


def fetch(token: str) -> list[Job]:
    data = get_json(API.format(token=token))
    if not data:
        return []
    jobs = []
    for x in data.get("jobs", []):
        jobs.append(Job(
            source="greenhouse",
            company=norm_company(x.get("company_name") or token.title()),
            title=x.get("title", ""),
            url=job_url(x, token),
            location=(x.get("location") or {}).get("name", "") or "",
            description=html_to_text(x.get("content")),
            posted_at=parse_dt(x.get("first_published") or x.get("updated_at")),
            extra={"departments": [d.get("name") for d in x.get("departments", []) if d.get("name")],
                   "token": token},
        ))
    return jobs


def probe(token: str) -> int | None:
    data = get_json(f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs")
    return len(data.get("jobs", [])) if data else None
