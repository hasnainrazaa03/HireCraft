"""Request/response models for the writing studio: cover letters + outreach.

Both features share the same spine — the candidate's master résumé is the only
source of truth, generation is guardrail-vetted, and the user's writing voice is
optional. These schemas are deliberately thin; the truthfulness work happens in
the guardrail engine, not here.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.tailoring import GuardrailReport

CoverLetterTone = Literal[
    "traditional",
    "modern",
    "short",
    "enthusiastic",
    "formal",
    "startup",
    "research",
    "academic",
]

OutreachKind = Literal[
    "recruiter_email",
    "linkedin_connection",
    "follow_up",
    "thank_you",
    "interview_followup",
    "referral_request",
    "offer_negotiation",
]


class StudioModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


class CoverLetterGenerateRequest(StudioModel):
    resume_profile_id: uuid.UUID
    job_text: str = Field(min_length=1, max_length=20_000)
    company: str | None = Field(default=None, max_length=255)
    role: str | None = Field(default=None, max_length=255)
    hiring_manager: str | None = Field(default=None, max_length=255)
    tone: CoverLetterTone = "modern"
    use_voice: bool = True


class CoverLetterResult(StudioModel):
    paragraphs: list[str]
    guardrail_report: GuardrailReport
    tone: CoverLetterTone
    used_voice: bool
    cost_usd: float
    # Salutation + sign-off so the preview reads as a real letter, matching what
    # the PDF/DOCX export renders around the body paragraphs.
    greeting: str = ""
    signature: str = ""


class CoverLetterRenderRequest(StudioModel):
    resume_profile_id: uuid.UUID
    paragraphs: list[str] = Field(min_length=1, max_length=12)
    company: str | None = Field(default=None, max_length=255)
    role: str | None = Field(default=None, max_length=255)
    hiring_manager: str | None = Field(default=None, max_length=255)


class OutreachGenerateRequest(StudioModel):
    resume_profile_id: uuid.UUID
    kind: OutreachKind
    company: str | None = Field(default=None, max_length=255)
    role: str | None = Field(default=None, max_length=255)
    recipient: str | None = Field(default=None, max_length=255)
    context: str | None = Field(default=None, max_length=4000)
    use_voice: bool = True


class OutreachResult(StudioModel):
    kind: OutreachKind
    subject: str
    body: str
    used_voice: bool
    cost_usd: float
    # Non-empty only when the guardrail changed or flagged something.
    warnings: list[str] = Field(default_factory=list)


# --- Saved cover letters -----------------------------------------------------


class SaveCoverLetterRequest(StudioModel):
    """Persist a just-generated studio letter with enough context to reuse it."""

    resume_profile_id: uuid.UUID
    paragraphs: list[str] = Field(min_length=1, max_length=12)
    company: str | None = Field(default=None, max_length=255)
    role: str | None = Field(default=None, max_length=255)
    hiring_manager: str | None = Field(default=None, max_length=255)
    tone: CoverLetterTone = "modern"
    used_voice: bool = False
    job_text: str | None = Field(default=None, max_length=20_000)
    guardrail_report: GuardrailReport | None = None


class SavedCoverLetterFeedbackRequest(StudioModel):
    feedback: str = Field(min_length=2, max_length=600)


class SavedCoverLetterAttachRequest(StudioModel):
    application_id: uuid.UUID


class SavedCoverLetterSummary(StudioModel):
    id: uuid.UUID
    company: str | None = None
    role: str | None = None
    tone: str
    used_voice: bool
    application_id: uuid.UUID | None = None
    application_label: str | None = None
    paragraph_count: int
    updated_at: datetime


class SavedCoverLetterDetail(StudioModel):
    id: uuid.UUID
    company: str | None = None
    role: str | None = None
    hiring_manager: str | None = None
    tone: str
    used_voice: bool
    resume_profile_id: uuid.UUID | None = None
    application_id: uuid.UUID | None = None
    application_label: str | None = None
    paragraphs: list[str]
    job_text: str | None = None
    guardrail_report: GuardrailReport | None = None
    greeting: str = ""
    signature: str = ""
    created_at: datetime
    updated_at: datetime


class ToneInfo(StudioModel):
    id: str
    label: str
    description: str


class OutreachKindInfo(StudioModel):
    id: str
    label: str
    description: str
