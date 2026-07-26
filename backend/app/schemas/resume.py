"""The Master Resume schema - HireCraft's "source of truth" contract.

Design rule that everything else depends on:

* **Immutable fields** are verifiable facts about the candidate - employer names,
  job titles, institutions, degrees, dates. The LLM is never permitted to alter
  these, and ``app.services.llm.guardrails`` enforces that mechanically.
* **Mutable fields** are presentation - bullet wording, ordering, the summary,
  which skills get surfaced. These are what the optimizer is allowed to rewrite.

``ENTRY_IMMUTABLE_FIELDS`` below is consumed directly by the guardrail layer, so
adding a factual field here automatically protects it.
"""

from __future__ import annotations

import hashlib
import re
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    HttpUrl,
    field_validator,
    model_validator,
)

# "2023-05", "2023", or the sentinel "Present" for an ongoing role.
DATE_PATTERN = re.compile(r"^(?:\d{4}(?:-(?:0[1-9]|1[0-2]))?|Present)$")

ShortStr = Annotated[str, Field(min_length=1, max_length=255)]
Bullet = Annotated[str, Field(min_length=1, max_length=800)]


class HireCraftModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        validate_assignment=True,
    )


def _validate_date(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not DATE_PATTERN.match(value):
        raise ValueError(
            f"Invalid date {value!r}. Use 'YYYY', 'YYYY-MM', or 'Present'."
        )
    return value


def _stable_id(*parts: object) -> str:
    """Deterministic short id so diffs survive round-trips through the LLM."""
    raw = "|".join(str(p or "") for p in parts).lower()
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


class Link(HireCraftModel):
    label: ShortStr
    url: HttpUrl


class Basics(HireCraftModel):
    """Contact block. Entirely immutable - the LLM must never touch it."""

    name: ShortStr
    email: EmailStr
    phone: str | None = Field(default=None, max_length=40)
    location: str | None = Field(default=None, max_length=180)
    website: HttpUrl | None = None
    linkedin: HttpUrl | None = None
    github: HttpUrl | None = None
    links: list[Link] = Field(default_factory=list, max_length=10)

    # Mutable: the tailored positioning statement.
    headline: str | None = Field(default=None, max_length=200)
    summary: str | None = Field(default=None, max_length=1200)


class DatedEntry(HireCraftModel):
    start_date: str | None = None
    end_date: str | None = None

    @field_validator("start_date", "end_date")
    @classmethod
    def _check_dates(cls, v: str | None) -> str | None:
        return _validate_date(v)

    @model_validator(mode="after")
    def _check_range(self) -> DatedEntry:
        start, end = self.start_date, self.end_date
        if start and end and end != "Present" and start != "Present" and end < start:
            raise ValueError(f"end_date {end!r} precedes start_date {start!r}")
        return self


class Experience(DatedEntry):
    id: str = ""
    company: ShortStr
    title: ShortStr
    location: str | None = Field(default=None, max_length=180)
    # Mutable: this is the primary surface the optimizer rewrites.
    highlights: list[Bullet] = Field(default_factory=list, max_length=12)
    technologies: list[ShortStr] = Field(default_factory=list, max_length=40)

    @model_validator(mode="after")
    def _assign_id(self) -> Experience:
        if not self.id:
            # Bypass validate_assignment recursion by writing to __dict__.
            self.__dict__["id"] = _stable_id(
                "exp", self.company, self.title, self.start_date
            )
        return self


class Education(DatedEntry):
    id: str = ""
    institution: ShortStr
    degree: ShortStr
    field_of_study: str | None = Field(default=None, max_length=255)
    location: str | None = Field(default=None, max_length=180)
    gpa: str | None = Field(default=None, max_length=20)
    honors: list[ShortStr] = Field(default_factory=list, max_length=10)
    # Mutable: which courses to surface depends on the target role.
    coursework: list[ShortStr] = Field(default_factory=list, max_length=30)
    highlights: list[Bullet] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def _assign_id(self) -> Education:
        if not self.id:
            self.__dict__["id"] = _stable_id(
                "edu", self.institution, self.degree, self.start_date
            )
        return self


class Project(DatedEntry):
    id: str = ""
    name: ShortStr
    description: str | None = Field(default=None, max_length=600)
    url: HttpUrl | None = None
    technologies: list[ShortStr] = Field(default_factory=list, max_length=40)
    highlights: list[Bullet] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def _assign_id(self) -> Project:
        if not self.id:
            self.__dict__["id"] = _stable_id("proj", self.name, self.start_date)
        return self


class SkillGroup(HireCraftModel):
    category: ShortStr
    items: list[ShortStr] = Field(min_length=1, max_length=60)


class Certification(HireCraftModel):
    name: ShortStr
    issuer: str | None = Field(default=None, max_length=255)
    date: str | None = None
    url: HttpUrl | None = None

    @field_validator("date")
    @classmethod
    def _check_date(cls, v: str | None) -> str | None:
        return _validate_date(v)


class Award(HireCraftModel):
    title: ShortStr
    issuer: str | None = Field(default=None, max_length=255)
    date: str | None = None
    description: str | None = Field(default=None, max_length=500)

    @field_validator("date")
    @classmethod
    def _check_date(cls, v: str | None) -> str | None:
        return _validate_date(v)


class Publication(HireCraftModel):
    title: ShortStr
    venue: str | None = Field(default=None, max_length=255)
    date: str | None = None
    url: HttpUrl | None = None
    authors: list[ShortStr] = Field(default_factory=list, max_length=30)

    @field_validator("date")
    @classmethod
    def _check_date(cls, v: str | None) -> str | None:
        return _validate_date(v)


SectionName = Literal[
    "summary",
    "education",
    "experience",
    "projects",
    "skills",
    "certifications",
    "awards",
    "publications",
]

DEFAULT_SECTION_ORDER: list[SectionName] = [
    "summary",
    "education",
    "experience",
    "projects",
    "skills",
    "certifications",
    "awards",
    "publications",
]


class MasterResume(HireCraftModel):
    """The complete, validated source of truth for one candidate."""

    schema_version: Literal["1.0"] = "1.0"
    basics: Basics
    experience: list[Experience] = Field(default_factory=list, max_length=25)
    education: list[Education] = Field(default_factory=list, max_length=10)
    projects: list[Project] = Field(default_factory=list, max_length=25)
    skills: list[SkillGroup] = Field(default_factory=list, max_length=15)
    certifications: list[Certification] = Field(default_factory=list, max_length=20)
    awards: list[Award] = Field(default_factory=list, max_length=20)
    publications: list[Publication] = Field(default_factory=list, max_length=20)

    # Mutable: tailoring may reorder or hide sections for a given target role.
    section_order: list[SectionName] = Field(
        default_factory=lambda: list(DEFAULT_SECTION_ORDER)
    )

    @model_validator(mode="after")
    def _check_section_order(self) -> MasterResume:
        if len(set(self.section_order)) != len(self.section_order):
            raise ValueError("section_order contains duplicates")
        return self

    @model_validator(mode="after")
    def _require_some_content(self) -> MasterResume:
        if not (self.experience or self.education or self.projects):
            raise ValueError(
                "A resume needs at least one experience, education, or project entry."
            )
        return self

    @model_validator(mode="after")
    def _ensure_unique_entry_ids(self) -> MasterResume:
        """Guarantee every entry id is unique across the whole resume.

        ``_stable_id`` hashes only a handful of factual fields, so two entries
        that share them collide - two undated projects called "Portfolio Site",
        or two stints with the same title at the same employer. The guardrail
        merge indexes entries by id, so a collision makes it apply one entry's
        tailored bullets to the other: content from one role silently appears
        under another. Disambiguate by position, which is deterministic for a
        given resume, and write through ``__dict__`` to avoid re-triggering
        validate_assignment.
        """
        seen: set[str] = set()
        for section in ("experience", "education", "projects"):
            for position, entry in enumerate(getattr(self, section)):
                entry_id = entry.id
                if entry_id in seen:
                    suffix = 1
                    while (retry := _stable_id(entry_id, position, suffix)) in seen:
                        suffix += 1
                    entry_id = retry
                    entry.__dict__["id"] = entry_id
                seen.add(entry_id)
        return self

    def entry_index(self) -> dict[str, dict[str, Any]]:
        """Map every stable entry id -> its immutable factual fields.

        This is exactly what the guardrail layer compares before/after tailoring.
        """
        index: dict[str, dict[str, Any]] = {}
        for section in ("experience", "education", "projects"):
            for entry in getattr(self, section):
                immutable = ENTRY_IMMUTABLE_FIELDS[section]
                index[entry.id] = {
                    "_section": section,
                    **{f: getattr(entry, f, None) for f in immutable},
                }
        return index


# Fields the LLM is forbidden from changing, per section. Consumed by
# app.services.llm.guardrails - keep in sync with the models above.
ENTRY_IMMUTABLE_FIELDS: dict[str, tuple[str, ...]] = {
    "experience": ("company", "title", "start_date", "end_date", "location"),
    "education": (
        "institution",
        "degree",
        "field_of_study",
        "start_date",
        "end_date",
        "gpa",
    ),
    "projects": ("name", "start_date", "end_date", "url"),
}

# Top-level immutable block: contact details must survive tailoring untouched.
BASICS_IMMUTABLE_FIELDS: tuple[str, ...] = (
    "name",
    "email",
    "phone",
    "location",
    "website",
    "linkedin",
    "github",
)
