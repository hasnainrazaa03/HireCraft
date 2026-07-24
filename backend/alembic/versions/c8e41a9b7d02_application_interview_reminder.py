"""Application interview_at + reminder_at (tracker v2)

Revision ID: c8e41a9b7d02
Revises: 5fd6342d87c0
Create Date: 2026-07-24

The expanded TrackerStatus set needs no migration — the column is a plain
VARCHAR (native_enum=False), so the new stage strings fit as-is. Only the two
new datetime columns require a schema change.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "c8e41a9b7d02"
down_revision: str | None = "5fd6342d87c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "applications",
        sa.Column("interview_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "applications",
        sa.Column("reminder_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("applications", "reminder_at")
    op.drop_column("applications", "interview_at")
