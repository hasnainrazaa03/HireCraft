"""add note_entries to applications (+ migrate the legacy single note)

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-08-08 00:00:00.000000
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: str | None = "d4e5f6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "applications",
        sa.Column(
            "note_entries",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    # Preserve any existing single note as the first timestamped entry.
    op.execute(
        """
        UPDATE applications
        SET note_entries = jsonb_build_array(jsonb_build_object(
            'id', gen_random_uuid()::text,
            'text', notes,
            'at', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"+00:00"'),
            'updated_at', NULL
        ))
        WHERE notes IS NOT NULL AND btrim(notes) <> ''
          AND (note_entries IS NULL OR jsonb_array_length(note_entries) = 0)
        """
    )


def downgrade() -> None:
    op.drop_column("applications", "note_entries")
