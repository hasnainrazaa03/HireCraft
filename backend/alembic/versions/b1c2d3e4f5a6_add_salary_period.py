"""add salary_period to career_profiles

Revision ID: b1c2d3e4f5a6
Revises: 872d55830d95
Create Date: 2026-08-02 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b1c2d3e4f5a6"
down_revision: str | None = "872d55830d95"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "career_profiles",
        sa.Column("salary_period", sa.String(length=12), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("career_profiles", "salary_period")
