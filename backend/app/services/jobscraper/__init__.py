"""Vendored job scraper: public-ATS fetchers, eligibility filters, and track scoring.

Ported from the standalone `job_scraper` tool so HireCraft can pull the same
postings (Greenhouse, Lever, Ashby, Workday, the Simplify lists, HN "who is
hiring") on a schedule. Only the fetch/filter/score logic came across — the CLI,
Excel writer, SQLite store and terminal report stayed behind, because HireCraft
persists to Postgres and renders its own job cards.

Kept close to the original so upstream fixes remain easy to port back in.
"""

from app.services.jobscraper.models import Job

__all__ = ["Job"]
