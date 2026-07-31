"""Load a user's brag-bank evidence for the tailoring engine.

Returns plain lines the pipeline threads into two places: the optimizer prompt
(as attested material the model may draw on) and the guardrail provenance (so a
number or proper noun the candidate vouched for here is not treated as
fabrication). Kept tiny and dependency-light so both the request path and the
Celery worker can call it with an open session.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.evidence import EvidenceItem


def evidence_lines(db: Session, user_id: uuid.UUID) -> list[str]:
    """The candidate's evidence as human-readable lines, most recent first.

    Each line carries the role/project label so the model can attach the fact to
    the right entry: ``"Deloitte — processed 7,500+ creations…"``.
    """
    items = db.scalars(
        select(EvidenceItem)
        .where(EvidenceItem.user_id == user_id)
        .order_by(EvidenceItem.created_at.desc())
    )
    lines: list[str] = []
    for it in items:
        text = it.text.strip()
        if not text:
            continue
        lines.append(f"{it.label.strip()} — {text}" if it.label else text)
    return lines
