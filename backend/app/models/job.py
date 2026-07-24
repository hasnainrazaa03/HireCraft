"""Scraped job posting model."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.models.application import Application
    from app.models.user import User


class Job(Base, TimestampMixin):
    """A target job posting: the raw scrape plus LLM-extracted requirements."""

    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    url: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(String(80))
    title: Mapped[str | None] = mapped_column(String(255))
    company: Mapped[str | None] = mapped_column(String(255))
    location: Mapped[str | None] = mapped_column(String(255))

    # Cleaned plain text of the posting; the input to requirement extraction.
    raw_text: Mapped[str] = mapped_column(Text, nullable=False)

    # Structured output of the Requirement Extractor; see schemas.job.JobRequirements.
    requirements: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    user: Mapped[User] = relationship(back_populates="jobs")
    applications: Mapped[list[Application]] = relationship(
        back_populates="job", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Job {self.company or '?'} / {self.title or '?'}>"
