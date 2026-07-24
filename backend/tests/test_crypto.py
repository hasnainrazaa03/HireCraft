"""Encryption tests for at-rest secrets."""

from __future__ import annotations

import pytest

from app.core.crypto import DecryptionError, decrypt, encrypt


def test_roundtrip():
    secret = "AIzaSyExampleGeminiKey_abcd1234"
    ciphertext = encrypt(secret)
    assert ciphertext != secret
    assert decrypt(ciphertext) == secret


def test_ciphertext_is_not_predictable():
    # Fernet embeds a random IV, so encrypting the same value twice differs.
    assert encrypt("same") != encrypt("same")


def test_tampered_ciphertext_is_rejected():
    ciphertext = encrypt("secret")
    tampered = ciphertext[:-4] + ("AAAA" if ciphertext[-4:] != "AAAA" else "BBBB")
    with pytest.raises(DecryptionError):
        decrypt(tampered)


def test_garbage_is_rejected():
    with pytest.raises(DecryptionError):
        decrypt("not-valid-ciphertext")
