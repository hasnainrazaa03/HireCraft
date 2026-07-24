"""Email service tests.

The important guarantees: console mode never touches the network (so tests and
local dev can't accidentally send), and every template carries both an HTML and
a plain-text part with a working, correctly-scoped link.
"""

from __future__ import annotations

import pytest

from app.services.email.sender import Email, send_email
from app.services.email.templates import password_reset_email, verification_email


class TestConsoleMode:
    def test_console_send_does_not_raise_without_smtp(self, monkeypatch):
        # No SMTP host configured -> console backend, no network.
        from app.core import config

        monkeypatch.setattr(config.settings, "smtp_host", "", raising=False)
        send_email(Email(to="a@b.co", subject="Hi", html="<p>Hi</p>", text="Hi"))

    def test_smtp_backend_is_selected_when_host_set(self, monkeypatch):
        """With a host set, the SMTP path runs (and fails fast on a dead host)."""
        from app.core import config
        from app.services.email.sender import EmailError

        monkeypatch.setattr(config.settings, "smtp_host", "127.0.0.1", raising=False)
        monkeypatch.setattr(config.settings, "smtp_port", 1, raising=False)
        monkeypatch.setattr(config.settings, "smtp_timeout_seconds", 1, raising=False)
        with pytest.raises(EmailError):
            send_email(Email(to="a@b.co", subject="Hi", html="<p>Hi</p>", text="Hi"))


class TestTemplates:
    def test_verification_email_has_both_parts_and_link(self):
        email = verification_email("user@usc.edu", "tok-abc", "Jane")
        assert email.to == "user@usc.edu"
        assert "verify-email?token=tok-abc" in email.text
        assert "verify-email?token=tok-abc" in email.html
        assert "Jane" in email.text
        assert email.html.strip().startswith("<!doctype html>")

    def test_reset_email_scopes_link_to_reset_route(self):
        email = password_reset_email("user@usc.edu", "rst-xyz")
        assert "reset-password?token=rst-xyz" in email.text
        assert "reset-password?token=rst-xyz" in email.html
        # A reset token must never be sent to the verify route by mistake.
        assert "verify-email" not in email.text

    def test_templates_do_not_leak_the_raw_token_into_the_subject(self):
        email = verification_email("user@usc.edu", "secret-token", None)
        assert "secret-token" not in email.subject
