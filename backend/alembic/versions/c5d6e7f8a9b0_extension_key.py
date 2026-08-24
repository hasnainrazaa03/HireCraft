"""Long-lived, single-purpose key for the browser extension.

The extension reaches the API unattended and cannot refresh a short-lived access
token, so it needs a credential that keeps working. Only the hash is stored, and
the key authorises the /extension routes rather than the account as a whole.

Revision ID: c5d6e7f8a9b0
Revises: b4c5d6e7f8a9
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "c5d6e7f8a9b0"
down_revision = "b4c5d6e7f8a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("extension_key_hash", sa.String(length=64)))
    op.add_column(
        "users",
        sa.Column("extension_key_created_at", sa.DateTime(timezone=True)),
    )
    # Looked up on every extension request, so it needs an index. Unique would be
    # wrong: the column is null for every user who hasn't issued a key, and while
    # Postgres allows repeated nulls under a unique index, the constraint would
    # claim a guarantee the application doesn't need.
    op.create_index("ix_users_extension_key_hash", "users", ["extension_key_hash"])


def downgrade() -> None:
    op.drop_index("ix_users_extension_key_hash", table_name="users")
    op.drop_column("users", "extension_key_created_at")
    op.drop_column("users", "extension_key_hash")
