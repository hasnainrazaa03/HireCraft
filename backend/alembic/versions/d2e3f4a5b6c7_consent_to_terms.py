"""Whether to agree to an application's privacy and terms questions.

Every US application ends with one: a privacy notice, a data-processing consent,
a "I certify the above is accurate" acknowledgement. They are required, they are
always the same answer, and they were the last thing left unfilled on an
otherwise finished form.

Stored rather than assumed. Agreeing to something on a person's behalf is not a
default the app gets to pick — null leaves the question alone, exactly as the
self-identification answers do, and the value only ever comes from a decision
the user made in Career Profile.

Note this covers consent only. A question of *fact* dressed in agreement
language — a conviction, a termination, a non-compete — is not a consent
question and is not answered from this.

Revision ID: d2e3f4a5b6c7
Revises: c1d2e3f4a5b6
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "d2e3f4a5b6c7"
down_revision = "c1d2e3f4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("career_profiles", sa.Column("consent_to_terms", sa.Boolean()))


def downgrade() -> None:
    op.drop_column("career_profiles", "consent_to_terms")
