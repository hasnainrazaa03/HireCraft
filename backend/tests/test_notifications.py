"""Notification + reminder tests.

The scheduled scan runs repeatedly, so the two properties that matter are:
reminders fire when they're actually due, and the dedupe key makes re-runs a
no-op. Email delivery must also honour the user's preferences.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (register tables)
from app.db.base import Base
from app.models.application import Application, PipelineStatus, TrackerStatus
from app.models.job import Job
from app.models.notification import Notification
from app.models.resume import ResumeProfile
from app.models.user import User
from app.services.notifications import due_reminders, notify, scan_user
from tests.conftest import MASTER_RESUME_FIXTURE


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with OrmSession(engine) as session:
        yield session


@pytest.fixture
def user(db):
    u = User(email="notify@usc.edu", hashed_password="x")
    db.add(u)
    db.flush()
    return u


@pytest.fixture
def resume(db, user):
    p = ResumeProfile(user_id=user.id, name="M", content=MASTER_RESUME_FIXTURE)
    db.add(p)
    db.flush()
    return p


def _app(db, user, resume, *, tracker=TrackerStatus.APPLIED, interview_at=None,
         reminder_at=None, updated_at=None, title="Backend Engineer", company="Globex"):
    job = Job(user_id=user.id, raw_text="jd", title=title, company=company)
    db.add(job)
    db.flush()
    a = Application(
        user_id=user.id, job_id=job.id, resume_profile_id=resume.id,
        tracker_status=tracker, pipeline_status=PipelineStatus.COMPLETED,
        interview_at=interview_at, reminder_at=reminder_at,
    )
    db.add(a)
    db.flush()
    if updated_at is not None:
        a.updated_at = updated_at
        db.flush()
    return a


# --- notify() ---------------------------------------------------------------


def test_notify_creates_and_dedupes(db, user):
    first = notify(db, user, kind="follow_up", title="A", dedupe_key="k1")
    second = notify(db, user, kind="follow_up", title="A again", dedupe_key="k1")
    assert first is not None
    assert second is None  # deduped
    count = db.scalar(select(Notification.id).where(Notification.dedupe_key == "k1"))
    assert count is not None


def test_notify_without_dedupe_allows_duplicates(db, user):
    a = notify(db, user, kind="milestone", title="hi")
    b = notify(db, user, kind="milestone", title="hi")
    assert a is not None and b is not None


def test_email_respects_preferences(db, user, monkeypatch):
    sent: list = []
    import app.services.notifications as svc
    monkeypatch.setattr(svc, "_queue_email", lambda *a, **k: sent.append(a))

    user.notification_prefs = {"application_reminders": False}
    notify(db, user, kind="follow_up", title="x", email=True)
    assert sent == []  # pref off → no email

    user.notification_prefs = {"application_reminders": True}
    notify(db, user, kind="follow_up", title="y", email=True, dedupe_key="k2")
    assert len(sent) == 1  # pref on → email queued


# --- due_reminders() --------------------------------------------------------


def test_interview_soon_fires_within_48h(db, user, resume):
    now = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)
    soon = _app(db, user, resume, interview_at=now + timedelta(hours=20))
    later = _app(db, user, resume, interview_at=now + timedelta(days=5))
    reminders = due_reminders([soon, later], now=now)
    kinds = [r.kind for r in reminders]
    assert kinds.count("interview_soon") == 1  # only the near one


def test_reminder_at_due_fires(db, user, resume):
    now = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)
    a = _app(db, user, resume, reminder_at=now - timedelta(hours=1))
    reminders = due_reminders([a], now=now)
    assert any(r.kind == "follow_up" for r in reminders)


def test_stale_application_nudge(db, user, resume):
    now = datetime(2026, 8, 20, 9, 0, tzinfo=UTC)
    stale = _app(db, user, resume, tracker=TrackerStatus.APPLIED,
                 updated_at=now - timedelta(days=15))
    fresh = _app(db, user, resume, tracker=TrackerStatus.APPLIED,
                 updated_at=now - timedelta(days=2))
    reminders = due_reminders([stale, fresh], now=now)
    assert sum(1 for r in reminders if r.kind == "stale_application") == 1


def test_scan_user_is_idempotent(db, user, resume):
    from datetime import datetime as dt
    a = _app(db, user, resume, reminder_at=dt.now(UTC) - timedelta(hours=1))
    assert a is not None
    first = scan_user(db, user)
    second = scan_user(db, user)
    assert first >= 1
    assert second == 0  # dedupe keys prevent re-creation


def test_duplicate_does_not_discard_earlier_uncommitted_notifications(
    db, user, monkeypatch
):
    """Regression: the dedupe collision rolled back the whole transaction.

    The daily scan calls notify() for every user and commits once at the end, so
    a single lost race used to wipe every reminder created for every user
    scanned before it - while the loop still counted them as created.
    """
    first = notify(db, user, kind="follow_up", title="Keep me", dedupe_key="a")
    assert first is not None

    db.add(
        Notification(user_id=user.id, kind="follow_up", title="Racer", dedupe_key="b")
    )
    db.flush()

    # Lose the race for real: blind the pre-check SELECT so the unique
    # constraint is what rejects the insert, which is the path that used to
    # take the whole transaction down with it.
    monkeypatch.setattr(db, "scalar", lambda *a, **k: None)
    duplicate = notify(db, user, kind="follow_up", title="Dupe", dedupe_key="b")
    monkeypatch.undo()

    assert duplicate is None
    # The earlier notification survived and is still pending in this transaction.
    db.commit()
    titles = set(db.scalars(select(Notification.title)))
    assert {"Keep me", "Racer"} <= titles
    assert "Dupe" not in titles
