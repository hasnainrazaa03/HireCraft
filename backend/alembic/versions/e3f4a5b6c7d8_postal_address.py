"""The rest of a postal address: street lines and a postal code.

`location` holds "Los Angeles, CA", which answers a City box and a State box and
nothing else. Workday's Address section asks for four things, so Address Line 1
and Postal Code came back empty on a real form — and unlike the questions left
to the user on purpose, these were empty only because the app had nowhere to
keep them.

Nullable and unset, like everything else here. An address nobody has entered is
absent, not blank, and a form asking for one is then reported as still needing
an answer rather than filled with a guess.

Revision ID: e3f4a5b6c7d8
Revises: d2e3f4a5b6c7
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "e3f4a5b6c7d8"
down_revision = "d2e3f4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("career_profiles", sa.Column("address_line1", sa.String(length=200)))
    op.add_column("career_profiles", sa.Column("address_line2", sa.String(length=200)))
    op.add_column("career_profiles", sa.Column("postal_code", sa.String(length=20)))


def downgrade() -> None:
    op.drop_column("career_profiles", "postal_code")
    op.drop_column("career_profiles", "address_line2")
    op.drop_column("career_profiles", "address_line1")
