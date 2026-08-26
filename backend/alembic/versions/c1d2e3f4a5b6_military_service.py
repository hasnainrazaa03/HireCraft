"""Whether someone has served, kept apart from the EEOC veteran question.

They look like the same question and are not. "Protected veteran" is a legal
category with conditions attached — a service period, a campaign badge, a
discharge status — so a person can have served and still answer "not a protected
veteran" truthfully. Deriving one from the other would put a claim about
someone's military service on an application on the strength of an answer they
gave to a different question.

Forms ask both. Greenhouse's compliance block asks the EEOC one; Point72's
application asks "Have you served in the military?" a few fields above it.

Revision ID: c1d2e3f4a5b6
Revises: b0c1d2e3f4a5
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "c1d2e3f4a5b6"
down_revision = "b0c1d2e3f4a5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("career_profiles", sa.Column("military_service", sa.String(40)))


def downgrade() -> None:
    op.drop_column("career_profiles", "military_service")
