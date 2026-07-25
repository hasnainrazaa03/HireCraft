"""Global feature flags — admin-toggled switches.

Flags are keyed by a stable string; the DB stores only overrides, while the set
of known flags and their default state lives in code (``KNOWN_FLAGS``). Effective
state = default merged with any DB override, so a fresh database behaves sensibly
and a flag can be flipped from the admin panel without a deploy.
"""

from __future__ import annotations

from sqlalchemy import Boolean, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin

# key -> (default_enabled, description)
KNOWN_FLAGS: dict[str, tuple[bool, str]] = {
    "signups_enabled": (True, "Allow new account registration."),
    "job_search_enabled": (True, "Enable the external job-search feature."),
    "byo_keys_enabled": (True, "Let users bring their own LLM API keys."),
    "copilot_enabled": (True, "Enable the Résumé Copilot chat."),
}


class FeatureFlag(Base, TimestampMixin):
    __tablename__ = "feature_flags"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    description: Mapped[str | None] = mapped_column(Text)
