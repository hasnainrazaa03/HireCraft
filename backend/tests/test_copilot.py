"""Résumé Copilot tests.

The copilot's value is that it explains *real* decisions, so the tests focus on
the deterministic context assembler: it must surface the résumé score, the
guardrail decisions actually stored on an application, the job match, and the
skill gaps — the exact facts the model is then allowed to talk about.
"""

from __future__ import annotations

import json

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
from app.schemas.copilot import ChatMessage, CopilotRequest
from app.services.copilot import answer, build_context
from app.services.llm.client import TextResult, Usage
from app.services.llm.prompts import build_copilot_prompt
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
    u = User(email="copilot@usc.edu", hashed_password="x")
    db.add(u)
    db.flush()
    return u


@pytest.fixture
def resume(db, user):
    p = ResumeProfile(user_id=user.id, name="Master", content=MASTER_RESUME_FIXTURE, is_default=True)
    db.add(p)
    db.flush()
    return p


class StubClient:
    def __init__(self, text: str) -> None:
        self._text = text
        self.last_prompt = ""

    def generate_text(self, *, prompt, **kwargs):  # noqa: ANN001, ANN003
        self.last_prompt = prompt
        return TextResult(
            text=self._text,
            usage=Usage(input_tokens=200, output_tokens=80, model="stub", latency_ms=6),
        )

    def generate_structured(self, *, prompt, schema, **kwargs):  # noqa: ANN001, ANN003
        """Copilot asks for a structured reply so it can carry an optional edit
        action alongside the prose."""
        from app.services.llm.client import LlmResult

        self.last_prompt = prompt
        return LlmResult(
            data=schema(reply=self._text, action=None),
            usage=Usage(input_tokens=200, output_tokens=80, model="stub", latency_ms=6),
            raw_text="{}",
        )


def _application(db, user, resume, *, requirements=None, guardrail_report=None):
    job = Job(
        user_id=user.id, raw_text="jd", title="Backend Engineer", company="Globex",
        requirements=requirements,
    )
    db.add(job)
    db.flush()
    app = Application(
        user_id=user.id, job_id=job.id, resume_profile_id=resume.id,
        tracker_status=TrackerStatus.APPLIED, pipeline_status=PipelineStatus.COMPLETED,
        guardrail_report=guardrail_report,
    )
    db.add(app)
    db.flush()
    return app


def test_context_includes_resume_score(db, user, resume):
    context, labels = build_context(db, user.id)
    assert "RÉSUMÉ" in context
    assert "score" in context.lower()
    assert any("score" in label.lower() for label in labels)


def test_context_surfaces_guardrail_removals(db, user, resume):
    report = {
        "violations": [
            {"severity": "error", "detail": "Dropped 'scaled to 5M users' — no basis in résumé."},
            {"severity": "warning", "detail": "verify this"},
        ],
        "keywords_requested": ["Python", "Kubernetes"],
        "keywords_verified": ["Python"],
        "bullet_confidence": [{"confidence": "verified"}, {"confidence": "likely"}],
    }
    app = _application(db, user, resume, guardrail_report=report)
    context, labels = build_context(db, user.id, application_id=app.id)
    assert "REMOVED" in context
    assert "5M users" in context
    # Withheld keyword is surfaced as not-backed.
    assert "Kubernetes" in context
    assert any("Guardrail" in label for label in labels)


def test_context_includes_job_match_when_requirements_present(db, user, resume):
    reqs = {
        "required_skills": [{"name": "Python", "importance": 5}, {"name": "Go", "importance": 4}],
        "ats_keywords": ["Python", "Go"],
    }
    app = _application(db, user, resume, requirements=reqs)
    context, labels = build_context(db, user.id, application_id=app.id)
    assert "JOB MATCH" in context
    assert "Go" in context  # a missing skill
    assert any("match" in label.lower() for label in labels)


def test_context_empty_account_is_graceful(db, user):
    context, labels = build_context(db, user.id)
    # No résumé, no apps — context is empty but nothing raises.
    assert context == ""
    assert labels == []


def test_prompt_carries_context_and_history():
    prompt = build_copilot_prompt(
        "[RÉSUMÉ]\nScore 72/100.",
        [("user", "hi"), ("assistant", "hello")],
        "Why is my score low?",
    )
    assert "72/100" in prompt
    assert "RECENT CONVERSATION" in prompt
    assert "Why is my score low?" in prompt


def test_answer_grounds_and_meters(db, user, resume):
    from app.services.pipeline import UsageLedger

    client = StubClient("Your score is 72 because two bullets lack metrics.")
    ledger = UsageLedger()
    reply, grounded, _action = answer(
        db, user.id,
        CopilotRequest(message="why is my score low?", history=[ChatMessage(role="user", content="hey")]),
        client=client, ledger=ledger,
    )
    assert "72" in reply
    assert grounded  # at least the résumé section
    assert ledger.entries[0][0] == "copilot"
    # The model was actually handed the résumé context.
    assert "RÉSUMÉ" in client.last_prompt


def test_context_handles_json_requirements_roundtrip(db, user, resume):
    # Requirements stored as a JSON string-ish dict still parse.
    reqs = json.loads(json.dumps({"required_skills": [{"name": "Python", "importance": 5}]}))
    app = _application(db, user, resume, requirements=reqs)
    context, _ = build_context(db, user.id, application_id=app.id)
    assert "JOB MATCH" in context
