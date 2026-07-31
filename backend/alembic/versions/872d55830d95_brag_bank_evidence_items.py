"""brag bank: evidence_items

Revision ID: 872d55830d95
Revises: f3a9d21c6b40
Create Date: 2026-07-31 03:36:26.685440
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '872d55830d95'
down_revision: str | None = 'f3a9d21c6b40'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # `kind` is a VARCHAR (native_enum=False), not a PostgreSQL enum type — the
    # convention every other enum column here follows. Values are validated by
    # the Python EvidenceKind enum on the way in.
    op.create_table(
        "evidence_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False, server_default="impact"),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("label", sa.String(length=160), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.text("now()"), nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            server_default=sa.text("now()"), nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_evidence_items_user_id", "evidence_items", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_evidence_items_user_id", table_name="evidence_items")
    op.drop_table("evidence_items")
