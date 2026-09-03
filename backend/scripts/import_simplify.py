"""Import a Simplify tracked-jobs export into the HireCraft tracker.

Simplify was the tracker before this one, and a few hundred applications live
there. Retyping them is not a plan, and neither is losing them: an application
history is what the analytics, the "already applied" filter and the follow-up
reminders are all computed from.

Runs against the real database, so it is a dry run unless told otherwise, and it
prints exactly what it would do first.

    python -m scripts.import_simplify export.csv --email you@example.com
    python -m scripts.import_simplify export.csv --email you@example.com --write

Deliberately does **not** scrape the employer's site. The export already carries
the title, company and location, and fetching twenty postings to learn what is
in the CSV would be slow, fragile, and rude to the boards.
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import UTC, datetime

from sqlalchemy import select

from app.db.session import session_scope
from app.models.application import Application, PipelineStatus, TrackerStatus
from app.models.job import Job
from app.models.resume import ResumeProfile
from app.models.user import User
from app.services.activity import log_event
from app.services.jobfeed import posting_identity

# Simplify's vocabulary to ours. Its SAVED is a bookmark, not an application,
# and it maps to the stage of the same meaning rather than being dropped —
# a saved posting is still a decision the user made and wants to see.
STATUS = {
    "APPLIED": TrackerStatus.APPLIED,
    "REJECTED": TrackerStatus.REJECTED,
    "SAVED": TrackerStatus.SAVED,
    "INTERVIEWING": TrackerStatus.INTERVIEWING,
    "SCREENING": TrackerStatus.SCREENING,
    "OFFER": TrackerStatus.OFFER,
    "ACCEPTED": TrackerStatus.ACCEPTED,
    "GHOSTED": TrackerStatus.GHOSTED,
    "WITHDRAWN": TrackerStatus.WITHDRAWN,
}


def _clean(value: str | None) -> str:
    """Simplify writes "N/A" where a value is absent, not an empty cell."""
    text = (value or "").strip()
    return "" if text in {"", "N/A", "Unknown Location", "Unknown Company"} else text


def _date(value: str | None) -> datetime | None:
    text = _clean(value)
    if not text:
        return None
    try:
        return datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=UTC)
    except ValueError:
        return None


def _key(url: str, company: str, title: str) -> str:
    """How an export row is recognised as one already in the tracker.

    The same three-tier match the feed's applied filter uses, and for the same
    reason: one requisition reaches two trackers under two URLs and sometimes
    two spellings of the title, so the board's own posting id is the only thing
    that reliably survives the trip.
    """
    identity = posting_identity(url) if url else ""
    if identity:
        return f"id:{identity}"
    if url:
        return f"url:{url}"
    return f"role:{company.lower()}|{title.lower()}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path")
    parser.add_argument("--email", required=True, help="whose tracker to import into")
    parser.add_argument(
        "--archived",
        action="store_true",
        help="include rows Simplify has archived (skipped by default)",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="actually write; without this the run only reports what it would do",
    )
    args = parser.parse_args(argv)

    with open(args.csv_path, newline="", encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))

    with session_scope() as db:
        user = db.execute(select(User).where(User.email == args.email)).scalar_one_or_none()
        if user is None:
            print(f"No user with email {args.email}", file=sys.stderr)
            return 1

        # Every application needs a résumé, and the import is not the place to
        # choose one: these were submitted elsewhere, often with a résumé this
        # app never saw. The default stands in so the row exists and the history
        # is complete.
        resume = db.execute(
            select(ResumeProfile)
            .where(ResumeProfile.user_id == user.id)
            .order_by(ResumeProfile.is_default.desc(), ResumeProfile.created_at)
        ).scalars().first()
        if resume is None:
            print("This account has no résumé; an application cannot be created without one.", file=sys.stderr)
            return 1

        existing: dict[str, Application] = {}
        for job, application in db.execute(
            select(Job, Application)
            .join(Application, Application.job_id == Job.id)
            .where(Job.user_id == user.id)
        ).all():
            existing[_key(job.url or "", job.company or "", job.title or "")] = application

        created: list[tuple[str, str, str]] = []
        advanced: list[tuple[str, str, str, str]] = []
        skipped: list[tuple[str, str]] = []

        for row in rows:
            if not args.archived and (row.get("Archived") or "").strip().lower() == "yes":
                continue
            title = _clean(row.get("Job Title"))
            company = _clean(row.get("Company Name"))
            if not title or not company:
                skipped.append((title or "?", "no title or company"))
                continue
            raw_status = (row.get("Status") or "").strip().upper()
            stage = STATUS.get(raw_status)
            if stage is None:
                skipped.append((f"{company} — {title}", f"unknown status {raw_status!r}"))
                continue

            url = _clean(row.get("Job URL"))
            applied_at = _date(row.get("Applied Date"))
            key = _key(url, company, title)
            found = existing.get(key)

            if found is not None:
                # Already tracked. The export still has something to say if the
                # outcome moved on since — a rejection recorded in Simplify and
                # not here is the difference between an open application and a
                # closed one.
                if found.tracker_status != stage:
                    advanced.append((company, title, found.tracker_status.value, stage.value))
                    if args.write:
                        log_event(
                            found,
                            "status_changed",
                            f"Status → {stage.value.title()} (imported from Simplify)",
                            {"from": found.tracker_status.value, "to": stage.value},
                        )
                        found.tracker_status = stage
                        if applied_at and not found.applied_at:
                            found.applied_at = applied_at
                else:
                    skipped.append((f"{company} — {title}", "already tracked"))
                continue

            created.append((company, title, stage.value))
            if not args.write:
                continue

            job = Job(
                user_id=user.id,
                url=url or None,
                source="simplify",
                title=title,
                company=company,
                location=_clean(row.get("Location")) or None,
                # No description was exported and none is fetched, so the row
                # says so rather than pretending to hold the posting.
                raw_text=f"{title} at {company}. Imported from Simplify; posting text not captured.",
            )
            db.add(job)
            db.flush()

            application = Application(
                user_id=user.id,
                job_id=job.id,
                resume_profile_id=resume.id,
                pipeline_status=PipelineStatus.PENDING,
                tracker_status=stage,
                include_cover_letter=False,
                reach_mode=False,
                applied_at=applied_at,
                notes=_clean(row.get("Notes")) or None,
            )
            db.add(application)
            db.flush()
            log_event(application, "created", "Imported from Simplify")
            existing[key] = application

        print(f"{'WROTE' if args.write else 'DRY RUN'} — {args.email}\n")
        print(f"New applications ({len(created)}):")
        for company, title, stage in created:
            print(f"  + {company:<24} {title[:52]:<52} {stage}")
        print(f"\nStatus changes ({len(advanced)}):")
        for company, title, was, now in advanced:
            print(f"  ~ {company:<24} {title[:52]:<52} {was} -> {now}")
        print(f"\nUnchanged ({len(skipped)}):")
        for what, why in skipped:
            print(f"  . {what[:70]:<70} {why}")

        if not args.write:
            db.rollback()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
