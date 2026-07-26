"""Notification creation, delivery preferences, and reminder computation.

``notify`` is the single entry point: it writes the durable in-app record
(idempotently when a ``dedupe_key`` is given) and, when the user's preferences
allow, queues an email. ``due_reminders`` is a pure function over a user's
applications so the scheduled scan's logic is unit-testable without a broker.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.logging import get_logger
from app.models.application import Application, PipelineStatus, TrackerStatus
from app.models.notification import Notification
from app.models.user import DEFAULT_NOTIFICATION_PREFS, User

logger = get_logger(__name__)

# Which preference gates the email for each notification kind. Kinds absent here
# always create an in-app notification but never email.
_EMAIL_PREF: dict[str, str] = {
    "interview_soon": "application_reminders",
    "follow_up": "application_reminders",
    "stale_application": "application_reminders",
    "weekly_summary": "weekly_summary",
    "milestone": "product_emails",
}


def _wants_email(user: User, kind: str) -> bool:
    pref_key = _EMAIL_PREF.get(kind)
    if pref_key is None:
        return False
    prefs = {**DEFAULT_NOTIFICATION_PREFS, **(user.notification_prefs or {})}
    return bool(prefs.get(pref_key, False))


def notify(
    db: Session,
    user: User,
    *,
    kind: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    dedupe_key: str | None = None,
    email: bool = False,
) -> Notification | None:
    """Create an in-app notification (idempotent on dedupe_key) and optionally
    queue an email. Returns the notification, or ``None`` if it was a duplicate."""
    if dedupe_key is not None:
        existing = db.scalar(
            select(Notification.id).where(
                Notification.user_id == user.id,
                Notification.dedupe_key == dedupe_key,
            )
        )
        if existing is not None:
            return None

    notification = Notification(
        user_id=user.id, kind=kind, title=title, body=body, link=link, dedupe_key=dedupe_key
    )
    try:
        # A SAVEPOINT, not the whole transaction. The daily scan calls notify()
        # for every user and commits once at the end, so a plain db.rollback()
        # here would silently discard every reminder created for every user
        # scanned so far — and the loop would still report them as created.
        with db.begin_nested():
            db.add(notification)
            db.flush()
    except IntegrityError:
        # Lost a race on the unique (user, dedupe_key) — someone else inserted it.
        return None

    if email and _wants_email(user, kind):
        _queue_email(user, title, body, link)

    return notification


def _queue_email(user: User, title: str, body: str | None, link: str | None) -> None:
    """Best-effort: queue a notification email. Import is local so the service
    stays importable in test/CLI contexts without a Celery app."""
    try:
        from app.services.email.templates import notification_email
        from app.workers.tasks import send_email_task

        msg = notification_email(str(user.email), title, body or "", link)
        send_email_task.delay(to=msg.to, subject=msg.subject, html=msg.html, text=msg.text)
    except Exception:  # noqa: BLE001 - email is a side channel; never block the notification
        logger.warning("notifications.email_enqueue_failed", user_id=str(user.id))


# --- Reminder computation (pure) --------------------------------------------


@dataclass(frozen=True)
class Reminder:
    kind: str
    title: str
    body: str
    link: str | None
    dedupe_key: str


# Stages that mean "actively submitted, awaiting a response" — candidates for a
# nudge to follow up if they go quiet.
_AWAITING = {
    TrackerStatus.APPLIED,
    TrackerStatus.ASSESSMENT,
    TrackerStatus.SCREENING,
}
_STALE_DAYS = 10


def due_reminders(
    applications: list[Application], *, now: datetime | None = None
) -> list[Reminder]:
    """Which reminders are due for one user's applications, right now.

    Pure and deterministic: dedupe keys embed the date/window so the same nudge
    fires at most once even though the daily scan re-evaluates every application.
    """
    now = now or datetime.now(UTC)
    reminders: list[Reminder] = []

    for app in applications:
        label = _label(app)
        link = f"/applications/{app.id}"

        # Interview within the next 48 hours (and not already past).
        interview = _aware(app.interview_at)
        if interview and now <= interview <= now + timedelta(hours=48):
            reminders.append(
                Reminder(
                    kind="interview_soon",
                    title=f"Interview soon — {label}",
                    body=f"Your interview is on {_friendly(interview)}. Time to prep.",
                    link=link,
                    dedupe_key=f"interview_soon:{app.id}:{interview:%Y-%m-%d}",
                )
            )

        # An explicit follow-up reminder the user set has come due.
        remind = _aware(app.reminder_at)
        if remind and remind <= now:
            reminders.append(
                Reminder(
                    kind="follow_up",
                    title=f"Follow-up reminder — {label}",
                    body="You set a reminder to follow up on this application.",
                    link=link,
                    dedupe_key=f"follow_up:{app.id}:{remind:%Y-%m-%d}",
                )
            )

        # Submitted a while ago and still awaiting a response → suggest a nudge.
        if app.tracker_status in _AWAITING:
            updated = _aware(app.updated_at)
            if updated and updated <= now - timedelta(days=_STALE_DAYS):
                # Re-nudge at most once a week.
                week = now.isocalendar()
                reminders.append(
                    Reminder(
                        kind="stale_application",
                        title=f"Still waiting to hear back? — {label}",
                        body=f"No movement in {_STALE_DAYS}+ days. A polite follow-up can help.",
                        link=link,
                        dedupe_key=f"stale:{app.id}:{week.year}-W{week.week}",
                    )
                )

    return reminders


def _label(app: Application) -> str:
    if app.job and app.job.title:
        return app.job.title
    if app.job and app.job.company:
        return app.job.company
    return "an application"


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def _friendly(value: datetime) -> str:
    """'Mar 4 at 2:30 PM'. Built by hand because the obvious strftime spelling
    ('%-d', '%-I') is a glibc/BSD extension that raises on Windows."""
    hour = value.hour % 12 or 12
    return f"{value:%b} {value.day} at {hour}:{value:%M} {value:%p}"


def scan_user(db: Session, user: User) -> int:
    """Create any due reminders for one user. Returns how many were created."""
    applications = list(
        db.scalars(
            select(Application)
            .where(
                Application.user_id == user.id,
                Application.pipeline_status != PipelineStatus.FAILED,
            )
            .options(selectinload(Application.job))
        )
    )
    created = 0
    for reminder in due_reminders(applications):
        made = notify(
            db,
            user,
            kind=reminder.kind,
            title=reminder.title,
            body=reminder.body,
            link=reminder.link,
            dedupe_key=reminder.dedupe_key,
            email=True,
        )
        if made is not None:
            created += 1
    return created
