"""OAuth sign-in with Google and GitHub.

A provider is only usable when both its client id and secret are configured;
otherwise the routes report "not configured" and the frontend hides the button.
The account-linking step (`link_or_create_user`) is pure and unit-tested; the
network calls to the provider are isolated in `exchange_code` / `fetch_identity`
so they can be mocked or swapped without touching the linking logic.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import hash_password
from app.models.user import User


class OAuthError(Exception):
    """A recoverable failure talking to the provider or linking the account."""


@dataclass(frozen=True)
class ProviderConfig:
    name: str
    authorize_url: str
    token_url: str
    userinfo_url: str
    scopes: str


_PROVIDERS: dict[str, ProviderConfig] = {
    "google": ProviderConfig(
        name="google",
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        userinfo_url="https://openidconnect.googleapis.com/v1/userinfo",
        scopes="openid email profile",
    ),
    "github": ProviderConfig(
        name="github",
        authorize_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",
        userinfo_url="https://api.github.com/user",
        scopes="read:user user:email",
    ),
}


def _credentials(provider: str) -> tuple[str, str]:
    if provider == "google":
        return settings.google_client_id, settings.google_client_secret
    if provider == "github":
        return settings.github_client_id, settings.github_client_secret
    raise OAuthError(f"Unknown provider {provider!r}.")


def is_enabled(provider: str) -> bool:
    if provider not in _PROVIDERS:
        return False
    cid, secret = _credentials(provider)
    return bool(cid and secret)


def enabled_providers() -> list[str]:
    return [p for p in _PROVIDERS if is_enabled(p)]


def _config(provider: str) -> ProviderConfig:
    if provider not in _PROVIDERS:
        raise OAuthError(f"Unknown provider {provider!r}.")
    if not is_enabled(provider):
        raise OAuthError(f"{provider} sign-in is not configured on this server.")
    return _PROVIDERS[provider]


def redirect_uri(provider: str, api_base: str) -> str:
    base = settings.oauth_redirect_base or api_base
    return f"{base.rstrip('/')}/api/v1/auth/oauth/{provider}/callback"


def build_authorize_url(provider: str, api_base: str) -> tuple[str, str]:
    """Return (authorize_url, state). State is a CSRF token the caller stores."""
    config = _config(provider)
    cid, _ = _credentials(provider)
    state = secrets.token_urlsafe(24)
    params = {
        "client_id": cid,
        "redirect_uri": redirect_uri(provider, api_base),
        "response_type": "code",
        "scope": config.scopes,
        "state": state,
    }
    return f"{config.authorize_url}?{urlencode(params)}", state


def exchange_code(provider: str, code: str, api_base: str) -> str:
    """Exchange an authorization code for a provider access token."""
    config = _config(provider)
    cid, secret = _credentials(provider)
    data = {
        "client_id": cid,
        "client_secret": secret,
        "code": code,
        "redirect_uri": redirect_uri(provider, api_base),
        "grant_type": "authorization_code",
    }
    try:
        resp = httpx.post(
            config.token_url, data=data, headers={"Accept": "application/json"}, timeout=15
        )
        resp.raise_for_status()
        token = resp.json().get("access_token")
    except (httpx.HTTPError, ValueError) as exc:
        raise OAuthError(f"Could not complete {provider} sign-in.") from exc
    if not token:
        raise OAuthError(f"{provider} did not return an access token.")
    return token


@dataclass(frozen=True)
class Identity:
    email: str
    name: str | None


def _github_verified_email(headers: dict[str, str]) -> str | None:
    """GitHub's /user email carries no verification flag; /user/emails does.

    Only a verified address may be used. Anyone can put someone else's address
    on their own GitHub profile, so trusting an unverified one would let an
    attacker link into - and take over - the HireCraft account that owns it.
    """
    try:
        emails = httpx.get(
            "https://api.github.com/user/emails", headers=headers, timeout=15
        ).json()
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(emails, list):
        return None
    verified = [
        entry["email"]
        for entry in emails
        if isinstance(entry, dict) and entry.get("verified") and entry.get("email")
    ]
    primary = next(
        (
            entry["email"]
            for entry in emails
            if isinstance(entry, dict)
            and entry.get("verified")
            and entry.get("primary")
            and entry.get("email")
        ),
        None,
    )
    return primary or (verified[0] if verified else None)


def fetch_identity(provider: str, access_token: str) -> Identity:
    """Fetch the *verified* email + display name from the provider.

    Account linking keys on email, so an unverified address is an account
    takeover primitive, not a minor detail. Every path here requires the
    provider to have confirmed the address.
    """
    config = _config(provider)
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    try:
        resp = httpx.get(config.userinfo_url, headers=headers, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise OAuthError(f"Could not read your {provider} profile.") from exc

    name = data.get("name")
    if provider == "github":
        email = _github_verified_email(headers)
    else:
        # Google returns the OIDC `email_verified` claim; anything else is a
        # self-asserted address we must not act on.
        email = data.get("email") if data.get("email_verified") else None

    if not email:
        raise OAuthError(
            f"Your {provider} account has no verified email address. Verify it "
            f"with {provider} and try again, or sign in with a password."
        )
    return Identity(email=str(email).lower(), name=name)


def link_or_create_user(db: Session, identity: Identity) -> User:
    """Find the user by email or create one. OAuth-created accounts are verified
    (the provider confirmed the email) and get an unusable random password."""
    user = db.scalar(select(User).where(User.email == identity.email))
    if user is not None:
        if not user.is_verified:
            user.is_verified = True
        return user

    user = User(
        email=identity.email,
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        full_name=identity.name,
        is_verified=True,
    )
    db.add(user)
    db.flush()
    return user
