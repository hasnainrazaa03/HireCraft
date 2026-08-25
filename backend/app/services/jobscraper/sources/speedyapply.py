"""speedyapply's 2027-AI-College-Jobs lists (GitHub).

Markdown tables rather than the JSON the SimplifyJobs lists publish, so the rows
are parsed out of the rendered HTML the tables embed. Company and apply link are
anchor tags; the apply cell wraps an image button, so the link has to be taken
from the anchor's href rather than its text.

Worth having alongside Simplify despite the overlap: this one carries a salary
column, which no other source in the feed does, and it is AI/ML-focused rather
than general new-grad. Postings are deduplicated against every other source by
URL (see services.jobfeed.posting_key), so an overlap costs nothing.

Like the other aggregator lists it carries no description, so a row scores on
its title until the posting itself is fetched.
"""

from __future__ import annotations

import html as _html
import re
from datetime import UTC, datetime, timedelta

from ..http import request
from ..models import Job
from ..textutil import norm_company

BASE = "https://raw.githubusercontent.com/speedyapply/2027-AI-College-Jobs/main"
NEW_GRAD_USA = f"{BASE}/NEW_GRAD_USA.md"
INTERN_USA = f"{BASE}/README.md"

#: Column layouts differ between the tables in one file: the FAANG and Quant
#: sections carry a Salary column and the Other section does not.
#:
#:   | Company | Position | Location | Salary | Posting | Age |
#:   | Company | Position | Location | Posting | Age |
#:
#: So columns are read from each table's own header rather than assumed by
#: position. Assuming cost the larger table entirely — its posting cell sat
#: where Salary was expected, the age cell where the link was, and every one of
#: its rows was dropped for having no link.
_ROW = re.compile(r"^\|(?P<cells>.+)\|\s*$")
_ANCHOR_HREF = re.compile(r'href="([^"]+)"', re.IGNORECASE)
_TAGS = re.compile(r"<[^>]+>")
#: "3d", "2mo", "14h" — how long ago the row says the posting appeared.
_AGE = re.compile(r"^\s*(\d+)\s*(h|d|w|mo|y)\s*$", re.IGNORECASE)
_AGE_UNITS = {"h": 1 / 24, "d": 1, "w": 7, "mo": 30, "y": 365}


def _text(cell: str) -> str:
    """Cell text with its markup removed and entities decoded."""
    return re.sub(r"\s+", " ", _html.unescape(_TAGS.sub(" ", cell))).strip()


def _posted_at(cell: str) -> datetime | None:
    """Turn a relative age like "3d" into a timestamp.

    Approximate by construction — the list only records whole units — but a
    posting's age is what the feed sorts and filters on, so an approximate date
    is far more useful than none.
    """
    match = _AGE.match(_text(cell))
    if not match:
        return None
    amount, unit = int(match.group(1)), match.group(2).lower()
    return datetime.now(UTC) - timedelta(days=amount * _AGE_UNITS.get(unit, 1))


def _parse(markdown: str, kind: str) -> list[Job]:
    jobs: list[Job] = []
    columns: dict[str, int] = {}

    for line in markdown.splitlines():
        matched = _ROW.match(line.strip())
        if not matched:
            continue
        cells = [c.strip() for c in matched.group("cells").split("|")]
        if len(cells) < 4:
            continue

        # A header row redefines the layout for everything beneath it.
        headers = [_text(c).lower() for c in cells]
        if "company" in headers and "position" in headers:
            columns = {name: i for i, name in enumerate(headers) if name}
            continue
        if not columns or set(cells[0]) <= {"-", ":"}:
            continue

        def cell(name: str) -> str:
            index = columns.get(name, -1)
            return cells[index] if 0 <= index < len(cells) else ""

        title_cell, company_cell = cell("position"), cell("company")
        location_cell, salary_cell = cell("location"), cell("salary")
        posting_cell, age_cell = cell("posting"), cell("age")

        title = _text(title_cell)
        company = _text(company_cell)
        # The apply cell is an image inside an anchor, so its text is empty and
        # the link has to come from the href.
        href = _ANCHOR_HREF.search(posting_cell)
        if not (title and company and href):
            continue

        # Rows carry a trailing "↳" when they repeat the company above them,
        # which is presentation rather than a name.
        company = company.replace("↳", "").strip()
        if not company:
            continue

        salary = _text(salary_cell)
        jobs.append(
            Job(
                source=f"speedyapply-{kind}",
                company=norm_company(company),
                title=title,
                url=_html.unescape(href.group(1)),
                location=_text(location_cell),
                posted_at=_posted_at(age_cell),
                # No other source in the feed reports pay, so it is kept even
                # though nothing consumes it yet.
                extra={"salary": salary} if salary and salary != "N/A" else {},
            )
        )
    return jobs


def _fetch(url: str, kind: str) -> list[Job]:
    response = request("GET", url)
    if response is None or response.status_code != 200:
        return []
    return _parse(response.text, kind)


def fetch_new_grad() -> list[Job]:
    return _fetch(NEW_GRAD_USA, "new_grad")


def fetch_internships() -> list[Job]:
    # The repository's README is the internship list; the other files are the
    # international variants, which this feed does not target.
    return _fetch(INTERN_USA, "intern")


def raw_urls() -> list[str]:
    """Every apply link, for mining new ATS board tokens."""
    return [job.url for job in (fetch_new_grad() + fetch_internships()) if job.url]
