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
