"""Postings pulled from public ATS boards by the scheduled scraper.

Distinct from ``Job``: a ``Job`` is a posting the user committed to (it belongs to
an application and is never re-fetched), whereas a ``ScrapedJob`` is a candidate
from the feed — discovered on a schedule, re-seen on later runs, and mostly never
applied to. Keeping them apart means the scraper can churn the feed freely without
touching the record of what the user actually applied for.

Rows accumulate: ``first_seen`` / ``last_seen`` track a posting's lifetime, and one
that stops appearing is marked inactive rather than deleted, so a job the user was
looking at doesn't silently vanish.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, JsonB, TimestampMixin


class ScrapedJob(Base, TimestampMixin):
    __tablename__ = "scraped_jobs"
    # The scraper's own content hash (company+title+location) — re-seeing a posting
    # updates the row instead of inserting a duplicate.
    __table_args__ = (UniqueConstraint("user_id", "fingerprint", name="uq_scraped_job_user_fp"),)

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    fingerprint: Mapped[str] = mapped_column(String(32), nullable=False, index=True)

    # --- posting -----------------------------------------------------------
    source: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    company: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    location: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    remote: Mapped[bool | None] = mapped_column(Boolean)
    posted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # --- scraper classification -------------------------------------------
    level: Mapped[str] = mapped_column(String(32), default="unknown", nullable=False)
    bucket: Mapped[str] = mapped_column(String(64), default="", nullable=False, index=True)
    terms: Mapped[list[str]] = mapped_column(JsonB, default=list, nullable=False)
    sponsorship: Mapped[str] = mapped_column(Text, default="", nullable=False)
    min_years: Mapped[int | None] = mapped_column(Integer)
    flags: Mapped[list[str]] = mapped_column(JsonB, default=list, nullable=False)

    # --- scraper scoring (which of the user's résumé tracks fits best) ------
    track: Mapped[str] = mapped_column(String(32), default="", nullable=False)
    track_resume: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    track_score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    track_scores: Mapped[dict[str, Any]] = mapped_column(JsonB, default=dict, nullable=False)
    reasons: Mapped[list[str]] = mapped_column(JsonB, default=list, nullable=False)

    # --- HireCraft's own deterministic résumé match ------------------------
    match_score: Mapped[int | None] = mapped_column(Integer)
    match_verdict: Mapped[str | None] = mapped_column(String(32))
    interview_chance: Mapped[str | None] = mapped_column(String(16))
    match_summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    strengths: Mapped[list[str]] = mapped_column(JsonB, default=list, nullable=False)
    gaps: Mapped[list[str]] = mapped_column(JsonB, default=list, nullable=False)

    # --- lifecycle ---------------------------------------------------------
    first_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)
    # new | seen | saved | applied | dismissed — the user's own triage.
    status: Mapped[str] = mapped_column(String(16), default="new", nullable=False, index=True)
