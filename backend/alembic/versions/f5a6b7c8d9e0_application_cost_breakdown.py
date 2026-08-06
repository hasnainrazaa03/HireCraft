"""add cost_breakdown to applications

Revision ID: f5a6b7c8d9e0
Revises: e4f5a6b7c8d9
Create Date: 2026-08-06 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f5a6b7c8d9e0"
down_revision: str | None = "e4f5a6b7c8d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "applications",
        sa.Column(
            "cost_breakdown",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    # Backfill existing rows: attribute their prior spend to the résumé category
    # so the Analytics breakdown isn't empty for applications tailored before this.
    op.execute(
        """
        UPDATE applications
        SET cost_breakdown = jsonb_build_object(
            'resume', jsonb_build_object(
                'input_tokens', total_input_tokens,
                'output_tokens', total_output_tokens,
                'cost_usd', total_cost_usd
            )
        )
        WHERE total_cost_usd > 0 OR total_input_tokens > 0
        """
    )


def downgrade() -> None:
    op.drop_column("applications", "cost_breakdown")
