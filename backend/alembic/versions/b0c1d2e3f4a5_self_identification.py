"""Store the voluntary self-identification answers, so they stop being retyped.

Every US application asks the same four EEOC questions, and the answers do not
change between them. Leaving them out meant the one part of the form that is
identical everywhere was the part the filler always skipped.

Stored as short canonical tokens rather than as any one employer's wording. The
options are phrased differently on every ATS — "I don't wish to answer" here,
"Decline To Self Identify" there — so the token is matched against whatever the
page actually offers at fill time. Storing one board's exact string would make
the value wrong everywhere else.

Null means unanswered, and stays unanswered: these questions are voluntary, and
a default would be the app inventing an answer about someone's race, gender,
disability or veteran status.

Revision ID: b0c1d2e3f4a5
Revises: a9b0c1d2e3f4
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "b0c1d2e3f4a5"
down_revision = "a9b0c1d2e3f4"
branch_labels = None
depends_on = None

# Short enough to hold a token, never a sentence.
_COLUMNS = (
    "gender",
    "race_ethnicity",
    "hispanic_latino",
    "veteran_status",
    "disability_status",
)


def upgrade() -> None:
    for name in _COLUMNS:
        op.add_column("career_profiles", sa.Column(name, sa.String(40)))


def downgrade() -> None:
    for name in _COLUMNS:
        op.drop_column("career_profiles", name)
