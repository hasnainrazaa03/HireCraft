"""Record which degree levels each posting will consider, and backfill it.

A master's candidate is ruled out by a posting restricted to undergraduates or
one requiring a doctorate — not by a posting that states a bachelor's as its
minimum, which a master's exceeds. Storing the classification lets the feed
filter on it without re-reading every description on every request.

Revision ID: b4c5d6e7f8a9
Revises: a3b4c5d6e7f8
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "b4c5d6e7f8a9"
down_revision = "a3b4c5d6e7f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.services.degrees import classify

    op.add_column(
        "scraped_jobs",
        sa.Column(
            "degree_level",
            sa.String(length=24),
            nullable=False,
            server_default="unspecified",
        ),
    )
    op.create_index("ix_scraped_jobs_degree_level", "scraped_jobs", ["degree_level"])

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, description FROM scraped_jobs WHERE description <> ''")
    ).fetchall()
    counts: dict[str, int] = {}
    for row in rows:
        level = classify(row.description or "").value
        counts[level] = counts.get(level, 0) + 1
        if level != "unspecified":
            conn.execute(
                sa.text("UPDATE scraped_jobs SET degree_level = :lvl WHERE id = :id"),
                {"lvl": level, "id": row.id},
            )
    print(f"[b4c5d6e7f8a9] classified {len(rows)} postings: {counts}")

    # The default only exists to backfill; new rows get their value from the
    # application, which classifies as it writes.
    op.alter_column("scraped_jobs", "degree_level", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_scraped_jobs_degree_level", table_name="scraped_jobs")
    op.drop_column("scraped_jobs", "degree_level")
