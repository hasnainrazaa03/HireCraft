"""Standalone cover letters saved from the writing studio.

A studio-generated cover letter is otherwise ephemeral. Saving one persists its
paragraphs plus enough context — the résumé it was grounded in, the job text,
tone, and voice — to re-render, refine, or regenerate it later, and to optionally
attach it to an application ("generate first, link later").
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, JsonB, TimestampMixin


class SavedCoverLetter(Base, TimestampMixin):
    __tablename__ = "saved_cover_letters"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # Optional link to an application. SET NULL so deleting the application does
    # not delete a saved letter the candidate may still want.
    application_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("applications.id", ondelete="SET NULL"),
        index=True,
    )
    # Which résumé it was grounded in — needed to re-render and to refine/regenerate.
    resume_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("resume_profiles.id", ondelete="SET NULL"),
    )

    company: Mapped[str | None] = mapped_column(String(255))
    role: Mapped[str | None] = mapped_column(String(255))
    hiring_manager: Mapped[str | None] = mapped_column(String(255))
    tone: Mapped[str] = mapped_column(String(32), default="modern", nullable=False)
    used_voice: Mapped[bool] = mapped_column(default=False, nullable=False)

    paragraphs: Mapped[list[str]] = mapped_column(JsonB, default=list, nullable=False)
    job_text: Mapped[str | None] = mapped_column(Text)
    # The cover-letter guardrail record, so its flags stay visible after saving
    # (the studio otherwise discards it).
    guardrail_report: Mapped[dict[str, Any] | None] = mapped_column(JsonB)
