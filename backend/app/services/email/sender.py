"""Transactional email delivery.

Two backends, chosen automatically:

* **Console** (when ``smtp_host`` is unset) — the email is logged, not sent.
  Local development and CI need no mail server, and no message can escape to a
  real inbox by accident.
* **SMTP** — a plain ``smtplib`` send over STARTTLS. Deliberately minimal; a
  hosted provider (Resend/Postmark/SES) is configured purely through the
  standard SMTP settings, so there is no provider SDK to pin or mock.

Sending is blocking, so callers on the request path dispatch it to Celery via
``app.workers.tasks`` rather than awaiting an SMTP round-trip inside a handler.
"""

from __future__ import annotations

import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


class EmailError(Exception):
    """Raised when an email cannot be sent by the active backend."""


@dataclass(frozen=True)
class Email:
    to: str
    subject: str
    html: str
    text: str


def _build_message(email: Email) -> EmailMessage:
    message = EmailMessage()
    message["Subject"] = email.subject
    # email_from may be either "Name <addr>" or a bare address.
    name, addr = parseaddr(settings.email_from)
    message["From"] = formataddr((name, addr)) if name else addr
    message["To"] = email.to
    message.set_content(email.text)
    message.add_alternative(email.html, subtype="html")
    return message


def _send_console(email: Email) -> None:
    logger.info(
        "email.console",
        to=email.to,
        subject=email.subject,
        note="SMTP not configured; email logged instead of sent.",
        preview=email.text[:400],
    )


def _send_smtp(email: Email) -> None:
    message = _build_message(email)
    try:
        with smtplib.SMTP(
            settings.smtp_host, settings.smtp_port, timeout=settings.smtp_timeout_seconds
        ) as server:
            server.ehlo()
            if settings.smtp_use_tls:
                server.starttls(context=ssl.create_default_context())
                server.ehlo()
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(message)
    except (smtplib.SMTPException, OSError) as exc:
        logger.error("email.smtp_failed", to=email.to, error=str(exc)[:300])
        raise EmailError(f"Could not send email to {email.to}: {exc}") from exc

    logger.info("email.sent", to=email.to, subject=email.subject)


def send_email(email: Email) -> None:
    """Send an email via the configured backend (console when SMTP is unset)."""
    if settings.smtp_host:
        _send_smtp(email)
    else:
        _send_console(email)
