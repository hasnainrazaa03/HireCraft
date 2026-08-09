"""Application activity log — an append-only audit trail for the timeline.

Events are stored inline on ``Application.activity`` (a JSONB list) so there is no
join to fetch a history. Each entry is ``{kind, label, at, meta}``; ``kind`` drives
the icon in the UI and ``meta`` carries small extras (e.g. a status transition).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.models.application import Application

_MAX_EVENTS = 100


def log_event(
    application: Application, kind: str, label: str, meta: dict[str, Any] | None = None
) -> None:
    """Append an event. Reassigns the list so SQLAlchemy flags the JSON dirty."""
    events = list(application.activity or [])
    events.append(
        {
            "kind": kind,
            "label": label,
            "at": datetime.now(UTC).isoformat(),
            "meta": meta or {},
        }
    )
    application.activity = events[-_MAX_EVENTS:]
