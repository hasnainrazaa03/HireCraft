"""Application model: one tailoring run against one job."""

from __future__ import annotations

import enum
import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import Enum as SAEnum
from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.models.job import Job
    from app.models.resume import ResumeProfile
    from app.models.user import User


class PipelineStatus(str, enum.Enum):
    """Where the generation pipeline currently is. Machine-owned."""

    PENDING = "pending"
    SCRAPING = "scraping"
    EXTRACTING = "extracting"
    OPTIMIZING = "optimizing"
    RENDERING = "rendering"
    COMPLETED = "completed"
    FAILED = "failed"


class TrackerStatus(str, enum.Enum):
    """Where the human is in the hiring process. User-owned."""

    DRAFT = "draft"
    APPLIED = "applied"
    SCREENING = "screening"
    INTERVIEWING = "interviewing"
    OFFER = "offer"
    REJECTED = "rejected"
    GHOSTED = "ghosted"
    WITHDRAWN = "withdrawn"


class ArtifactKind(str, enum.Enum):
    RESUME_TEX = "resume_tex"
    RESUME_PDF = "resume_pdf"
    COVER_LETTER_TEX = "cover_letter_tex"
    COVER_LETTER_PDF = "cover_letter_pdf"


class Application(Base, TimestampMixin):
    __tablename__ = "applications"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    job_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("jobs.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    resume_profile_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("resume_profiles.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
    )

    pipeline_status: Mapped[PipelineStatus] = mapped_column(
        SAEnum(PipelineStatus, name="pipeline_status", native_enum=False, length=20),
        default=PipelineStatus.PENDING,
        nullable=False,
        index=True,
    )
    tracker_status: Mapped[TrackerStatus] = mapped_column(
        SAEnum(TrackerStatus, name="tracker_status", native_enum=False, length=20),
        default=TrackerStatus.DRAFT,
        nullable=False,
        index=True,
    )

    celery_task_id: Mapped[str | None] = mapped_column(String(64), index=True)
    error_message: Mapped[str | None] = mapped_column(Text)

    # The tailored Master Resume JSON produced by the optimizer.
    tailored_resume: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # Field-level record of what changed vs. the master, for the diff view.
    diff: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
    # Guardrail findings; non-empty means something was rejected or repaired.
    guardrail_report: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    include_cover_letter: Mapped[bool] = mapped_column(default=False, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)

    # Denormalized cost rollup; the authoritative per-call rows live in llm_usage.
    total_input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_cost_usd: Mapped[float] = mapped_column(default=0.0, nullable=False)

    user: Mapped[User] = relationship(back_populates="applications")
    job: Mapped[Job] = relationship(back_populates="applications")
    resume_profile: Mapped[ResumeProfile] = relationship(back_populates="applications")
    artifacts: Mapped[list[ApplicationArtifact]] = relationship(
        back_populates="application",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Application {self.id} {self.pipeline_status.value}>"


class ApplicationArtifact(Base, TimestampMixin):
    """A generated file (``.tex`` / ``.pdf``) belonging to an application."""

    __tablename__ = "application_artifacts"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    application_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("applications.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    kind: Mapped[ArtifactKind] = mapped_column(
        SAEnum(ArtifactKind, name="artifact_kind", native_enum=False, length=24),
        nullable=False,
    )
    # Path relative to settings.artifacts_dir - never an absolute path, so the
    # storage root can move (or become an S3 prefix) without a data migration.
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)

    application: Mapped[Application] = relationship(back_populates="artifacts")
