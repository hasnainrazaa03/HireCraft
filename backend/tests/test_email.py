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


class TestUntrustedContentIsEscaped:
    """Names and notification titles are user-influenced — a title is built from
    a job title that came off a scraped posting — and they land in an HTML
    template, so they have to be escaped on the way in."""

    def test_notification_title_and_body_are_escaped(self):
        from app.services.email.templates import notification_email

        message = notification_email(
            "u@x.co", '<img src=x onerror="alert(1)">Interview', "<b>hi</b>", "/a/1"
        )
        assert "<img src=x onerror=" not in message.html
        assert "&lt;img src=x onerror=" in message.html
        assert "<b>hi</b>" not in message.html

    @pytest.mark.parametrize("build", [verification_email, password_reset_email])
    def test_display_name_cannot_inject_markup(self, build):
        message = build("u@x.co", "token", "</a><script>alert(1)</script>")
        assert "<script>" not in message.html

    def test_ordinary_text_still_reads_naturally(self):
        from app.services.email.templates import notification_email

        message = notification_email("u@x.co", "Interview — Acme & Co", "On Mar 4.", None)
        # Escaped in the HTML part, untouched in the plain-text alternative.
        assert "Acme &amp; Co" in message.html
        assert "Acme & Co" in message.text

    def test_a_newline_in_a_title_cannot_smuggle_a_header(self):
        import email as email_lib

        from app.services.email.sender import _build_message
        from app.services.email.templates import notification_email

        built = notification_email("u@x.co", "Hi\r\nBcc: attacker@evil.co", "b", None)
        parsed = email_lib.message_from_string(_build_message(built).as_string())
        assert parsed["Bcc"] is None
        assert set(parsed.keys()) == {"Subject", "From", "To", "MIME-Version", "Content-Type"}
