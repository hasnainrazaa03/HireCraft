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


# --- Verified-email enforcement ---------------------------------------------
#
# Linking keys on email, so accepting an address the provider never confirmed is
# an account-takeover primitive: anyone can put someone else's address on their
# own provider profile and would inherit the HireCraft account that owns it.


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


@pytest.fixture
def configured(monkeypatch):
    from app.services import oauth as oauth_service

    for attr in (
        "google_client_id", "google_client_secret",
        "github_client_id", "github_client_secret",
    ):
        monkeypatch.setattr(oauth_service.settings, attr, "set")
    return oauth_service


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"email": "a@b.co", "email_verified": True}, "a@b.co"),
        ({"email": "a@b.co", "email_verified": False}, None),
        ({"email": "a@b.co"}, None),  # claim absent entirely
    ],
    ids=["verified", "unverified", "no-claim"],
)
def test_google_requires_email_verified_claim(configured, monkeypatch, payload, expected):
    monkeypatch.setattr(configured.httpx, "get", lambda *a, **k: _Resp(payload))
    if expected is None:
        with pytest.raises(OAuthError):
            configured.fetch_identity("google", "token")
    else:
        assert configured.fetch_identity("google", "token").email == expected


@pytest.mark.parametrize(
    ("emails", "expected"),
    [
        ([{"email": "v@b.co", "primary": True, "verified": True}], "v@b.co"),
        ([{"email": "u@b.co", "primary": True, "verified": False}], None),
        (
            [
                {"email": "u@b.co", "primary": True, "verified": False},
                {"email": "v@b.co", "primary": False, "verified": True},
            ],
            "v@b.co",
        ),
        ([], None),
    ],
    ids=["verified-primary", "unverified-primary", "prefers-verified", "none"],
)
def test_github_only_accepts_a_verified_address(configured, monkeypatch, emails, expected):
    def fake_get(url, **_kw):
        return _Resp({"name": "A"} if url.endswith("/user") else emails)

    monkeypatch.setattr(configured.httpx, "get", fake_get)
    if expected is None:
        with pytest.raises(OAuthError):
            configured.fetch_identity("github", "token")
    else:
        assert configured.fetch_identity("github", "token").email == expected


# --- CSRF state is bound to its provider ------------------------------------


def test_state_cookie_is_scoped_to_the_provider(configured):
    """A bare state is accepted by whichever callback receives it, so one minted
    at /google/authorize could be replayed against /github/callback."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app, follow_redirects=False) as client:
        authorize = client.get("/api/v1/auth/oauth/google/authorize")
        assert authorize.status_code == 307
        cookie = client.cookies["hc_oauth_state"]
        assert cookie.startswith("google:")

        state = cookie.split(":", 1)[1]
        # Same state, different provider's callback -> refused.
        wrong = client.get(
            f"/api/v1/auth/oauth/github/callback?code=c&state={state}"
        )
        assert "oauth_error=invalid_state" in wrong.headers["location"]
