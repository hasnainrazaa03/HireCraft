"""Brag bank: supplemental, true evidence about the candidate's work.

The tailoring engine can only reframe what it knows. A résumé bullet is a
compressed summary; the real scope, scale, and outcome behind it usually lives in
the candidate's head. Evidence items are those grounded facts — captured once,
reused across every tailoring run — that widen the pool of things the engine may
honestly draw on.

Crucially, evidence text becomes part of the guardrail *provenance*: a number or
tool that appears here is treated as real (the candidate vouched for it), so the
optimizer may surface it without being flagged as fabrication. That is how the
platform gives "leeway to sell yourself" without inventing anything — the leeway
is bounded by what the candidate has actually attested to.
"""

from __future__ import annotations

import enum
import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Enum as SAEnum
from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.models.user import User


class EvidenceKind(str, enum.Enum):
    """What sort of fact this is — used to prompt the user and to weight it."""

    IMPACT = "impact"  # a quantified or concrete outcome
    SCOPE = "scope"  # scale/size: users, data, team, budget, geography
    SKILL = "skill"  # a tool/technology/method genuinely used
    ACHIEVEMENT = "achievement"  # award, recognition, "first to…"
    CONTEXT = "context"  # situation/constraint that makes the work impressive
    OTHER = "other"


class EvidenceItem(Base, TimestampMixin):
    """One grounded fact the candidate attests to, optionally tied to a role."""

    __tablename__ = "evidence_items"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    # native_enum=False → stored as a VARCHAR of the enum *value* ("impact"),
    # matching every other enum column in this codebase.
    kind: Mapped[EvidenceKind] = mapped_column(
        SAEnum(EvidenceKind, name="evidence_kind", native_enum=False, length=16),
        default=EvidenceKind.IMPACT,
        nullable=False,
    )
    # The fact itself, in the candidate's words.
    text: Mapped[str] = mapped_column(Text, nullable=False)
    # Optional free-text tag linking it to a role/company/project ("Deloitte",
    # "Prana.ai", "grad school"), so tailoring can attach it to the right entry.
    label: Mapped[str | None] = mapped_column(String(160))

    user: Mapped[User] = relationship(back_populates="evidence_items")
