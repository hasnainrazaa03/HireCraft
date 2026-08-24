"""Re-key scraped jobs on their URL, merging cross-source duplicates.

A posting was identified by a hash of company, title and location, which two
boards never spell identically: the same Roblox req arrived from Greenhouse as
"[2027] Software Engineer, Early Career" and from Simplify as "Software
Engineer - Early Career", and the same xAI req under the company names "xAI"
and "SpaceXAI". Each pair was stored twice.

This recomputes every row's fingerprint from its URL and collapses the rows
that turn out to be the same posting, keeping the one with the most content.

Revision ID: a3b4c5d6e7f8
Revises: f2a3b4c5d6e7
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a3b4c5d6e7f8"
down_revision = "f2a3b4c5d6e7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.services.jobfeed import posting_key

    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT id, user_id, fingerprint, url, "
            "       COALESCE(LENGTH(description), 0) AS body, "
            "       COALESCE(status, 'new') AS status, last_seen "
            "FROM scraped_jobs"
        )
    ).fetchall()

    # Group by the identity the application will use from now on.
    groups: dict[tuple[str, str], list] = {}
    for row in rows:
        key = posting_key(row.url or "", row.fingerprint)
        groups.setdefault((str(row.user_id), key), []).append(row)

    # A row the user has acted on outranks one they haven't; then the row with
    # the most description text, then the most recently seen. Deleting the row
    # someone had saved or applied to would lose their own work.
    engaged = {"saved", "applied", "interviewing"}

    def rank(row) -> tuple:
        return (row.status in engaged, row.body, row.last_seen or sa.null())

    removed = 0
    for (_user, key), members in groups.items():
        keeper = max(members, key=rank)
        for row in members:
            if row.id != keeper.id:
                conn.execute(
                    sa.text("DELETE FROM scraped_jobs WHERE id = :id"), {"id": row.id}
                )
                removed += 1
        if keeper.fingerprint != key:
            conn.execute(
                sa.text("UPDATE scraped_jobs SET fingerprint = :fp WHERE id = :id"),
                {"fp": key, "id": keeper.id},
            )
    print(f"[a3b4c5d6e7f8] merged {removed} duplicate postings across {len(groups)} keys")


def downgrade() -> None:
    # The old fingerprints were a hash of fields still present on each row, but
    # the rows merged away are gone; re-deriving the keys cannot bring them
    # back, so this only restores the previous scheme for what remains.
    from app.services.jobscraper.models import Job

    conn = op.get_bind()
    for row in conn.execute(
        sa.text("SELECT id, company, title, location FROM scraped_jobs")
    ).fetchall():
        job = Job(
            source="", company=row.company or "", title=row.title or "",
            url="", location=row.location or "",
        )
        conn.execute(
            sa.text("UPDATE scraped_jobs SET fingerprint = :fp WHERE id = :id"),
            {"fp": job.id, "id": row.id},
        )
