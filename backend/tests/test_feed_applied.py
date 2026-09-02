"""Postings you have already applied to, out of the job search.

A board you have already applied to is not a search result. It is something you
did last week, and leaving it in the list costs a second read every time to
remember that — which is exactly the cost the feed exists to remove.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def db():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session as OrmSession
    from sqlalchemy.pool import StaticPool

    import app.models  # noqa: F401
    from app.db.base import Base

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with OrmSession(engine) as session:
        yield session


@pytest.fixture
def user(db):
    from app.models.user import User

    account = User(email="feed@usc.edu", hashed_password="h", full_name="Ada King")
    db.add(account)
    db.commit()
    return account


def _row(user, **kw):
    from app.models.scraped_job import ScrapedJob

    base = dict(
        user_id=user.id,
        fingerprint=kw.pop("fp", "f" * 8),
        source="greenhouse",
        company="Kyndryl",
        title="Associate AI Engineer",
        url="https://boards.greenhouse.io/kyndryl/jobs/1",
        location="Dallas, TX",
        description="",
        active=True,
    )
    base.update(kw)
    return ScrapedJob(**base)


def _tracked(db, user, *, company, title, url):
    """One application, made the way the app makes them."""
    from app.models.application import Application, PipelineStatus
    from app.models.job import Job
    from app.models.resume import ResumeProfile

    resume = ResumeProfile(user_id=user.id, name="R", is_default=True, content={"basics": {}})
    db.add(resume)
    db.flush()
    job = Job(user_id=user.id, url=url, source="greenhouse", title=title, company=company,
              location="", raw_text="")
    db.add(job)
    db.flush()
    db.add(Application(user_id=user.id, job_id=job.id, resume_profile_id=resume.id,
                       pipeline_status=PipelineStatus.COMPLETED, include_cover_letter=False))
    db.commit()


def test_an_applied_posting_matched_by_url_drops_out(db, user):
    """The scraper's title and the page's title are not always the same string.

    Point72's feed row reads "Software Developer - Developers (New Grad)" and the
    tracked application reads "2027 Cubist Quant Academy – Developers", on one
    Greenhouse job id. Same URL is the same posting whatever either calls it.
    """
    from app.api.routes.jobs import _applied_keys, _is_applied

    row = _row(user, company="Point72", title="Software Developer - Developers (New Grad)",
               url="https://boards.greenhouse.io/point72/jobs/7598678002")
    db.add(row)
    _tracked(db, user, company="Point72", title="2027 Cubist Quant Academy – Developers",
             url="https://boards.greenhouse.io/point72/jobs/7598678002")

    assert _is_applied(row, _applied_keys(db, user.id)) is True


def test_an_applied_posting_matched_by_company_and_title_drops_out(db, user):
    """An application made through the extension records the page the form was
    on — Workday's /apply/applyManually, Greenhouse's job_app?for=… — which is
    never the URL the scraper stored. A URL-only test would leave every
    extension-tracked job sitting in the results."""
    from app.api.routes.jobs import _applied_keys, _is_applied

    row = _row(user, url="https://kyndryl.wd5.myworkdayjobs.com/jobs/R-66739")
    db.add(row)
    _tracked(db, user, company="  kyndryl  ", title="Associate AI Engineer",
             url="https://kyndryl.wd5.myworkdayjobs.com/apply/applyManually")

    # Case and surrounding space are not differences anybody means.
    assert _is_applied(row, _applied_keys(db, user.id)) is True


def test_a_different_role_at_the_same_company_stays(db, user):
    """The match has to be tight enough that applying to one role at a company
    does not hide the rest of it — which would be a far worse failure than
    showing one row twice."""
    from app.api.routes.jobs import _applied_keys, _is_applied

    row = _row(user, title="Senior Data Engineer", url="https://boards.greenhouse.io/kyndryl/jobs/2")
    db.add(row)
    _tracked(db, user, company="Kyndryl", title="Associate AI Engineer",
             url="https://boards.greenhouse.io/kyndryl/jobs/1")

    assert _is_applied(row, _applied_keys(db, user.id)) is False


def test_nothing_applied_to_means_nothing_hidden(db, user):
    from app.api.routes.jobs import _applied_keys, _is_applied

    row = _row(user)
    db.add(row)
    db.commit()
    assert _applied_keys(db, user.id) == set()
    assert _is_applied(row, set()) is False
