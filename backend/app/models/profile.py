"""Career profile: reusable, structured career info, one per user.

Distinct from a résumé. A résumé is a document tailored per application; the
career profile is the durable "about me" — contact links, work authorization,
and job-search preferences — that seeds new résumés and, later, powers job
matching and recruiter outreach.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, JsonB, TimestampMixin

if TYPE_CHECKING:
    from app.models.user import User


class CareerProfile(Base, TimestampMixin):
    __tablename__ = "career_profiles"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # One profile per user; unique so the lazy get-or-create can't duplicate.
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        index=True,
        nullable=False,
    )

    headline: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(40))
    location: Mapped[str | None] = mapped_column(String(180))

    linkedin_url: Mapped[str | None] = mapped_column(String(500))
    github_url: Mapped[str | None] = mapped_column(String(500))
    portfolio_url: Mapped[str | None] = mapped_column(String(500))
    website_url: Mapped[str | None] = mapped_column(String(500))

    work_authorization: Mapped[str | None] = mapped_column(String(120))
    visa_status: Mapped[str | None] = mapped_column(String(120))
    years_experience: Mapped[int | None] = mapped_column(Integer)

    # Free-form preference lists, stored as JSON arrays of strings.
    preferred_roles: Mapped[list[Any]] = mapped_column(JsonB, default=list, nullable=False)
    preferred_industries: Mapped[list[Any]] = mapped_column(JsonB, default=list, nullable=False)
    preferred_locations: Mapped[list[Any]] = mapped_column(JsonB, default=list, nullable=False)

    salary_min: Mapped[int | None] = mapped_column(Integer)
    salary_max: Mapped[int | None] = mapped_column(Integer)
    salary_currency: Mapped[str] = mapped_column(String(3), default="USD", nullable=False)
    # How the salary range is expressed: hourly / weekly / monthly / yearly.
    salary_period: Mapped[str | None] = mapped_column(String(12))

    # remote / hybrid / onsite / flexible
    work_arrangement: Mapped[str | None] = mapped_column(String(20))
    open_to_relocation: Mapped[bool] = mapped_column(default=False, nullable=False)

    user: Mapped[User] = relationship(back_populates="career_profile")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<CareerProfile user={self.user_id}>"
