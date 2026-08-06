"""Master resume ("source of truth") model."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
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

    # Chosen LaTeX template id (see services.latex.templates). Presentation only.
    template: Mapped[str] = mapped_column(String(20), default="modern", nullable=False)
    # Preference: auto-compact the render until it fits a single page. Applies to
    # this résumé's preview, exports, and its tailored applications.
    one_page: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Free-form tags for the résumé library ("SWE", "ML", "New Grad", …).
    tags: Mapped[list[Any]] = mapped_column(JsonB, default=list, nullable=False)
    # Monotonic version counter; the latest saved content is this number, and
    # each prior content is preserved as a ResumeVersion snapshot.
    current_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # Label describing the *live* content ("Imported résumé", "AI rewrite",
    # "Restored from v1"). It travels with the content: when the live content is
    # snapshotted on the next edit, the snapshot inherits this label — so a
    # version's label always describes its own content, never the change that
    # replaced it.
    label: Mapped[str | None] = mapped_column(Text)

    user: Mapped[User] = relationship(back_populates="resume_profiles")
    applications: Mapped[list[Application]] = relationship(back_populates="resume_profile")
    versions: Mapped[list[ResumeVersion]] = relationship(
        back_populates="resume_profile",
        cascade="all, delete-orphan",
        order_by="ResumeVersion.version.desc()",
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<ResumeProfile {self.name}>"


class ResumeVersion(Base, TimestampMixin):
    """An immutable snapshot of a résumé's content at a point in time.

    A new snapshot is written *before* each edit, so the version list is the
    history you can roll back to. Rolling back writes the current content as a
    fresh snapshot first, so a rollback is itself reversible.
    """

    __tablename__ = "resume_versions"
    __table_args__ = (
        UniqueConstraint(
            "resume_profile_id", "version", name="uq_resume_version_profile_version"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    resume_profile_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("resume_profiles.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[dict[str, Any]] = mapped_column(JsonB, nullable=False)
    # Short human note, e.g. "before AI rewrite" or "restored v3".
    label: Mapped[str | None] = mapped_column(Text)

    resume_profile: Mapped[ResumeProfile] = relationship(back_populates="versions")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<ResumeVersion v{self.version} of {self.resume_profile_id}>"
