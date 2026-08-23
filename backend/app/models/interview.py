"""Saved interview questions (and their drafted STAR answers).

Generated questions were previously throwaway UI state: refresh the page and the
set — plus any answers drafted against it — was gone. Persisting them makes
interview prep resumable, and lets a question carry its answer's state so the UI
can offer "draft an answer" only where one is missing and "redraft" where the
stored one isn't good enough.

A question may be tied to an application (prep for that job) or stand alone
(custom prep). Deleting the application keeps the question — the prep is still
useful — so the FK is SET NULL, like saved cover letters.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, JsonB, TimestampMixin


class SavedInterviewQuestion(Base, TimestampMixin):
    __tablename__ = "saved_interview_questions"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    application_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("applications.id", ondelete="SET NULL"),
        index=True,
    )
    # The résumé the question was generated against — reused when drafting an
    # answer so the answer stays grounded in the same material.
    resume_profile_id: Mapped[uuid.UUID | None] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("resume_profiles.id", ondelete="SET NULL"),
    )

    category: Mapped[str] = mapped_column(String(32), default="general", nullable=False)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    why: Mapped[str] = mapped_column(Text, default="", nullable=False)
    tip: Mapped[str] = mapped_column(Text, default="", nullable=False)

    # Context for standalone (non-application) prep, so a saved set stays labeled.
    role: Mapped[str | None] = mapped_column(String(255))
    company: Mapped[str | None] = mapped_column(String(255))

    # The drafted STAR answer, or NULL while the question is unanswered. The UI
    # keys "Draft an answer" vs "Redraft" off exactly this.
    answer: Mapped[dict[str, Any] | None] = mapped_column(JsonB)
    answer_warnings: Mapped[list[str]] = mapped_column(JsonB, default=list, nullable=False)
    used_voice: Mapped[bool] = mapped_column(default=False, nullable=False)

    # Preserves the generated order within a set.
    order_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
