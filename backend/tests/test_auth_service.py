"""Auth service tests: session rotation/revocation and single-use tokens.

These run against an in-memory SQLite database so they need no Postgres. The
security-critical invariants live here: a rotated refresh token can't be
replayed, a revoked session is dead, and an email token is strictly single-use.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.pool import StaticPool

# Import every model so SQLite create_all sees the full metadata graph.
import app.models  # noqa: F401
from app.core.security import TokenError
from app.db.base import Base
from app.models.auth import AuthTokenPurpose
from app.models.user import User
from app.services import auth_service


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with OrmSession(engine) as session:
        yield session


@pytest.fixture
def user(db):
    u = User(email="jane@usc.edu", hashed_password="x", full_name="Jane")
    db.add(u)
    db.flush()
    return u


class TestSessions:
    def test_create_returns_tokens_and_persists_session(self, db, user):
        access, refresh, session = auth_service.create_session(db, user)
        assert access and refresh
        assert session.user_id == user.id
        assert session.refresh_token_hash

    def test_rotate_issues_new_refresh_and_invalidates_old(self, db, user):
        _, refresh1, session = auth_service.create_session(db, user)
        _, refresh2, _ = auth_service.rotate_session(db, refresh1)
        assert refresh2 != refresh1

        # Replaying the old refresh token must fail and kill the session.
        with pytest.raises(TokenError):
            auth_service.rotate_session(db, refresh1)
        assert session.revoked_at is not None

    def test_replayed_token_revokes_session_so_new_one_also_fails(self, db, user):
        _, refresh1, _ = auth_service.create_session(db, user)
        _, refresh2, _ = auth_service.rotate_session(db, refresh1)
        with pytest.raises(TokenError):
            auth_service.rotate_session(db, refresh1)  # triggers revoke
        # The legitimate current token is now dead too — a stolen-token replay
        # locks everyone out, which is the safe failure.
        with pytest.raises(TokenError):
            auth_service.rotate_session(db, refresh2)

    def test_revoked_session_cannot_refresh(self, db, user):
        _, refresh, session = auth_service.create_session(db, user)
        auth_service.revoke_session(db, user, session.id)
        with pytest.raises(TokenError):
            auth_service.rotate_session(db, refresh)

    def test_revoke_all_except_keeps_current(self, db, user):
        _, _, keep = auth_service.create_session(db, user)
        auth_service.create_session(db, user)
        auth_service.create_session(db, user)
        revoked = auth_service.revoke_all_sessions(db, user, except_id=keep.id)
        assert revoked == 2
        active = auth_service.active_sessions(db, user)
        assert [s.id for s in active] == [keep.id]

    def test_cannot_revoke_another_users_session(self, db, user):
        _, _, session = auth_service.create_session(db, user)
        other = User(email="bob@usc.edu", hashed_password="x")
        db.add(other)
        db.flush()
        assert auth_service.revoke_session(db, other, session.id) is False
        assert session.revoked_at is None


class TestAuthTokens:
    def test_issue_and_consume_once(self, db, user):
        raw = auth_service.issue_auth_token(
            db, user, AuthTokenPurpose.PASSWORD_RESET, ttl=timedelta(minutes=30)
        )
        token = auth_service.consume_auth_token(db, raw, AuthTokenPurpose.PASSWORD_RESET)
        assert token is not None
        # Second use is rejected.
        assert auth_service.consume_auth_token(
            db, raw, AuthTokenPurpose.PASSWORD_RESET
        ) is None

    def test_wrong_purpose_is_rejected(self, db, user):
        raw = auth_service.issue_auth_token(
            db, user, AuthTokenPurpose.PASSWORD_RESET, ttl=timedelta(minutes=30)
        )
        assert auth_service.consume_auth_token(
            db, raw, AuthTokenPurpose.EMAIL_VERIFY
        ) is None

    def test_expired_token_is_rejected(self, db, user):
        raw = auth_service.issue_auth_token(
            db, user, AuthTokenPurpose.EMAIL_VERIFY, ttl=timedelta(minutes=-1)
        )
        assert auth_service.consume_auth_token(
            db, raw, AuthTokenPurpose.EMAIL_VERIFY
        ) is None

    def test_issuing_a_new_token_invalidates_the_previous_one(self, db, user):
        old = auth_service.issue_auth_token(
            db, user, AuthTokenPurpose.PASSWORD_RESET, ttl=timedelta(minutes=30)
        )
        auth_service.issue_auth_token(
            db, user, AuthTokenPurpose.PASSWORD_RESET, ttl=timedelta(minutes=30)
        )
        # Only the newest reset link should work.
        assert auth_service.consume_auth_token(
            db, old, AuthTokenPurpose.PASSWORD_RESET
        ) is None

    def test_raw_token_is_never_stored(self, db, user):
        from app.models.auth import AuthToken

        raw = auth_service.issue_auth_token(
            db, user, AuthTokenPurpose.EMAIL_VERIFY, ttl=timedelta(hours=1)
        )
        stored = db.query(AuthToken).first()
        assert stored.token_hash != raw
        assert len(stored.token_hash) == 64  # sha-256 hex
