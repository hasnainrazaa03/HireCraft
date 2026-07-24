"""User account model."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, JsonB, TimestampMixin

if TYPE_CHECKING:
    from app.models.application import Application
    from app.models.auth import AuthToken, Session
    from app.models.job import Job
    from app.models.profile import CareerProfile
    from app.models.resume import ResumeProfile
    from app.models.writing import WritingProfile


DEFAULT_NOTIFICATION_PREFS: dict[str, bool] = {
    "product_emails": True,
    "application_reminders": True,
    "weekly_summary": True,
}


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str | None] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Email verification. An account can use the app before verifying; features
    # that need a confirmed address check this flag rather than gating login.
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Optional bring-your-own Gemini key, encrypted at rest (app.core.crypto).
    # When set, the user's tailoring runs bill their key instead of the system's.
    encrypted_gemini_key: Mapped[str | None] = mapped_column(String(500))

    # Account preferences.
    theme: Mapped[str] = mapped_column(String(10), default="dark", nullable=False)
    # JSONB on Postgres (production); JSON on SQLite so the unit tests, which run
    # against an in-memory SQLite DB, can compile the schema.
    notification_prefs: Mapped[dict[str, Any]] = mapped_column(
        JsonB,
        default=lambda: dict(DEFAULT_NOTIFICATION_PREFS),
        nullable=False,
    )

    resume_profiles: Mapped[list[ResumeProfile]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    jobs: Mapped[list[Job]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    applications: Mapped[list[Application]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    sessions: Mapped[list[Session]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    auth_tokens: Mapped[list[AuthToken]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    career_profile: Mapped[CareerProfile | None] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )
    writing_profile: Mapped[WritingProfile | None] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<User {self.email}>"
