"""Job search result schema."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class JobSearchResult(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)

    title: str
    company: str
    location: str
    url: str
    remote: bool
    tags: list[str]
    snippet: str
    # The whole posting. Only populated when a single job is requested — the
    # feed list would otherwise carry a few megabytes of description text for
    # cards that show 400 characters of it.
    description: str = ""
    source: str
    created_at: int | None = None  # unix seconds, for "posted N days ago"
    company_domain: str = ""  # real host for a logo lookup; "" → guess from name
    # Résumé fit analysis (null / empty if the user has no résumé yet).
    match_score: int | None = None
    verdict: str | None = None
    interview_chance: str | None = None
    summary: str | None = None
    strengths: list[str] = []
    gaps: list[str] = []
    # --- scraped-feed extras (empty for the live board sources) -------------
    # Stable id for feed rows, so the UI can mark one saved/applied/dismissed.
    id: str | None = None
    level: str | None = None          # intern | new_grad | early
    # Which degrees the posting will consider (see services.degrees).
    degree_level: str = "unspecified"
    # What the posting says about sponsoring a work visa, and the sentence that
    # decided it — a verdict this consequential should be checkable, not just
    # asserted. The evidence is only sent for a single job, not for a list.
    visa_verdict: str = "unstated"
    visa_evidence: str = ""
    bucket: str | None = None         # "Internship · Summer 2027", "Full-time · …"
    terms: list[str] = []             # ["Summer 2027"]
    sponsorship: str = ""             # what the posting says about visa support
    track: str | None = None          # which résumé track fits best
    track_resume: str | None = None   # e.g. "MHR_ML_v2.pdf"
    track_score: int | None = None    # the scraper's own 0-100 track score
    status: str | None = None         # new | seen | saved | applied | dismissed
    active: bool = True               # False once the posting stops appearing
    # Whether the tracker already holds an application for this posting. Kept
    # separate from `status`, which records what the user did to the *feed row*
    # — a job applied to through the extension, or by hand on the employer's
    # site, never touched its feed row at all.
    applied: bool = False
