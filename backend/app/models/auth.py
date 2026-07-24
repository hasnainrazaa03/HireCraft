"""Auth support models: refresh sessions and single-use email tokens.

Both store only a **hash** of their secret, never the secret itself. A database
leak therefore cannot be turned into a live session or a usable reset link — the
raw value exists only in the user's cookie/JWT or in the email that was sent.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.models.user import User


class Session(Base, TimestampMixin):
    """A refresh-token session, one per signed-in device.

    The refresh JWT carries this row's id as its ``jti``; the row stores a hash
    of the refresh token so it can be validated, rotated, and revoked. Access
    tokens stay stateless and short-lived — only the long-lived refresh side is
    session-backed, which is what makes "log out this device" and "log out
    everywhere" possible.
    """

    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # SHA-256 of the current refresh token. Rotated on every refresh.
    refresh_token_hash: Mapped[str] = mapped_column(String(64), index=True, nullable=False)

    user_agent: Mapped[str | None] = mapped_column(String(400))
    ip_address: Mapped[str | None] = mapped_column(String(64))

    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="sessions")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Session {self.id} user={self.user_id}>"


class AuthTokenPurpose(str, enum.Enum):
    EMAIL_VERIFY = "email_verify"
    PASSWORD_RESET = "password_reset"


class AuthToken(Base, TimestampMixin):
    """A single-use, hashed token for an out-of-band email flow.

    The raw token is emailed to the user; only its hash is stored. On use we
    hash the presented value, match it, check expiry, and stamp ``used_at`` so
    it can never be replayed. For email-change flows the pending new address
    rides along in ``payload``.
    """

    __tablename__ = "auth_tokens"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    purpose: Mapped[AuthTokenPurpose] = mapped_column(
        SAEnum(AuthTokenPurpose, name="auth_token_purpose", native_enum=False, length=20),
        nullable=False,
    )
    # Optional context, e.g. the pending new email for an email-change verify.
    payload: Mapped[str | None] = mapped_column(String(320))

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="auth_tokens")

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<AuthToken {self.purpose.value} user={self.user_id}>"
