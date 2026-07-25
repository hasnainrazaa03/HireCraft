"""Job-search assistant + history-insights tests."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.application import Application, PipelineStatus, TrackerStatus
from app.models.job import Job
from app.models.resume import ResumeProfile
from app.models.user import User
from app.schemas.job import JobRequirements
from app.services.assistant import history_insights, recommend_resume
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
    u = User(email="assist@usc.edu", hashed_password="x")
    db.add(u)
    db.flush()
    return u


def _resume(db, user, name, skills):
    content = {**MASTER_RESUME_FIXTURE, "skills": [{"category": "Languages", "items": skills}]}
    p = ResumeProfile(user_id=user.id, name=name, content=content)
    db.add(p)
    db.flush()
    return p


def _app(db, user, resume, *, tracker=TrackerStatus.APPLIED, keywords=None):
    job = Job(user_id=user.id, raw_text="jd", title="Backend Engineer", company="Globex")
    db.add(job)
    db.flush()
    a = Application(
        user_id=user.id, job_id=job.id, resume_profile_id=resume.id,
        tracker_status=tracker, pipeline_status=PipelineStatus.COMPLETED,
        guardrail_report={"keywords_verified": keywords or []},
    )
    db.add(a)
    db.flush()
    return a


def test_recommend_picks_best_matching_resume(db, user):
    # Résumé A has the job's skills; B does not.
    a = _resume(db, user, "Python résumé", ["Python", "SQL"])
    b = _resume(db, user, "Design résumé", ["Figma", "Sketch"])
    reqs = JobRequirements.model_validate({
        "required_skills": [{"name": "Python", "importance": 5}, {"name": "SQL", "importance": 4}],
        "ats_keywords": ["Python", "SQL"],
    })
    rec = recommend_resume(db, user.id, reqs)
    assert rec.best_resume_id == a.id
    assert rec.rankings[0].name == "Python résumé"
    assert rec.rankings[0].match_score >= rec.rankings[1].match_score
    assert b.id != rec.best_resume_id


def test_recommend_surfaces_weak_areas(db, user):
    _resume(db, user, "R", ["Python"])
    reqs = JobRequirements.model_validate({
        "required_skills": [{"name": "Python", "importance": 5}, {"name": "Kubernetes", "importance": 5}],
    })
    rec = recommend_resume(db, user.id, reqs)
    assert "Kubernetes" in rec.missing_skills
    assert rec.weak_areas  # non-empty gap explanations


def test_history_ranks_by_interviews(db, user):
    winner = _resume(db, user, "Winner", ["Python"])
    other = _resume(db, user, "Other", ["Python"])
    _app(db, user, winner, tracker=TrackerStatus.INTERVIEWING, keywords=["Python", "SQL"])
    _app(db, user, winner, tracker=TrackerStatus.APPLIED)
    _app(db, user, other, tracker=TrackerStatus.APPLIED)

    insights = history_insights(db, user.id)
    assert insights.best_resume_id == winner.id
    assert insights.total_applications == 3
    win = next(o for o in insights.resumes if o.resume_profile_id == winner.id)
    assert win.interviews == 1 and win.applications == 2
    assert "Python" in insights.winning_keywords


def test_history_no_interviews_has_no_best(db, user):
    r = _resume(db, user, "R", ["Python"])
    _app(db, user, r, tracker=TrackerStatus.APPLIED)
    insights = history_insights(db, user.id)
    assert insights.best_resume_id is None  # nobody landed an interview yet


def test_recommend_empty_when_no_resumes(db, user):
    reqs = JobRequirements.model_validate({"required_skills": [{"name": "Python", "importance": 5}]})
    rec = recommend_resume(db, user.id, reqs)
    assert rec.rankings == []
    assert rec.best_resume_id is None
