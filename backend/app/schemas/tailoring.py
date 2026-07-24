"""Schemas for the tailoring step and its guardrail report."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

Bullet = Annotated[str, Field(min_length=1, max_length=800)]


class TailoringModel(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class TailoredEntry(TailoringModel):
    """Rewritten *presentation* for one resume entry.

    Deliberately carries no factual fields - the optimizer identifies entries by
    ``id`` and may only return new wording. Company, title, and dates are copied
    from the master resume by the merge step and can never be model-authored.
    """

    id: str = Field(min_length=1, max_length=32)
    highlights: list[Bullet] = Field(default_factory=list, max_length=12)
    # Optional reordering hint; lower sorts earlier.
    relevance_rank: int | None = Field(default=None, ge=0, le=100)
    include: bool = True


class TailoredSkillGroup(TailoringModel):
    category: str = Field(min_length=1, max_length=255)
    items: list[str] = Field(default_factory=list, max_length=60)


class TailoringResult(TailoringModel):
    """Structured output of the Experience Optimizer prompt."""

    headline: str | None = Field(default=None, max_length=200)
    summary: str | None = Field(default=None, max_length=1200)
    experience: list[TailoredEntry] = Field(default_factory=list, max_length=25)
    projects: list[TailoredEntry] = Field(default_factory=list, max_length=25)
    education: list[TailoredEntry] = Field(default_factory=list, max_length=10)
    skills: list[TailoredSkillGroup] = Field(default_factory=list, max_length=15)
    # Which of the job's keywords the model believes it surfaced. Verified, not trusted.
    keywords_used: list[str] = Field(default_factory=list, max_length=60)


ViolationKind = Literal[
    "unknown_entry_id",
    "immutable_field_changed",
    "fabricated_number",
    "fabricated_proper_noun",
    "unverified_keyword_claim",
    "bullet_count_inflated",
    "empty_entry",
]

Severity = Literal["error", "warning"]


class GuardrailViolation(TailoringModel):
    kind: ViolationKind
    severity: Severity
    entry_id: str | None = None
    field: str | None = None
    detail: str
    # What the guardrail did about it.
    action: Literal["rejected", "reverted_to_master", "dropped", "flagged"] = "flagged"


class GuardrailReport(TailoringModel):
    violations: list[GuardrailViolation] = Field(default_factory=list)
    keywords_requested: list[str] = Field(default_factory=list)
    keywords_verified: list[str] = Field(default_factory=list)

    @property
    def has_errors(self) -> bool:
        return any(v.severity == "error" for v in self.violations)

    @property
    def keyword_coverage(self) -> float:
        if not self.keywords_requested:
            return 0.0
        return len(self.keywords_verified) / len(self.keywords_requested)


class DiffEntry(TailoringModel):
    """One before/after pair for the frontend diff view."""

    section: str
    entry_id: str | None = None
    label: str
    field: str
    before: str | list[str] | None = None
    after: str | list[str] | None = None
    change: Literal["added", "removed", "modified", "reordered", "unchanged"]
