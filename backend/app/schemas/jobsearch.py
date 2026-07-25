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
    # Approximate résumé fit (null if the user has no résumé yet).
    match_score: int | None = None
    matched_skills: list[str] = []
