"""keep the original uploaded résumé file alongside the parsed profile

Revision ID: e1f2a3b4c5d6
Revises: d0e1f2a3b4c5
Create Date: 2026-08-23 16:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e1f2a3b4c5d6"
down_revision: str | None = "d0e1f2a3b4c5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("resume_profiles", sa.Column("source_filename", sa.String(length=255), nullable=True))
    op.add_column("resume_profiles", sa.Column("source_path", sa.String(length=500), nullable=True))
    op.add_column("resume_profiles", sa.Column("source_content_type", sa.String(length=120), nullable=True))
    op.add_column("resume_profiles", sa.Column("source_size_bytes", sa.Integer(), nullable=True))


def downgrade() -> None:
    for col in ("source_size_bytes", "source_content_type", "source_path", "source_filename"):
        op.drop_column("resume_profiles", col)
