"""Identity details an application form asks for that nothing else stored.

Filling a real Greenhouse form showed three gaps. The name on an employment
application is the candidate's legal name, which is not always the name they go
by; the address an employer should write to is not necessarily the one used to
sign in to HireCraft; and country is asked for as its own dropdown rather than
parsed out of a free-text location.

Revision ID: d6e7f8a9b0c1
Revises: c5d6e7f8a9b0
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "d6e7f8a9b0c1"
down_revision = "c5d6e7f8a9b0"
branch_labels = None
depends_on = None

COLUMNS = (
    ("country", sa.String(length=80)),
    ("legal_first_name", sa.String(length=120)),
    ("legal_last_name", sa.String(length=120)),
    ("preferred_name", sa.String(length=120)),
    ("contact_email", sa.String(length=320)),
)


def upgrade() -> None:
    for name, type_ in COLUMNS:
        op.add_column("career_profiles", sa.Column(name, type_))


def downgrade() -> None:
    for name, _ in reversed(COLUMNS):
        op.drop_column("career_profiles", name)
