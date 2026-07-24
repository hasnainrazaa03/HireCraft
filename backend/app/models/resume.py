"""Master resume ("source of truth") model."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, JsonB, TimestampMixin

if TYPE_CHECKING:
    from app.models.application import Application
    from app.models.user import User


class ResumeProfile(Base, TimestampMixin):
    """A user's master resume, stored as validated Master Resume JSON.

    The ``content`` column always conforms to ``app.schemas.resume.MasterResume``;
    it is validated at the API boundary before it ever reaches the database.
    """

    __tablename__ = "resume_profiles"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_resume_profile_user_name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    content: Mapped[dict[str, Any]] = mapped_column(JsonB, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    user: Mapped[User] = relationship(back_populates="resume_profiles")
    applications: Mapped[list[Application]] = relationship(back_populates="resume_profile")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<ResumeProfile {self.name}>"
