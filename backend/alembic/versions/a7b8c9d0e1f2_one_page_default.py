"""one-page fit becomes the default for résumés

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-08-09 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a7b8c9d0e1f2"
down_revision: str | None = "f6a7b8c9d0e1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # One-page fit is now the default. Turn it on for existing résumés and change
    # the column default so new ones inherit it (the UI checkbox now *relaxes* it).
    op.execute("UPDATE resume_profiles SET one_page = true WHERE one_page = false")
    op.alter_column("resume_profiles", "one_page", server_default=sa.text("true"))


def downgrade() -> None:
    op.alter_column("resume_profiles", "one_page", server_default=sa.text("false"))
