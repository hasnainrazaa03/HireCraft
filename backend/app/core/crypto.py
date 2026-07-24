"""Symmetric encryption for secrets stored at rest (e.g. a user's own API key).

Fernet (AES-128-CBC + HMAC) with a key derived from ``SECRET_KEY`` via HKDF, so
there is nothing extra to configure: rotating ``SECRET_KEY`` rotates the
encryption key too (and invalidates old ciphertexts, which for a
re-enterable API key is an acceptable trade).

A stored value is therefore useless without ``SECRET_KEY`` — a database leak
alone does not expose anyone's API key.
"""

from __future__ import annotations

import base64
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import settings


class DecryptionError(Exception):
    """Raised when ciphertext cannot be decrypted (wrong key or corruption)."""


@lru_cache
def _fernet() -> Fernet:
    derived = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"hirecraft.secret-encryption.v1",
        info=b"fernet",
    ).derive(settings.secret_key.encode())
    return Fernet(base64.urlsafe_b64encode(derived))


def encrypt(plaintext: str) -> str:
    """Encrypt a UTF-8 string, returning URL-safe base64 ciphertext."""
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except (InvalidToken, ValueError) as exc:
        raise DecryptionError("Could not decrypt stored secret.") from exc
