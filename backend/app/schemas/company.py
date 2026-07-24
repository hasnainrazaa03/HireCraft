"""Company intelligence schemas.

A company brief helps a candidate prepare before applying or interviewing. It is
AI-synthesised from the model's general knowledge (optionally grounded in a
public page the user pastes), and is deliberately built to avoid two failure
modes:

1. **Fake precision.** Size, funding, and headcount are expressed as bands or
   left empty — never invented exact figures.
2. **Personal data.** The brief describes the *company*, never individuals'
   contact details. Finding a specific person is handled separately, as
   compliant guidance, never by scraping or storing anyone's PII.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CompanyModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


class CompanyBrief(CompanyModel):
    """The AI-generated brief. Also the Gemini response schema, so the field
    descriptions double as generation instructions."""

    overview: str = Field(
        default="",
        max_length=800,
        description="2–4 sentences: what the company does and who for. Only what "
        "you are reasonably confident is true.",
    )
    industry: str | None = Field(
        default=None, max_length=160, description="Primary industry / sector."
    )
    size_band: str | None = Field(
        default=None,
        max_length=80,
        description="Rough employee band as a RANGE, never an exact number — e.g. "
        "'Startup (~11–50)', 'Mid-size (~500–1,000)', 'Large (5,000+)'. Null if unsure.",
    )
    headquarters: str | None = Field(
        default=None, max_length=160, description="Primary HQ location, if known."
    )
    known_for: list[str] = Field(
        default_factory=list,
        max_length=8,
        description="Flagship products, services, or things the company is known for.",
    )
    likely_tech_stack: list[str] = Field(
        default_factory=list,
        max_length=20,
        description="Technologies the company likely uses, for a candidate to prepare. "
        "Mark inherent uncertainty by keeping this to plausible, well-supported guesses.",
    )
    culture_signals: list[str] = Field(
        default_factory=list,
        max_length=8,
        description="Publicly-known culture/values signals useful for framing an application.",
    )
    recent_context: list[str] = Field(
        default_factory=list,
        max_length=6,
        description="Recent-ish, notable, non-time-critical context (product areas, "
        "general trajectory). Do NOT state specific dated events, funding amounts, or "
        "figures you are not confident are current.",
    )
    interview_angles: list[str] = Field(
        default_factory=list,
        max_length=8,
        description="What a candidate should emphasise or research to stand out here.",
    )
    smart_questions: list[str] = Field(
        default_factory=list,
        max_length=8,
        description="Thoughtful questions the candidate could ask the company.",
    )
    watch_outs: list[str] = Field(
        default_factory=list,
        max_length=6,
        description="Neutral things worth independently verifying (e.g. 'confirm "
        "current team size', 'check recent news'). Not gossip or unverified claims.",
    )
    confidence: Literal["high", "medium", "low"] = Field(
        default="low",
        description="How confident you are overall. Use 'low' for companies you do "
        "not clearly recognise, and keep such briefs sparse rather than guessing.",
    )
    freshness_note: str = Field(
        default="",
        max_length=300,
        description="A one-line reminder of what the candidate should verify because "
        "it may be out of date (news, funding, headcount, leadership).",
    )


class CompanyBriefRequest(CompanyModel):
    company: str = Field(min_length=1, max_length=200)
    role: str | None = Field(default=None, max_length=200)
    # Optional grounding: either a public URL to fetch or pasted page text. Used
    # only to inform the brief; never stored.
    url: str | None = Field(default=None, max_length=2000)
    page_text: str | None = Field(default=None, max_length=20_000)


class ContactGuidance(CompanyModel):
    """Compliant guidance for finding the right human — no scraping, no stored PII."""

    steps: list[str] = Field(default_factory=list)
    note: str = ""


class CompanyBriefResponse(CompanyModel):
    company: str
    role: str | None = None
    brief: CompanyBrief
    contact_guidance: ContactGuidance
    used_grounding: bool = False
    cost_usd: float = 0.0
    # Always-on reminder rendered prominently in the UI.
    disclaimer: str = (
        "AI-generated from general knowledge and may be incomplete or out of date. "
        "Verify anything you rely on — especially news, funding, headcount, and "
        "leadership — before an interview."
    )
