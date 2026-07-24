"""Export center tests: application-history CSV formatting."""

from __future__ import annotations

import csv as _csv
import io

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.api.routes.export import _applications_csv
from app.db.base import Base
from app.models.application import Application, PipelineStatus, TrackerStatus
from app.models.job import Job
from app.models.resume import ResumeProfile
from app.models.user import User
from tests.conftest import MASTER_RESUME_FIXTURE


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with OrmSession(engine) as session:
        yield session


def _make_app(db, *, title="Backend Engineer", company="Globex", tracker=TrackerStatus.INTERVIEWING):
    user = User(email=f"{title}@usc.edu".replace(" ", ""), hashed_password="x")
    db.add(user)
    db.flush()
    resume = ResumeProfile(user_id=user.id, name="M", content=MASTER_RESUME_FIXTURE)
    db.add(resume)
    db.flush()
    job = Job(user_id=user.id, raw_text="jd", title=title, company=company)
    db.add(job)
    db.flush()
    app = Application(
        user_id=user.id, job_id=job.id, resume_profile_id=resume.id,
        tracker_status=tracker, pipeline_status=PipelineStatus.COMPLETED,
        total_cost_usd=0.0123,
    )
    db.add(app)
    db.flush()
    return app


def test_applications_csv_has_header_and_rows(db):
    _make_app(db)
    apps = list(db.scalars(select(Application)))
    rows = list(_csv.reader(io.StringIO(_applications_csv(apps))))
    assert rows[0][:4] == ["created_at", "job_title", "company", "tracker_status"]
    assert rows[1][1] == "Backend Engineer"
    assert rows[1][2] == "Globex"
    assert rows[1][3] == "interviewing"


def test_csv_quotes_fields_with_commas(db):
    _make_app(db, title="Engineer, Backend", company="A, Inc")
    apps = list(db.scalars(select(Application)))
    rows = list(_csv.reader(io.StringIO(_applications_csv(apps))))
    # Commas inside fields must not break the column layout.
    assert rows[1][1] == "Engineer, Backend"
    assert rows[1][2] == "A, Inc"
    assert len(rows[1]) == len(rows[0])


def test_empty_export_is_just_the_header(db):
    rows = list(_csv.reader(io.StringIO(_applications_csv([]))))
    assert len(rows) == 1  # header only
