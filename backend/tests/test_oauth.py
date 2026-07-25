"""OAuth account-linking + config-gating tests.

The network calls to providers are isolated elsewhere; what matters here is that
linking is correct (existing user reused and verified; new user created verified
with an unusable password) and that unconfigured providers are refused.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.core.security import hash_password, verify_password
from app.db.base import Base
from app.models.user import User
from app.services.oauth import (
    Identity,
    OAuthError,
    build_authorize_url,
    enabled_providers,
    is_enabled,
    link_or_create_user,
)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with OrmSession(engine) as session:
        yield session


def test_unconfigured_provider_is_disabled():
    # No client id/secret in the test env → nothing enabled.
    assert enabled_providers() == []
    assert not is_enabled("google")
    with pytest.raises(OAuthError):
        build_authorize_url("google", "http://api.test")


def test_unknown_provider_rejected():
    assert not is_enabled("myspace")


def test_link_creates_verified_user_with_unusable_password(db):
    user = link_or_create_user(db, Identity(email="new@usc.edu", name="New Person"))
    assert user.email == "new@usc.edu"
    assert user.full_name == "New Person"
    assert user.is_verified is True
    # The random password must not be guessable/empty.
    assert not verify_password("", user.hashed_password)[0]


def test_link_reuses_existing_user_and_verifies(db):
    existing = User(
        email="me@usc.edu", hashed_password=hash_password("realpassword123"),
        full_name="Me", is_verified=False,
    )
    db.add(existing)
    db.flush()

    linked = link_or_create_user(db, Identity(email="me@usc.edu", name="Me"))
    assert linked.id == existing.id  # same account, not a duplicate
    assert linked.is_verified is True  # OAuth confirms the email
    # Existing password is untouched — they can still log in with it.
    assert verify_password("realpassword123", linked.hashed_password)[0]
    # Only one user with that email.
    assert len(list(db.scalars(select(User).where(User.email == "me@usc.edu")))) == 1


def test_authorize_url_requires_config(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "google_client_id", "test-client")
    monkeypatch.setattr(settings, "google_client_secret", "test-secret")
    url, state = build_authorize_url("google", "http://api.test")
    assert "accounts.google.com" in url
    assert "client_id=test-client" in url
    assert "redirect_uri=" in url and "callback" in url
    assert len(state) > 10
