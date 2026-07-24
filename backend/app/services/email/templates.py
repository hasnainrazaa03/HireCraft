"""HTML/text email templates.

Kept as inline-styled HTML (email clients ignore <style> blocks and external
CSS) in HireCraft's dark brand palette, each paired with a plain-text fallback.
A single ``_layout`` wraps the branded shell so every message looks consistent.
"""

from __future__ import annotations

from app.core.config import settings
from app.services.email.sender import Email

_BRAND = "#7C5CFF"
_BG = "#0A0B12"
_SURFACE = "#141824"
_TEXT = "#EDF0F8"
_MUTED = "#9AA2B8"


def _layout(*, heading: str, body_html: str, button: tuple[str, str] | None = None) -> str:
    button_html = ""
    if button:
        label, url = button
        button_html = f"""
        <tr><td style="padding:8px 0 4px;">
          <a href="{url}" style="display:inline-block;background:{_BRAND};color:#ffffff;
            text-decoration:none;font-weight:600;font-size:15px;padding:12px 28px;
            border-radius:12px;">{label}</a>
        </td></tr>
        <tr><td style="padding:12px 0 0;color:{_MUTED};font-size:12px;">
          If the button doesn't work, paste this link into your browser:<br>
          <a href="{url}" style="color:{_BRAND};word-break:break-all;">{url}</a>
        </td></tr>"""

    return f"""\
<!doctype html>
<html>
<body style="margin:0;padding:0;background:{_BG};font-family:-apple-system,Segoe UI,Inter,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:{_BG};padding:32px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
        <tr><td style="padding-bottom:24px;">
          <span style="font-size:20px;font-weight:600;color:{_TEXT};">🛠️ HireCraft</span>
        </td></tr>
        <tr><td style="background:{_SURFACE};border:1px solid rgba(255,255,255,0.07);
          border-radius:18px;padding:28px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="color:{_TEXT};font-size:20px;font-weight:600;padding-bottom:12px;">
              {heading}
            </td></tr>
            <tr><td style="color:{_MUTED};font-size:15px;line-height:1.6;padding-bottom:16px;">
              {body_html}
            </td></tr>
            {button_html}
          </table>
        </td></tr>
        <tr><td style="padding-top:20px;color:{_MUTED};font-size:12px;">
          You're receiving this because you have a HireCraft account.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def verification_email(to: str, token: str, name: str | None = None) -> Email:
    url = f"{settings.frontend_base_url}/verify-email?token={token}"
    hi = f"Hi {name}," if name else "Welcome to HireCraft,"
    html = _layout(
        heading="Confirm your email",
        body_html=(
            f"{hi} confirm your email address to finish setting up your account. "
            f"This link expires in {settings.email_verify_ttl_hours} hours."
        ),
        button=("Verify email", url),
    )
    text = (
        f"{hi}\n\nConfirm your email to finish setting up your HireCraft account:\n{url}\n\n"
        f"This link expires in {settings.email_verify_ttl_hours} hours.\n"
    )
    return Email(to=to, subject="Confirm your HireCraft email", html=html, text=text)


def password_reset_email(to: str, token: str, name: str | None = None) -> Email:
    url = f"{settings.frontend_base_url}/reset-password?token={token}"
    hi = f"Hi {name}," if name else "Hi,"
    html = _layout(
        heading="Reset your password",
        body_html=(
            f"{hi} we received a request to reset your HireCraft password. This link "
            f"expires in {settings.password_reset_ttl_minutes} minutes. If you didn't "
            f"ask for this, you can safely ignore this email."
        ),
        button=("Reset password", url),
    )
    text = (
        f"{hi}\n\nReset your HireCraft password:\n{url}\n\n"
        f"This link expires in {settings.password_reset_ttl_minutes} minutes. "
        f"If you didn't request it, ignore this email.\n"
    )
    return Email(to=to, subject="Reset your HireCraft password", html=html, text=text)


def notification_email(to: str, title: str, body: str, link: str | None = None) -> Email:
    """A generic notification/reminder email (follow-ups, interview nudges,
    the weekly summary). The link, when present, deep-links into the app."""
    url = f"{settings.frontend_base_url}{link}" if link else settings.frontend_base_url
    html = _layout(
        heading=title,
        body_html=body or "You have a new update in HireCraft.",
        button=("Open HireCraft", url),
    )
    text = f"{title}\n\n{body}\n\n{url}\n"
    return Email(to=to, subject=f"HireCraft — {title}", html=html, text=text)
