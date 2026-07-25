"""Multi-provider LLM: per-provider keys + active provider/model

Revision ID: e7b2c1f4a903
Revises: d4f1a7c93b21
Create Date: 2026-07-24
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "e7b2c1f4a903"
down_revision: str | None = "d4f1a7c93b21"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("encrypted_anthropic_key", sa.String(length=500), nullable=True))
    op.add_column("users", sa.Column("encrypted_openai_key", sa.String(length=500), nullable=True))
    op.add_column(
        "users",
        sa.Column("llm_provider", sa.String(length=20), server_default="gemini", nullable=False),
    )
    op.add_column("users", sa.Column("llm_model", sa.String(length=80), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "llm_model")
    op.drop_column("users", "llm_provider")
    op.drop_column("users", "encrypted_openai_key")
    op.drop_column("users", "encrypted_anthropic_key")
