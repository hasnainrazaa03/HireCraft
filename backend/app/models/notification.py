"""In-app notifications.

Every notification is stored so the user has a durable feed; email delivery (when
the user's preferences allow) is a side channel queued separately. ``dedupe_key``
makes the scheduled reminders idempotent — the daily scan can run repeatedly
without producing duplicate "interview tomorrow" nudges, because a second insert
with the same (user, key) is skipped.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.models.user import User


class Notification(Base, TimestampMixin):
    __tablename__ = "notifications"
    __table_args__ = (
        # NULL dedupe_keys never collide, so ad-hoc notifications are unconstrained;
        # keyed reminders are unique per user.
        UniqueConstraint("user_id", "dedupe_key", name="uq_notification_dedupe"),
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
    # e.g. "interview_soon", "follow_up", "weekly_summary", "milestone".
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    # In-app link target, e.g. "/applications/<id>".
    link: Mapped[str | None] = mapped_column(String(300))
    dedupe_key: Mapped[str | None] = mapped_column(String(120))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="notifications")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Notification {self.id} {self.kind}>"
