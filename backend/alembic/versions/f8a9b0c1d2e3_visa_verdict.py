"""Record what each posting says about sponsoring a work visa.

For a candidate on a student visa this is the most consequential fact about a
posting after the role itself: nearly two in five described postings in the feed
require citizenship, a clearance, or explicitly refuse sponsorship, and applying
to one of those is time that cannot succeed.

Revision ID: f8a9b0c1d2e3
Revises: e7f8a9b0c1d2
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "f8a9b0c1d2e3"
down_revision = "e7f8a9b0c1d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.services.sponsorship import classify

    op.add_column(
        "scraped_jobs",
        sa.Column("visa_verdict", sa.String(length=24), nullable=False, server_default="unstated"),
    )
    op.create_index("ix_scraped_jobs_visa_verdict", "scraped_jobs", ["visa_verdict"])

    conn = op.get_bind()
    rows = conn.execute(
        sa.text("SELECT id, description FROM scraped_jobs WHERE description <> ''")
    ).fetchall()
    counts: dict[str, int] = {}
    for row in rows:
        verdict = classify(row.description or "").value
        counts[verdict] = counts.get(verdict, 0) + 1
        if verdict != "unstated":
            conn.execute(
                sa.text("UPDATE scraped_jobs SET visa_verdict = :v WHERE id = :id"),
                {"v": verdict, "id": row.id},
            )
    print(f"[f8a9b0c1d2e3] classified {len(rows)} postings: {counts}")

    # The default exists only for the backfill; new rows are classified by the
    # application as they are written.
    op.alter_column("scraped_jobs", "visa_verdict", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_scraped_jobs_visa_verdict", table_name="scraped_jobs")
    op.drop_column("scraped_jobs", "visa_verdict")
