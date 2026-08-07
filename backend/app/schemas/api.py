"""Request and response models for the HTTP API."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.models.application import PipelineStatus, TrackerStatus
from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.schemas.tailoring import DiffEntry, GuardrailReport


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


# --- Auth -------------------------------------------------------------------


class RegisterRequest(ApiModel):
    email: EmailStr
    password: Annotated[str, Field(min_length=10, max_length=128)]
    full_name: str | None = Field(default=None, max_length=255)


class LoginRequest(ApiModel):
    email: EmailStr
    password: Annotated[str, Field(min_length=1, max_length=128)]


class RefreshRequest(ApiModel):
    refresh_token: str


class TokenResponse(ApiModel):
    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class UserResponse(ApiModel):
    id: uuid.UUID
    email: EmailStr
    full_name: str | None
    is_verified: bool
    is_superuser: bool = False
    theme: str
    notification_prefs: dict[str, Any]
    created_at: datetime


class VerifyEmailRequest(ApiModel):
    token: str = Field(min_length=8, max_length=200)


class ForgotPasswordRequest(ApiModel):
    email: EmailStr


class ResetPasswordRequest(ApiModel):
    token: str = Field(min_length=8, max_length=200)
    new_password: Annotated[str, Field(min_length=10, max_length=128)]


class ChangePasswordRequest(ApiModel):
    current_password: Annotated[str, Field(min_length=1, max_length=128)]
    new_password: Annotated[str, Field(min_length=10, max_length=128)]
    logout_other_sessions: bool = True


class ChangeEmailRequest(ApiModel):
    new_email: EmailStr
    password: Annotated[str, Field(min_length=1, max_length=128)]


class MessageResponse(ApiModel):
    message: str


class SessionResponse(ApiModel):
    id: uuid.UUID
    user_agent: str | None
    ip_address: str | None
    last_used_at: datetime
    created_at: datetime
    current: bool = False


class AccountSettingsUpdate(ApiModel):
    theme: Literal["dark", "light"] | None = None
    full_name: str | None = Field(default=None, max_length=255)
    notification_prefs: dict[str, bool] | None = None


# --- LLM provider / model settings ------------------------------------------


class LlmModelInfo(ApiModel):
    id: str
    label: str
    input_cost: float
    output_cost: float


class LlmProviderInfo(ApiModel):
    id: str
    label: str
    models: list[LlmModelInfo]
    has_key: bool
    # Whether the key is the user's own (BYO) vs a server-provided one.
    byo_key: bool
    key_hint: str | None = None


class LlmSettings(ApiModel):
    provider: str
    model: str
    providers: list[LlmProviderInfo]


class LlmSelectionUpdate(ApiModel):
    provider: str = Field(min_length=1, max_length=20)
    model: str | None = Field(default=None, max_length=80)


class LlmKeyUpdate(ApiModel):
    api_key: str = Field(min_length=8, max_length=400)


# --- Resume profiles --------------------------------------------------------


class ResumeProfileCreate(ApiModel):
    name: Annotated[str, Field(min_length=1, max_length=120)]
    content: MasterResume
    is_default: bool = False
    tags: list[str] = Field(default_factory=list, max_length=20)
    template: str | None = Field(default=None, max_length=20)
    one_page: bool = False
    # Label for the first version ("Imported résumé", "Original draft", …).
    version_label: str | None = Field(default=None, max_length=200)


class ResumeProfileUpdate(ApiModel):
    name: Annotated[str, Field(min_length=1, max_length=120)] | None = None
    content: MasterResume | None = None
    is_default: bool | None = None
    tags: list[str] | None = Field(default=None, max_length=20)
    template: str | None = Field(default=None, max_length=20)
    one_page: bool | None = None
    # Optional note attached to the snapshot this edit creates.
    version_label: str | None = Field(default=None, max_length=200)


class ResumeProfileResponse(ApiModel):
    id: uuid.UUID
    name: str
    content: dict[str, Any]
    is_default: bool
    tags: list[str]
    template: str
    one_page: bool
    current_version: int
    label: str | None
    created_at: datetime
    updated_at: datetime


class ResumeProfileSummary(ApiModel):
    id: uuid.UUID
    name: str
    is_default: bool
    tags: list[str]
    template: str
    one_page: bool
    current_version: int
    label: str | None
    updated_at: datetime


class TemplateInfo(ApiModel):
    id: str
    name: str
    description: str


class ResumeVersionSummary(ApiModel):
    id: uuid.UUID
    version: int
    label: str | None
    created_at: datetime


class ResumeVersionDetail(ResumeVersionSummary):
    content: dict[str, Any]


class ResumeParseResponse(ApiModel):
    """Result of parsing an uploaded file into a draft résumé (not yet saved)."""

    content: MasterResume
    cost_usd: float
    source_filename: str


class ResumeRewriteResponse(ApiModel):
    """Result of an AI rewrite pass — job-agnostic résumé improvement.

    The improved content is NOT saved; the client reviews the diff and scores,
    then saves it as a new version through the normal update endpoint.
    """

    content: MasterResume
    diff: list[DiffEntry]
    guardrail_report: GuardrailReport
    score_before: int
    score_after: int
    cost_usd: float


class ProfileIntroResponse(ApiModel):
    """AI-drafted headline + summary for the résumé builder's Basics section."""

    headline: str
    summary: str
    cost_usd: float


# --- Jobs -------------------------------------------------------------------


class JobCreate(ApiModel):
    """Either a URL to scrape or pasted description text."""

    url: str | None = Field(default=None, max_length=2000)
    text: str | None = Field(default=None, max_length=100_000)
    title: str | None = Field(default=None, max_length=255)
    company: str | None = Field(default=None, max_length=255)

    @model_validator(mode="after")
    def _require_one_source(self) -> JobCreate:
        if not self.url and not self.text:
            raise ValueError("Provide either a job URL or the job description text.")
        return self


class JobResponse(ApiModel):
    id: uuid.UUID
    url: str | None
    source: str | None
    title: str | None
    company: str | None
    location: str | None
    raw_text: str
    requirements: dict[str, Any] | None
    created_at: datetime


class JobSignalsResponse(ApiModel):
    """Deterministic pre-application read on the posting (red flags, etc.)."""

    red_flags: list[str] = Field(default_factory=list)
    geo_mismatch: str | None = None
    injection: list[str] = Field(default_factory=list)
    thin: bool = False
    word_count: int = 0


# --- Applications -----------------------------------------------------------


class ApplicationCreate(ApiModel):
    """Start a tailoring run. The job may be an existing id or a new source."""

    resume_profile_id: uuid.UUID | None = None
    job_id: uuid.UUID | None = None
    job: JobCreate | None = None
    include_cover_letter: bool = False
    notes: str | None = Field(default=None, max_length=4000)

    @model_validator(mode="after")
    def _require_a_job(self) -> ApplicationCreate:
        if not self.job_id and not self.job:
            raise ValueError("Provide either job_id or a job payload.")
        if self.job_id and self.job:
            raise ValueError("Provide job_id or job, not both.")
        return self


class ApplicationUpdate(ApiModel):
    tracker_status: TrackerStatus | None = None
    notes: str | None = Field(default=None, max_length=4000)
    # Nullable datetimes: the route uses ``model_fields_set`` to tell "not sent"
    # from "explicitly cleared", so passing null actually clears the field.
    interview_at: datetime | None = None
    reminder_at: datetime | None = None


class ArtifactResponse(ApiModel):
    id: uuid.UUID
    kind: str
    size_bytes: int
    content_type: str
    created_at: datetime


class ApplicationSummary(ApiModel):
    id: uuid.UUID
    pipeline_status: PipelineStatus
    tracker_status: TrackerStatus
    job_title: str | None = None
    company: str | None = None
    total_cost_usd: float
    interview_at: datetime | None = None
    reminder_at: datetime | None = None
    has_notes: bool = False
    created_at: datetime
    updated_at: datetime


class ScorecardMetric(ApiModel):
    key: str
    label: str
    score: int
    detail: str
    measured: bool = True  # False → couldn't be scored (e.g. no ATS keywords read)


class ScorecardSuggestion(ApiModel):
    """A specific, data-backed improvement the AI assistant can act on."""

    key: str
    title: str
    detail: str
    metric_key: str
    keywords: list[str] = Field(default_factory=list)
    instruction: str


class Scorecard(ApiModel):
    """Deterministic résumé-quality readout for a finished tailoring."""

    overall: int
    metrics: list[ScorecardMetric]
    suggestions: list[ScorecardSuggestion] = Field(default_factory=list)


class QualityBullet(ApiModel):
    """A single flagged bullet, for the per-metric fix panel."""

    id: str
    where: str
    text: str
    note: str


class QualityInspect(ApiModel):
    """The specific items behind each fixable metric."""

    keywords: list[str] = Field(default_factory=list)
    impact: list[QualityBullet] = Field(default_factory=list)
    verbs: list[QualityBullet] = Field(default_factory=list)
    conciseness: list[QualityBullet] = Field(default_factory=list)


class ApplicationDetail(ApiModel):
    id: uuid.UUID
    pipeline_status: PipelineStatus
    tracker_status: TrackerStatus
    celery_task_id: str | None
    error_message: str | None
    include_cover_letter: bool
    notes: str | None
    interview_at: datetime | None = None
    reminder_at: datetime | None = None
    tailored_resume: dict[str, Any] | None
    diff: list[dict[str, Any]] | None
    guardrail_report: dict[str, Any] | None
    scorecard: Scorecard | None = None
    job_signals: JobSignalsResponse | None = None
    total_input_tokens: int
    total_output_tokens: int
    total_cost_usd: float
    cost_breakdown: dict[str, Any] = Field(default_factory=dict)
    cover_letter: list[str] | None = None
    created_at: datetime
    updated_at: datetime
    job: JobResponse | None = None
    artifacts: list[ArtifactResponse] = Field(default_factory=list)


class CoverLetterRequest(ApiModel):
    """Generate or revise the cover letter. `feedback` triggers a grounded revision
    of the existing letter; `tone` optionally re-keys the register."""

    feedback: Annotated[str, Field(min_length=2, max_length=600)] | None = None
    tone: str | None = None


class AssistantReviseRequest(ApiModel):
    """Ask the grounded assistant to revise the tailored résumé."""

    instruction: Annotated[str, Field(min_length=3, max_length=600)]


class AssistantApplyRequest(ApiModel):
    """Apply a previously-proposed revision (already vetted, re-checked on apply)."""

    proposed: MasterResume


class AssistantProposal(ApiModel):
    """A previewed revision: the diff and the proposed résumé, not yet applied."""

    note: str
    diff: list[dict[str, Any]]
    proposed: dict[str, Any]
    blocked: list[str]


class OutreachRequest(ApiModel):
    """Draft a short outreach message for this application."""

    kind: str = "recruiter_email"
    recipient: str | None = Field(default=None, max_length=120)
    context: str | None = Field(default=None, max_length=1000)


class OutreachDraftResponse(ApiModel):
    subject: str
    body: str
    warnings: list[str]


class ApplicationStatusResponse(ApiModel):
    """Lightweight payload for polling a running job."""

    id: uuid.UUID
    pipeline_status: PipelineStatus
    error_message: str | None = None
    stage_message: str | None = None
    has_pdf: bool = False


# --- Analytics --------------------------------------------------------------


class UsagePoint(ApiModel):
    date: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    calls: int


class ModelUsage(ApiModel):
    model: str
    provider: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    calls: int


class ProviderUsage(ApiModel):
    provider: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    calls: int


class UsageSummary(ApiModel):
    total_cost_usd: float
    total_input_tokens: int
    total_output_tokens: int
    total_calls: int
    applications: int
    average_cost_per_application: float
    by_day: list[UsagePoint] = Field(default_factory=list)
    by_purpose: dict[str, float] = Field(default_factory=dict)
    by_model: list[ModelUsage] = Field(default_factory=list)
    by_provider: list[ProviderUsage] = Field(default_factory=list)


class TrackerStats(ApiModel):
    counts: dict[str, int] = Field(default_factory=dict)
    total: int = 0


# --- Dashboard analytics overview -------------------------------------------


class FunnelStats(ApiModel):
    """The job-search funnel and the rates derived from it.

    Rates are over *submitted* applications (anything past draft). Because the
    tracker stores only the current stage, `interviewing` and `offers` include
    everyone who reached that stage or beyond; a rejection still counts as a
    response.
    """

    total: int = 0
    submitted: int = 0
    active: int = 0  # still running through the pipeline
    applied: int = 0
    interviewing: int = 0
    offers: int = 0
    closed: int = 0  # rejected + ghosted + withdrawn
    response_rate: float = 0.0
    interview_rate: float = 0.0
    offer_rate: float = 0.0


class ContentStats(ApiModel):
    resume_count: int = 0
    resume_versions: int = 0
    tailored_resumes: int = 0
    cover_letters: int = 0
    avg_resume_score: int | None = None


class NamedCount(ApiModel):
    name: str
    count: int


class TimePoint(ApiModel):
    date: str
    count: int


class ActivityItem(ApiModel):
    kind: Literal["application", "completed", "offer", "resume_version"]
    title: str
    subtitle: str | None = None
    at: datetime
    ref: str | None = None  # id the UI can link to


class AnalyticsOverview(ApiModel):
    funnel: FunnelStats
    content: ContentStats
    applications_over_time: list[TimePoint] = Field(default_factory=list)
    top_companies: list[NamedCount] = Field(default_factory=list)
    top_titles: list[NamedCount] = Field(default_factory=list)
    top_keywords: list[NamedCount] = Field(default_factory=list)
    best_resume: NamedCount | None = None
    activity: list[ActivityItem] = Field(default_factory=list)


# --- Preview (synchronous, no persistence) ----------------------------------


class PreviewResponse(ApiModel):
    requirements: JobRequirements
    tailored_resume: MasterResume
    guardrail_report: GuardrailReport
    diff: list[DiffEntry]
    cost_usd: float


class ErrorResponse(ApiModel):
    detail: str
    code: str | None = None
