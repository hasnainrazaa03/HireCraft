"""Auth service: sessions and single-use email tokens.

Centralizes the security-sensitive logic so the route layer stays thin. Two
concerns live here:

* **Sessions** back the refresh token. Login mints a session; refresh validates
  and *rotates* it (a new refresh token each time, old hash discarded), which
  turns a stolen-then-reused refresh token into a detectable, self-limiting
  event. Access tokens remain stateless and short-lived.
* **AuthTokens** are single-use secrets for email verification and password
  reset. Only their hash is stored; the raw value lives only in the email.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.core.config import settings
from app.core.security import TokenError, create_token, decode_token
from app.models.auth import AuthToken, AuthTokenPurpose, Session
from app.models.user import User


def _hash(raw: str) -> str:
    """SHA-256 hex. Tokens are high-entropy, so a plain fast hash is correct
    here — unlike passwords, there is nothing to brute-force."""
    return hashlib.sha256(raw.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime) -> datetime:
    """Treat a stored datetime as UTC if the backend dropped its tzinfo.

    Postgres (timezone=True) returns aware datetimes; SQLite returns naive ones.
    Normalizing here keeps every expiry comparison correct regardless of the
    backend, instead of raising "can't compare offset-naive and offset-aware".
    """
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


# --- Sessions ---------------------------------------------------------------


def create_session(
    db: DbSession,
    user: User,
    *,
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> tuple[str, str, Session]:
    """Start a session and return ``(access_token, refresh_token, session)``.

    The refresh JWT's ``jti`` is the session id, so a presented refresh token
    resolves to exactly one server-side row that can be rotated or revoked.
    """
    session = Session(
        user_id=user.id,
        refresh_token_hash="",  # set below once we know the jti
        user_agent=(user_agent or "")[:400] or None,
        ip_address=(ip_address or "")[:64] or None,
        last_used_at=_now(),
        expires_at=_now() + timedelta(days=settings.refresh_token_ttl_days),
    )
    db.add(session)
    db.flush()  # assigns session.id

    claims = {"sid": str(session.id)}
    access = create_token(user.id, "access", extra_claims=claims)
    refresh = create_token(user.id, "refresh", extra_claims=claims)
    session.refresh_token_hash = _hash(refresh)
    return access, refresh, session


def rotate_session(
    db: DbSession, refresh_token: str
) -> tuple[str, str, Session]:
    """Validate a refresh token and rotate it, returning fresh tokens.

    Raises TokenError if the token is invalid, the session is unknown, revoked,
    expired, or the presented token does not match the stored hash (i.e. it was
    already rotated away — a replay).
    """
    payload = decode_token(refresh_token, "refresh")
    session_id = payload.get("sid")
    if not session_id:
        raise TokenError("Refresh token is not bound to a session.")

    session = db.get(Session, uuid.UUID(str(session_id)))
    if session is None or session.revoked_at is not None:
        raise TokenError("This session has been revoked. Please sign in again.")
    if _aware(session.expires_at) <= _now():
        raise TokenError("This session has expired. Please sign in again.")
    if session.refresh_token_hash != _hash(refresh_token):
        # A valid-looking token that no longer matches means it was already
        # rotated: treat as compromise and kill the session.
        session.revoked_at = _now()
        raise TokenError("This session is no longer valid. Please sign in again.")

    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise TokenError("Account is unavailable.")

    claims = {"sid": str(session.id)}
    access = create_token(user.id, "access", extra_claims=claims)
    new_refresh = create_token(user.id, "refresh", extra_claims=claims)
    session.refresh_token_hash = _hash(new_refresh)
    session.last_used_at = _now()
    return access, new_refresh, session


def revoke_session(db: DbSession, user: User, session_id: uuid.UUID) -> bool:
    session = db.get(Session, session_id)
    if session is None or session.user_id != user.id:
        return False
    if session.revoked_at is None:
        session.revoked_at = _now()
    return True


def revoke_all_sessions(db: DbSession, user: User, *, except_id: uuid.UUID | None = None) -> int:
    stmt = select(Session).where(
        Session.user_id == user.id, Session.revoked_at.is_(None)
    )
    count = 0
    for session in db.scalars(stmt):
        if except_id is not None and session.id == except_id:
            continue
        session.revoked_at = _now()
        count += 1
    return count


def active_sessions(db: DbSession, user: User) -> list[Session]:
    stmt = (
        select(Session)
        .where(
            Session.user_id == user.id,
            Session.revoked_at.is_(None),
            Session.expires_at > _now(),
        )
        .order_by(Session.last_used_at.desc())
    )
    return list(db.scalars(stmt))


# --- Single-use email tokens ------------------------------------------------


def issue_auth_token(
    db: DbSession,
    user: User,
    purpose: AuthTokenPurpose,
    *,
    ttl: timedelta,
    payload: str | None = None,
) -> str:
    """Create a single-use token for ``purpose`` and return the RAW value.

    Any existing unused token of the same purpose is invalidated first, so a
    user who requests two reset emails can only use the newest link.
    """
    for existing in db.scalars(
        select(AuthToken).where(
            AuthToken.user_id == user.id,
            AuthToken.purpose == purpose,
            AuthToken.used_at.is_(None),
        )
    ):
        existing.used_at = _now()

    raw = secrets.token_urlsafe(32)
    db.add(
        AuthToken(
            user_id=user.id,
            token_hash=_hash(raw),
            purpose=purpose,
            payload=payload,
            expires_at=_now() + ttl,
        )
    )
    return raw


def consume_auth_token(
    db: DbSession, raw_token: str, purpose: AuthTokenPurpose
) -> AuthToken | None:
    """Validate and burn a token. Returns the row on success, else None."""
    token = db.scalar(
        select(AuthToken).where(
            AuthToken.token_hash == _hash(raw_token),
            AuthToken.purpose == purpose,
        )
    )
    if token is None or token.used_at is not None or _aware(token.expires_at) <= _now():
        return None
    token.used_at = _now()
    return token
