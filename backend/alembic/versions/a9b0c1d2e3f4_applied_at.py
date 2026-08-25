"""Record when an application was actually submitted.

Distinct from created_at, which is when the row appeared. A job can sit in the
tracker for a week before it is sent, so "applied 3 days ago" has to mean the
sending — and the browser extension stamps this the moment it sees a submission
go through, rather than whenever someone remembers to record it.

Revision ID: a9b0c1d2e3f4
Revises: f8a9b0c1d2e3
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a9b0c1d2e3f4"
down_revision = "f8a9b0c1d2e3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("applications", sa.Column("applied_at", sa.DateTime(timezone=True)))
    # Backfill what can be known: a row already past the draft stage was applied
    # to at some point, and its last update is the closest honest approximation.
    # Rows still in a pre-application stage are left null rather than guessed at.
    op.execute(
        """
        UPDATE applications
           SET applied_at = updated_at
         WHERE applied_at IS NULL
           AND tracker_status NOT IN ('wishlist', 'saved', 'preparing', 'draft')
        """
    )


def downgrade() -> None:
    op.drop_column("applications", "applied_at")
