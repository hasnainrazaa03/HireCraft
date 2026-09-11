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
import re
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


#: A URL has to name *something* to identify a posting — a requisition number,
#: a UUID. Simplify records whatever page the user was on, and for some
#: employers that is Google's application dashboard or a careers landing page
#: ("careers?company=capgemitecP3"). Matching on those would make the next
#: application to the same employer look already tracked and silently skip it.
_NAMES_SOMETHING = re.compile(r"\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-", re.I)


def _posting_url(url: str) -> str:
    """The URL if it could identify one posting, else ""."""
    return url if url and _NAMES_SOMETHING.search(url) else ""


def _keys(url: str, company: str, title: str) -> list[str]:
    """How an export row is looked up in the tracker, strongest evidence first.

    The board's own posting id survives every trip between trackers; the URL
    survives most; the title is renamed often ("Generative AI Engineer" became
    "GenAI Engineer" between two exports of the same application).

    A row with a posting id is never matched on its title. Two postings can
    share "Software Engineer" at one company, and treating the second as
    already tracked would lose the application without a word.
    """
    keys = []
    identity = posting_identity(url) if url else ""
    if identity:
        keys.append(f"id:{identity}")
    if _posting_url(url):
        keys.append(f"url:{url}")
    if not identity:
        keys.append(f"role:{company.lower()}|{title.lower()}")
    return keys


def _index_keys(url: str, company: str, title: str) -> list[str]:
    """Every key a tracked row can be found under."""
    keys = []
    identity = posting_identity(url) if url else ""
    if identity:
        keys.append(f"id:{identity}")
    if _posting_url(url):
        keys.append(f"url:{url}")
    if company and title:
        keys.append(f"role:{company.lower()}|{title.lower()}")
    return keys


#: What the extension stores when it reads the title of the page *after*
#: pressing Apply rather than the posting: Eightfold's success page is titled
#: "Submit application for Software Engineering IC2", an iCIMS one "Emory
#: Careers". Kept narrow on purpose — "Software Engineer - Early Careers" is a
#: real title that happens to end in the same word.
_CHROME_TITLE = re.compile(
    r"^(?:submit(?:\s+an?)?\s+application\s+for|apply(?:\s+now)?\s+for|application\s+for)\b"
    r"|^[\w&.'-]+(?:\s+[\w&.'-]+)?\s+(?:careers?|jobs)$",
    re.I,
)

#: An employer name the extension took from a subdomain: "non-clinical-emory".
_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)+$")


def _looks_like_page_chrome(title: str | None) -> bool:
    return bool(_CHROME_TITLE.search((title or "").strip()))


def _looks_like_slug(company: str | None) -> bool:
    return bool(_SLUG.match((company or "").strip()))


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

        existing: dict[str, tuple[Job, Application]] = {}
        tracked: dict = {}
        for job, application in db.execute(
            select(Job, Application)
            .join(Application, Application.job_id == Job.id)
            .where(Job.user_id == user.id)
        ).all():
            tracked[application.id] = (job, application)
            for key in _index_keys(job.url or "", job.company or "", job.title or ""):
                existing.setdefault(key, (job, application))
        matched_ids: set = set()
        repaired: list[tuple[str, str, str]] = []

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
            status_on = _date(row.get("Status Date"))
            hit = next((existing[k] for k in _keys(url, company, title) if k in existing), None)
            found_job, found = hit if hit else (None, None)

            if found is not None:
                matched_ids.add(found.id)
                # The tracked row may be carrying page chrome for a title. The
                # export is the user's own record of what they applied to, so it
                # wins there — and only there; a real title is left alone even
                # when the export spells it differently.
                if _looks_like_page_chrome(found_job.title) or _looks_like_slug(found_job.company):
                    repaired.append((f"{found_job.company} | {found_job.title}", company, title))
                    if args.write:
                        if _looks_like_page_chrome(found_job.title):
                            found_job.title = title
                        if _looks_like_slug(found_job.company):
                            found_job.company = company
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
                            {
                                "from": found.tracker_status.value,
                                "to": stage.value,
                                # When it happened, not when the import ran: a
                                # rejection from Tuesday imported on Friday is
                                # still three days after applying.
                                **({"on": status_on.date().isoformat()} if status_on else {}),
                            },
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
            for key in _index_keys(url, company, title):
                existing.setdefault(key, (job, application))
            matched_ids.add(application.id)

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

        print(f"\nTitles repaired from page chrome ({len(repaired)}):")
        for was, company, title in repaired:
            print(f"  * {was[:52]:<52} -> {company} | {title}")

        # Reported, never deleted. A row can be missing from an export because
        # it was unsaved in Simplify, or because it was only ever tracked here;
        # which one it is is the user's call, not the importer's.
        missing = [
            (job, application)
            for app_id, (job, application) in tracked.items()
            if app_id not in matched_ids
        ]
        print(f"\nIn HireCraft but not in this export — left alone ({len(missing)}):")
        for job, application in missing:
            print(f"  ? {(job.company or '')[:24]:<24} {(job.title or '')[:52]:<52} {application.tracker_status.value}")

        if not args.write:
            db.rollback()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
