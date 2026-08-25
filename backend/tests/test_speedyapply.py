"""Parsing the speedyapply GitHub job lists.

The lists are markdown tables with embedded HTML, and the one thing that has to
be got right is that *the tables in a single file do not share a layout*: the
FAANG and Quant sections carry a Salary column and the Other section does not.
Reading columns by position instead of by header silently dropped the Other
table — its posting cell sat where Salary was expected and its age cell where
the link was, so every row failed the "has a link" check and 268 of 388
postings vanished without an error.
"""

from __future__ import annotations

from app.services.jobscraper.sources.speedyapply import _parse

WITH_SALARY = """
### FAANG+

<!-- TABLE_FAANG_START -->
| Company | Position | Location | Salary | Posting | Age |
|---|---|---|---|---|---|
| <a href="https://www.tiktok.com"><strong>TikTok</strong></a> | Machine Learning Engineer Graduate | San Jose, CA | $202k/yr | <a href="https://lifeattiktok.com/search/7676647728043280645"><img src="https://i.imgur.com/JpkfjIq.png" alt="Apply" width="70"/></a> | 3d |
| <a href="https://www.google.com"><strong>Google</strong></a> | Data Engineer - Google Maps | Mountain View, CA | $196k/yr | <a href="https://www.google.com/about/careers/applications/jobs/results/72704944984990406"><img src="x.png" alt="Apply" width="70"/></a> | 4d |
<!-- TABLE_FAANG_END -->
"""

WITHOUT_SALARY = """
### Other

<!-- TABLE_START -->
| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| <a href="https://www.emoryhealthcare.org"><strong>Emory Healthcare</strong></a> | Associate AI Engineer | Atlanta, GA | <a href="https://non-clinical-emory.icims.com/jobs/170743/associate-ai-engineer"><img src="x.png" alt="Apply" width="70"/></a> | 2mo |
| <a href="https://www.flaglerhealth.io/"><strong>Flagler Health</strong></a> | AI Operations Associate | New York City, NY | <a href="https://jobs.ashbyhq.com/flaglerhealth/e758d675"><img src="x.png" alt="Apply" width="70"/></a> | 14h |
<!-- TABLE_END -->
"""


def test_table_with_a_salary_column() -> None:
    jobs = _parse(WITH_SALARY, "new_grad")
    assert len(jobs) == 2

    tiktok = jobs[0]
    assert tiktok.company == "TikTok"
    assert tiktok.title == "Machine Learning Engineer Graduate"
    assert tiktok.location == "San Jose, CA"
    # The link comes from the anchor's href: the cell's text is an image button,
    # so reading the text would give nothing.
    assert tiktok.url == "https://lifeattiktok.com/search/7676647728043280645"
    assert tiktok.extra["salary"] == "$202k/yr"
    assert tiktok.source == "speedyapply-new_grad"


def test_table_without_a_salary_column() -> None:
    """The layout that a position-based parser silently discarded."""
    jobs = _parse(WITHOUT_SALARY, "new_grad")
    assert len(jobs) == 2

    emory = jobs[0]
    assert emory.company == "Emory Healthcare"
    assert emory.title == "Associate AI Engineer"
    assert emory.location == "Atlanta, GA"
    assert emory.url == "https://non-clinical-emory.icims.com/jobs/170743/associate-ai-engineer"
    assert "salary" not in emory.extra


def test_both_layouts_in_one_document() -> None:
    """A header mid-document changes the layout for everything beneath it."""
    jobs = _parse(WITH_SALARY + WITHOUT_SALARY, "new_grad")
    assert [j.company for j in jobs] == ["TikTok", "Google", "Emory Healthcare", "Flagler Health"]
    assert [bool(j.extra.get("salary")) for j in jobs] == [True, True, False, False]


def test_relative_ages_become_dates() -> None:
    from datetime import UTC, datetime

    jobs = _parse(WITH_SALARY + WITHOUT_SALARY, "new_grad")
    ages = {j.company: (datetime.now(UTC) - j.posted_at).days for j in jobs}
    assert ages["TikTok"] == 3
    assert ages["Google"] == 4
    assert ages["Emory Healthcare"] == 60  # "2mo"
    assert ages["Flagler Health"] == 0  # "14h"


def test_header_and_separator_rows_are_not_postings() -> None:
    jobs = _parse(WITH_SALARY, "new_grad")
    assert all(j.company.lower() != "company" for j in jobs)
    assert all(not set(j.title) <= {"-", ":"} for j in jobs)


def test_rows_without_a_link_are_skipped() -> None:
    """A row with no apply link is not a posting anyone can act on."""
    text = """
| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| <a href="https://x.com"><strong>Acme</strong></a> | Engineer | Remote |  | 1d |
"""
    assert _parse(text, "new_grad") == []


def test_repeated_company_marker_is_stripped() -> None:
    """The list writes a continuation row's company as an arrow, not a name."""
    text = """
| Company | Position | Location | Posting | Age |
|---|---|---|---|---|
| <a href="https://x.com"><strong>↳ Acme</strong></a> | Engineer | Remote | <a href="https://x.com/j/1"><img src="x.png"/></a> | 1d |
"""
    jobs = _parse(text, "new_grad")
    assert len(jobs) == 1
    assert jobs[0].company == "Acme"


def test_a_document_with_no_table_yields_nothing() -> None:
    assert _parse("# Just a heading\n\nSome prose.", "new_grad") == []
    assert _parse("", "new_grad") == []
