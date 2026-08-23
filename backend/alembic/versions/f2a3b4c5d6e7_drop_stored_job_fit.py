"""drop the scrape-time fit columns from scraped_jobs

A score stored at scrape time is against whichever résumé was default then, so it
goes stale as soon as the user adds or edits one. The feed now scores live against
the résumé being viewed, which makes these columns dead — and worse than dead,
since anything still reading them would show a number for the wrong document.

Revision ID: f2a3b4c5d6e7
Revises: e1f2a3b4c5d6
Create Date: 2026-08-23 18:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f2a3b4c5d6e7"
down_revision: str | None = "e1f2a3b4c5d6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = ("match_score", "match_verdict", "interview_chance", "match_summary", "strengths", "gaps")


def upgrade() -> None:
    for name in _COLUMNS:
        op.drop_column("scraped_jobs", name)


def downgrade() -> None:
    op.add_column("scraped_jobs", sa.Column("match_score", sa.Integer(), nullable=True))
    op.add_column("scraped_jobs", sa.Column("match_verdict", sa.String(length=32), nullable=True))
    op.add_column("scraped_jobs", sa.Column("interview_chance", sa.String(length=16), nullable=True))
    op.add_column("scraped_jobs", sa.Column("match_summary", sa.Text(), nullable=False, server_default=""))
    op.add_column("scraped_jobs", sa.Column("strengths", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")))
    op.add_column("scraped_jobs", sa.Column("gaps", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")))
