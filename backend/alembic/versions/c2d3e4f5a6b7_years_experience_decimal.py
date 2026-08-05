"""widen years_experience to allow fractional years

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-08-05 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c2d3e4f5a6b7"
down_revision: str | None = "b1c2d3e4f5a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Integer -> Numeric(4,1): existing whole-year values widen losslessly.
    op.alter_column(
        "career_profiles",
        "years_experience",
        existing_type=sa.Integer(),
        type_=sa.Numeric(4, 1),
        existing_nullable=True,
        postgresql_using="years_experience::numeric(4,1)",
    )


def downgrade() -> None:
    # Numeric -> Integer rounds any fractional years to the nearest whole number.
    op.alter_column(
        "career_profiles",
        "years_experience",
        existing_type=sa.Numeric(4, 1),
        type_=sa.Integer(),
        existing_nullable=True,
        postgresql_using="round(years_experience)::integer",
    )
