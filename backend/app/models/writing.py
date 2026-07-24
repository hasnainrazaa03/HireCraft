"""Writing profile: the user's personal voice, learned from their own writing.

The user uploads samples (past cover letters, outreach emails, SOPs). An LLM
distills them into a compact, structured "voice" — tone, formality, vocabulary,
sentence rhythm, habits to keep and to avoid. Later phases feed that voice into
cover-letter and outreach generation so the output reads like the user, not like
generic AI. As always, the guardrails still apply to anything generated.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, JsonB, TimestampMixin

if TYPE_CHECKING:
    from app.models.user import User


class WritingSampleKind(str, enum.Enum):
    COVER_LETTER = "cover_letter"
    EMAIL = "email"
    SOP = "sop"
    OTHER = "other"


class WritingProfile(Base, TimestampMixin):
    """One per user: the extracted voice plus its source samples."""

    __tablename__ = "writing_profiles"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        index=True,
        nullable=False,
    )

    # Structured voice from app.schemas.writing.VoiceProfile; null until analyzed.
    voice: Mapped[dict[str, Any] | None] = mapped_column(JsonB)
    # When the voice was last (re)computed, so stale-vs-samples can be detected.
    analyzed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="writing_profile")
    samples: Mapped[list[WritingSample]] = relationship(
        back_populates="writing_profile",
        cascade="all, delete-orphan",
        order_by="WritingSample.created_at.desc()",
    )


class WritingSample(Base, TimestampMixin):
    __tablename__ = "writing_samples"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    writing_profile_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("writing_profiles.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    kind: Mapped[WritingSampleKind] = mapped_column(
        SAEnum(WritingSampleKind, name="writing_sample_kind", native_enum=False, length=16),
        default=WritingSampleKind.OTHER,
        nullable=False,
    )
    title: Mapped[str | None] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text, nullable=False)

    writing_profile: Mapped[WritingProfile] = relationship(back_populates="samples")
