"""Dashboard analytics aggregation tests.

The funnel rates carry the product's headline numbers, so their definitions are
pinned here: submitted excludes drafts, interviews count everyone who reached
interviewing-or-beyond, a rejection is a response but a ghosting is not.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (register all tables)
from app.db.base import Base
from app.models.application import (
    Application,
    ApplicationArtifact,
    ArtifactKind,
    PipelineStatus,
    TrackerStatus,
)
from app.models.job import Job
from app.models.resume import ResumeProfile
from app.models.user import User
from app.services.dashboard import build_overview
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
    u = User(email="dash@usc.edu", hashed_password="x")
    db.add(u)
    db.flush()
    return u


@pytest.fixture
def resume(db, user):
    p = ResumeProfile(
        user_id=user.id, name="Master", content=MASTER_RESUME_FIXTURE, current_version=1
    )
    db.add(p)
    db.flush()
    return p


def _app(
    db,
    user,
    resume,
    *,
    company="Acme",
    title="SWE",
    tracker=TrackerStatus.APPLIED,
    pipeline=PipelineStatus.COMPLETED,
    keywords=None,
    tailored=True,
):
    job = Job(user_id=user.id, raw_text="jd", company=company, title=title)
    db.add(job)
    db.flush()
    app = Application(
        user_id=user.id,
        job_id=job.id,
        resume_profile_id=resume.id,
        tracker_status=tracker,
        pipeline_status=pipeline,
        tailored_resume=MASTER_RESUME_FIXTURE if tailored else None,
        guardrail_report={"keywords_verified": keywords or []},
    )
    db.add(app)
    db.flush()
    return app


def test_funnel_rates_use_correct_definitions(db, user, resume):
    # 1 draft, 2 applied, 1 interviewing, 1 offer, 1 rejected, 1 ghosted.
    _app(db, user, resume, tracker=TrackerStatus.DRAFT)
    _app(db, user, resume, tracker=TrackerStatus.APPLIED)
    _app(db, user, resume, tracker=TrackerStatus.APPLIED)
    _app(db, user, resume, tracker=TrackerStatus.INTERVIEWING)
    _app(db, user, resume, tracker=TrackerStatus.OFFER)
    _app(db, user, resume, tracker=TrackerStatus.REJECTED)
    _app(db, user, resume, tracker=TrackerStatus.GHOSTED)

    f = build_overview(db, user.id).funnel
    assert f.total == 7
    assert f.submitted == 6  # everything but the draft
    assert f.interviewing == 2  # interviewing + offer
    assert f.offers == 1
    assert f.closed == 2  # rejected + ghosted
    # responded = interviewing + offer + rejected = 3, submitted = 6
    assert f.response_rate == 0.5
    assert f.interview_rate == round(2 / 6, 4)
    assert f.offer_rate == round(1 / 6, 4)


def test_rates_are_zero_with_no_submissions(db, user, resume):
    _app(db, user, resume, tracker=TrackerStatus.DRAFT)
    f = build_overview(db, user.id).funnel
    assert f.submitted == 0
    assert f.response_rate == 0.0
    assert f.offer_rate == 0.0


def test_v2_stages_map_into_the_funnel(db, user, resume):
    # Pre-submit stages don't count as submitted.
    _app(db, user, resume, tracker=TrackerStatus.WISHLIST)
    _app(db, user, resume, tracker=TrackerStatus.SAVED)
    _app(db, user, resume, tracker=TrackerStatus.PREPARING)
    # Submitted, various depths.
    _app(db, user, resume, tracker=TrackerStatus.ASSESSMENT)
    _app(db, user, resume, tracker=TrackerStatus.TECHNICAL)  # interview+
    _app(db, user, resume, tracker=TrackerStatus.BEHAVIORAL)  # interview+
    _app(db, user, resume, tracker=TrackerStatus.ACCEPTED)  # offer+
    _app(db, user, resume, tracker=TrackerStatus.ARCHIVED)  # closed

    f = build_overview(db, user.id).funnel
    assert f.total == 8
    assert f.submitted == 5  # wishlist/saved/preparing excluded
    assert f.interviewing == 3  # technical + behavioral + accepted
    assert f.offers == 1  # accepted counts as an offer landed
    assert f.closed == 1  # archived
    # responded = assessment + technical + behavioral + accepted = 4 / 5 submitted
    assert f.response_rate == round(4 / 5, 4)


def test_best_resume_counts_deep_interview_stages(db, user):
    a = ResumeProfile(user_id=user.id, name="Deep", content=MASTER_RESUME_FIXTURE)
    db.add(a)
    db.flush()
    _app(db, user, a, tracker=TrackerStatus.FINAL)
    best = build_overview(db, user.id).best_resume
    assert best is not None and best.name == "Deep" and best.count == 1


def test_active_pipeline_counted(db, user, resume):
    _app(db, user, resume, pipeline=PipelineStatus.OPTIMIZING)
    _app(db, user, resume, pipeline=PipelineStatus.COMPLETED)
    assert build_overview(db, user.id).funnel.active == 1


def test_content_stats_and_avg_score(db, user, resume):
    _app(db, user, resume, tailored=True)
    _app(db, user, resume, tailored=False)
    art_app = _app(db, user, resume)
    db.add(
        ApplicationArtifact(
            application_id=art_app.id,
            kind=ArtifactKind.COVER_LETTER_PDF,
            storage_path="x",
            size_bytes=1,
            content_type="application/pdf",
        )
    )
    db.flush()

    c = build_overview(db, user.id).content
    assert c.resume_count == 1
    assert c.tailored_resumes == 2
    assert c.cover_letters == 1
    assert c.avg_resume_score is not None and 0 <= c.avg_resume_score <= 100


def test_leaderboards_and_keywords(db, user, resume):
    _app(db, user, resume, company="Globex", title="Backend Engineer", keywords=["Python", "SQL"])
    _app(db, user, resume, company="Globex", title="Backend Engineer", keywords=["Python"])
    _app(db, user, resume, company="Initech", title="Data Scientist", keywords=["SQL"])

    o = build_overview(db, user.id)
    assert o.top_companies[0].name == "Globex" and o.top_companies[0].count == 2
    assert o.top_titles[0].name == "Backend Engineer"
    kw = {k.name: k.count for k in o.top_keywords}
    assert kw["Python"] == 2 and kw["SQL"] == 2


def test_best_resume_prefers_interviews(db, user):
    a = ResumeProfile(user_id=user.id, name="Résumé A", content=MASTER_RESUME_FIXTURE)
    b = ResumeProfile(user_id=user.id, name="Résumé B", content=MASTER_RESUME_FIXTURE)
    db.add_all([a, b])
    db.flush()
    # B is used more, but A actually lands interviews.
    _app(db, user, a, tracker=TrackerStatus.INTERVIEWING)
    _app(db, user, b, tracker=TrackerStatus.APPLIED)
    _app(db, user, b, tracker=TrackerStatus.APPLIED)

    best = build_overview(db, user.id).best_resume
    assert best is not None and best.name == "Résumé A"


def test_best_resume_reports_zero_interviews_when_none(db, user):
    """A résumé that's only been used — nothing has reached interview — must
    report count 0, so the UI shows 'most-used' instead of claiming an interview
    it never landed."""
    a = ResumeProfile(user_id=user.id, name="Draft-only", content=MASTER_RESUME_FIXTURE)
    db.add(a)
    db.flush()
    _app(db, user, a, tracker=TrackerStatus.DRAFT)

    best = build_overview(db, user.id).best_resume
    assert best is not None and best.name == "Draft-only"
    assert best.count == 0


def test_activity_feed_is_sorted_and_bounded(db, user, resume):
    for i in range(20):
        _app(db, user, resume, title=f"Role {i}", tracker=TrackerStatus.OFFER)
    activity = build_overview(db, user.id).activity
    assert 0 < len(activity) <= 12
    ats = [i.at for i in activity]
    assert ats == sorted(ats, reverse=True)


def test_empty_dashboard_does_not_crash(db, user):
    o = build_overview(db, user.id)
    assert o.funnel.total == 0
    assert o.best_resume is None
    assert o.activity == []
    assert o.content.avg_resume_score is None
