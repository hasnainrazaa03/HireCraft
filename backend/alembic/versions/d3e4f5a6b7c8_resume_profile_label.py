"""add label to resume_profiles (live-content version label)

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-08-06 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d3e4f5a6b7c8"
down_revision: str | None = "c2d3e4f5a6b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable: existing rows predate labels and stay NULL, so the history modal
    # simply omits a label line for them. New résumés get a label from creation
    # onward ("Imported résumé", "AI rewrite", "Restored from vN", …).
    op.add_column(
        "resume_profiles",
        sa.Column("label", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("resume_profiles", "label")
