"""saved cover letters (standalone studio letters, optionally linked to an app)

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-08-09 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f6a7b8c9d0e1"
down_revision: str | None = "e5f6a7b8c9d0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "saved_cover_letters",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "application_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("applications.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "resume_profile_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("resume_profiles.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("company", sa.String(length=255), nullable=True),
        sa.Column("role", sa.String(length=255), nullable=True),
        sa.Column("hiring_manager", sa.String(length=255), nullable=True),
        sa.Column("tone", sa.String(length=32), nullable=False, server_default="modern"),
        sa.Column("used_voice", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "paragraphs",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("job_text", sa.Text(), nullable=True),
        sa.Column("guardrail_report", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_saved_cover_letters_user_id", "saved_cover_letters", ["user_id"])
    op.create_index(
        "ix_saved_cover_letters_application_id", "saved_cover_letters", ["application_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_saved_cover_letters_application_id", table_name="saved_cover_letters")
    op.drop_index("ix_saved_cover_letters_user_id", table_name="saved_cover_letters")
    op.drop_table("saved_cover_letters")
