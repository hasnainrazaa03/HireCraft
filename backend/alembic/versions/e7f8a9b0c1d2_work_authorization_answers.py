"""Stored answers to the two work-authorization questions every form asks.

"Are you legally authorized to work in the United States?" and "Will you now or
in the future require sponsorship?" appear on nearly every US application. They
are consequential enough to be answered from a stored decision rather than
inferred from a free-text visa status, and they are genuinely independent —
someone on F-1 OPT is authorized to work now *and* will require sponsorship
later, so neither answer follows from the other.

Revision ID: e7f8a9b0c1d2
Revises: d6e7f8a9b0c1
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "e7f8a9b0c1d2"
down_revision = "d6e7f8a9b0c1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable with no default: "not answered yet" has to stay distinguishable
    # from "answered no". A default of false would silently tell employers the
    # candidate is not authorized to work.
    op.add_column("career_profiles", sa.Column("authorized_to_work", sa.Boolean()))
    op.add_column("career_profiles", sa.Column("requires_sponsorship", sa.Boolean()))


def downgrade() -> None:
    op.drop_column("career_profiles", "requires_sponsorship")
    op.drop_column("career_profiles", "authorized_to_work")
