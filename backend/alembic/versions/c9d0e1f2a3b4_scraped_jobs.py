"""scraped job feed (postings pulled from public ATS boards on a schedule)

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-08-23 12:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c9d0e1f2a3b4"
down_revision: str | None = "b8c9d0e1f2a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "scraped_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("fingerprint", sa.String(length=32), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("company", sa.String(length=255), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("location", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("remote", sa.Boolean(), nullable=True),
        sa.Column("posted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("level", sa.String(length=32), nullable=False, server_default="unknown"),
        sa.Column("bucket", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("terms", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("sponsorship", sa.Text(), nullable=False, server_default=""),
        sa.Column("min_years", sa.Integer(), nullable=True),
        sa.Column("flags", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("track", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("track_resume", sa.String(length=120), nullable=False, server_default=""),
        sa.Column("track_score", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("track_scores", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("reasons", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("match_score", sa.Integer(), nullable=True),
        sa.Column("match_verdict", sa.String(length=32), nullable=True),
        sa.Column("interview_chance", sa.String(length=16), nullable=True),
        sa.Column("match_summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("strengths", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("gaps", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="new"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("user_id", "fingerprint", name="uq_scraped_job_user_fp"),
    )
    op.create_index("ix_scraped_jobs_user_id", "scraped_jobs", ["user_id"])
    op.create_index("ix_scraped_jobs_fingerprint", "scraped_jobs", ["fingerprint"])
    op.create_index("ix_scraped_jobs_source", "scraped_jobs", ["source"])
    op.create_index("ix_scraped_jobs_bucket", "scraped_jobs", ["bucket"])
    op.create_index("ix_scraped_jobs_active", "scraped_jobs", ["active"])
    op.create_index("ix_scraped_jobs_status", "scraped_jobs", ["status"])


def downgrade() -> None:
    for name in (
        "ix_scraped_jobs_status",
        "ix_scraped_jobs_active",
        "ix_scraped_jobs_bucket",
        "ix_scraped_jobs_source",
        "ix_scraped_jobs_fingerprint",
        "ix_scraped_jobs_user_id",
    ):
        op.drop_index(name, table_name="scraped_jobs")
    op.drop_table("scraped_jobs")
