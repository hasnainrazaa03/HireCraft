"""Job posting schemas: the scrape result and the extracted requirements."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

ShortStr = Annotated[str, Field(min_length=1, max_length=255)]


class JobModel(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class ScrapeResult(JobModel):
    """Raw output of the scraper, before any LLM involvement."""

    url: str | None = None
    source: str | None = None
    title: str | None = None
    company: str | None = None
    location: str | None = None
    text: str = Field(min_length=1)
    truncated: bool = False


class Skill(JobModel):
    name: ShortStr
    # 1 = nice-to-have, 5 = hard requirement. Drives keyword prioritization.
    importance: int = Field(default=3, ge=1, le=5)
    category: str | None = Field(default=None, max_length=80)


class JobRequirements(JobModel):
    """Structured output of the Requirement Extractor prompt.

    Field names and descriptions are surfaced to the model as a response schema,
    so keep them unambiguous.
    """

    title: str | None = Field(default=None, max_length=255)
    company: str | None = Field(default=None, max_length=255)
    location: str | None = Field(default=None, max_length=255)
    employment_type: (
        Literal["full_time", "part_time", "internship", "contract", "temporary", "unknown"]
    ) = "unknown"
    seniority: (
        Literal["intern", "entry", "mid", "senior", "staff", "lead", "manager", "unknown"]
    ) = "unknown"

    required_skills: list[Skill] = Field(default_factory=list, max_length=40)
    preferred_skills: list[Skill] = Field(default_factory=list, max_length=40)
    responsibilities: list[str] = Field(default_factory=list, max_length=30)
    qualifications: list[str] = Field(default_factory=list, max_length=30)

    # Verbatim terms an ATS is likely to filter on. Ordered most to least critical.
    ats_keywords: list[ShortStr] = Field(default_factory=list, max_length=50)

    min_years_experience: int | None = Field(default=None, ge=0, le=50)
    education_requirement: str | None = Field(default=None, max_length=255)
    salary_text: str | None = Field(default=None, max_length=255)

    def all_keywords(self) -> list[str]:
        """Deduplicated keyword list, most important first."""
        seen: set[str] = set()
        ordered: list[str] = []
        ranked = sorted(
            [*self.required_skills, *self.preferred_skills],
            key=lambda s: -s.importance,
        )
        for term in [*self.ats_keywords, *(s.name for s in ranked)]:
            key = term.strip().lower()
            if key and key not in seen:
                seen.add(key)
                ordered.append(term.strip())
        return ordered
