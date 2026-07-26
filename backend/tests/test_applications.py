"""Application report generation tests.

The downloadable package includes a plain-text report so the bundle is
self-documenting. It must faithfully reflect the guardrail record — keyword
coverage, blocked claims, and locked facts — rather than gloss over them.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.api.routes.applications import _build_report
from app.models.application import TrackerStatus


def _application(guardrail_report=None, title="Backend Engineer", company="Globex"):
    return SimpleNamespace(
        job=SimpleNamespace(title=title, company=company),
        tracker_status=TrackerStatus.INTERVIEWING,
        guardrail_report=guardrail_report,
    )


def test_report_includes_role_company_and_stage():
    text = _build_report(_application())
    assert "Backend Engineer" in text
    assert "Globex" in text
    assert "interviewing" in text


def test_report_summarizes_keyword_coverage():
    text = _build_report(
        _application(
            guardrail_report={
                "keywords_requested": ["Python", "Kubernetes", "SQL"],
                "keywords_verified": ["Python", "SQL"],
            }
        )
    )
    assert "2/3" in text
    assert "Kubernetes" in text  # listed as not backed by the résumé


def test_report_lists_blocked_claims():
    text = _build_report(
        _application(
            guardrail_report={
                "violations": [
                    {"severity": "error", "detail": "Dropped invented metric '5M users'"},
                    {"severity": "warning", "detail": "verify this"},
                ]
            }
        )
    )
    assert "blocked" in text.lower()
    assert "5M users" in text


def test_report_handles_missing_job_and_empty_guardrails():
    app = SimpleNamespace(
        job=None, tracker_status=TrackerStatus.WISHLIST, guardrail_report=None
    )
    text = _build_report(app)
    assert "Untitled role" in text
    assert "wishlist" in text


class TestQueueFailure:
    """What happens when the broker is unreachable at enqueue time."""

    @pytest.fixture
    def db(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session as OrmSession
        from sqlalchemy.pool import StaticPool

        import app.models  # noqa: F401
        from app.db.base import Base

        engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(engine)
        with OrmSession(engine) as session:
            yield session

    @pytest.fixture
    def client(self, db):
        from fastapi.testclient import TestClient

        from app.db.session import get_db
        from app.main import app

        app.dependency_overrides[get_db] = lambda: db
        with TestClient(app) as client:
            yield client
        app.dependency_overrides.clear()

    @pytest.fixture
    def auth(self, db):
        from app.core.security import create_token
        from app.models.resume import ResumeProfile
        from app.models.user import User
        from tests.conftest import MASTER_RESUME_FIXTURE

        user = User(email="queue@usc.edu", hashed_password="h")
        db.add(user)
        db.flush()
        db.add(ResumeProfile(user_id=user.id, name="M", content=MASTER_RESUME_FIXTURE))
        db.commit()
        return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}

    def test_unreachable_broker_gives_503_and_a_retryable_application(
        self, client, db, auth, monkeypatch
    ):
        """Regression: publishing made Celery pre-subscribe to the result
        channel, so an unreachable Redis blocked the request ~19s and then
        returned a bare 500, leaving the row stuck at PENDING with the UI
        polling a run nobody would ever pick up."""
        from kombu.exceptions import OperationalError

        from app.api.routes import applications as route
        from app.models.application import Application, PipelineStatus

        def unreachable(_application_id):
            raise OperationalError("Connection refused.")

        monkeypatch.setattr(route, "enqueue_tailoring", unreachable)

        response = client.post(
            "/api/v1/applications",
            json={"job": {"text": "Backend Engineer at Globex. " * 20}},
            headers=auth,
        )
        assert response.status_code == 503, response.text
        assert "try again" in response.json()["detail"].lower()

        # The row exists, is marked failed, and says why — so Retry is offered.
        application = db.query(Application).one()
        assert application.pipeline_status is PipelineStatus.FAILED
        assert "job queue" in application.error_message

    def test_enqueue_publishes_without_subscribing_to_results(self, monkeypatch):
        """ignore_result=True is what keeps the publish fast; assert it is
        actually passed rather than trusting the comment."""
        from app.workers import tasks

        seen = {}

        def fake_apply_async(args=None, **kwargs):
            seen.update(args=args, **kwargs)
            return type("R", (), {"id": "task-123"})()

        monkeypatch.setattr(tasks.run_tailoring_task, "apply_async", fake_apply_async)
        assert tasks.enqueue_tailoring("abc") == "task-123"
        assert seen["ignore_result"] is True
        assert seen["args"] == ["abc"]
