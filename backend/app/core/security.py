"""Password hashing and JWT issuance/verification."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import settings

# Argon2id with library defaults, which track current OWASP guidance.
_hasher = PasswordHasher()

TokenType = Literal["access", "refresh"]

MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 128


class TokenError(Exception):
    """Raised when a token is missing, malformed, expired, or the wrong type."""


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str) -> tuple[bool, str | None]:
    """Verify a password.

    Returns ``(is_valid, new_hash_or_none)``. The second element is set when the
    stored hash uses outdated parameters and should be transparently upgraded.
    """
    try:
        _hasher.verify(hashed, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False, None

    if _hasher.check_needs_rehash(hashed):
        return True, _hasher.hash(password)
    return True, None


def validate_password_strength(password: str) -> None:
    """Raise ValueError if the password is unacceptable."""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        # Long inputs are a cheap DoS against any KDF.
        raise ValueError(f"Password must be at most {MAX_PASSWORD_LENGTH} characters.")
    if password.lower() in _COMMON_PASSWORDS:
        raise ValueError("That password is too common. Choose something less guessable.")


_COMMON_PASSWORDS = frozenset(
    {
        "password", "password1", "password123", "12345678", "123456789", "1234567890",
        "qwertyuiop", "letmein123", "welcome123", "admin12345", "iloveyou1",
        "changeme123", "hirecraft1",
    }
)


def create_token(
    subject: str | uuid.UUID,
    token_type: TokenType = "access",
    *,
    extra_claims: dict[str, Any] | None = None,
) -> str:
    now = datetime.now(UTC)
    if token_type == "access":
        expires = now + timedelta(minutes=settings.access_token_ttl_minutes)
    else:
        expires = now + timedelta(days=settings.refresh_token_ttl_days)

    payload: dict[str, Any] = {
        "sub": str(subject),
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
        "type": token_type,
        "jti": uuid.uuid4().hex,
    }
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_token(token: str, expected_type: TokenType = "access") -> dict[str, Any]:
    """Decode and validate a JWT, enforcing its type."""
    try:
        payload = jwt.decode(
            token,
            settings.secret_key,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["exp", "sub", "type"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenError("Your session has expired. Please sign in again.") from exc
    except jwt.InvalidTokenError as exc:
        raise TokenError("Invalid authentication token.") from exc

    # Without this check a refresh token would be accepted as an access token.
    if payload.get("type") != expected_type:
        raise TokenError(
            f"Expected a {expected_type} token but received a {payload.get('type')!r} token."
        )
    return payload


def token_subject(token: str, expected_type: TokenType = "access") -> uuid.UUID:
    payload = decode_token(token, expected_type)
    try:
        return uuid.UUID(str(payload["sub"]))
    except (KeyError, ValueError) as exc:
        raise TokenError("Token subject is not a valid user id.") from exc


# --- extension key ----------------------------------------------------------
#
# A long-lived credential for the browser extension, which runs unattended and
# cannot refresh a short-lived access token.
#
# Hashed with SHA-256 rather than Argon2, deliberately. Argon2 is right for
# passwords because they are low-entropy and guessable; this key is 32 random
# bytes, so brute force is not the threat, and it is verified on every extension
# request — a deliberately slow hash there would be a self-inflicted denial of
# service. What matters is that the plaintext is never stored, and a fixed-length
# digest is what the indexed lookup needs.

_EXTENSION_KEY_BYTES = 32
EXTENSION_KEY_PREFIX = "hcx_"


def generate_extension_key() -> tuple[str, str]:
    """Return ``(plaintext, hash)``. The plaintext is shown once and not stored."""
    key = f"{EXTENSION_KEY_PREFIX}{secrets.token_urlsafe(_EXTENSION_KEY_BYTES)}"
    return key, hash_extension_key(key)


def hash_extension_key(key: str) -> str:
    return hashlib.sha256(key.strip().encode()).hexdigest()
