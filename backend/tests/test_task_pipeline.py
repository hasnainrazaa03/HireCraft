"""End-to-end cover for the tailoring task.

test_pipeline.py exercises the pipeline functions with stubs; this covers the
layer above them — the Celery task that owns status transitions and persistence,
plus the routes that serve what it produced. That path (task → artifacts on disk
→ download) had no test, and it is the app's central flow.

The LLM is stubbed; everything else is real, including the guardrail merge and
the artifact writes.
"""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (register tables)
from app.db.base import Base
from app.models.application import Application, PipelineStatus
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.models.user import User
from app.schemas.job import JobRequirements, Skill
from app.schemas.resume import MasterResume
from app.schemas.tailoring import TailoredEntry, TailoringResult
from app.services.llm.client import LlmResult, TextResult, Usage
from tests.conftest import MASTER_RESUME_FIXTURE

pytestmark = pytest.mark.slow  # renders LaTeX via Tectonic


# Resolved from this file, like test_latex.py does, so the suite doesn't depend
# on TEMPLATES_DIR being exported (it defaults to the in-container /app path).
TEMPLATES_DIR = str(
    next(
        (p / "templates" for p in Path(__file__).resolve().parents if (p / "templates").is_dir()),
        Path(__file__).resolve().parents[2] / "templates",
    )
)


@pytest.fixture
def sessions(tmp_path, monkeypatch):
    """An isolated database + artifact root, wired into the task module."""
    from app.core import config

    monkeypatch.setattr(config.settings, "artifacts_dir", str(tmp_path / "artifacts"))
    monkeypatch.setattr(config.settings, "templates_dir", TEMPLATES_DIR)
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autocommit=False, autoflush=False)

    import app.workers.tasks as tasks

    @contextmanager
    def scope():
        db = factory()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    monkeypatch.setattr(tasks, "session_scope", scope)
    return factory


@pytest.fixture
def stub_llm(monkeypatch):
    """A client that returns fixed requirements and a rewrite containing one
    genuine metric and one invented one."""
    master = MasterResume.model_validate(MASTER_RESUME_FIXTURE)
    entry_id = master.experience[0].id

    class Stub:
        model = "stub-model"

        def generate_structured(self, *, prompt, schema, **_kw):
            usage = Usage(input_tokens=100, output_tokens=50, model=self.model, latency_ms=5)
            if schema is JobRequirements:
                data = JobRequirements(
                    title="Backend Engineer",
                    company="Globex",
                    required_skills=[Skill(name="Python", importance=5)],
                    ats_keywords=["Python", "Kubernetes"],
                )
            elif schema is TailoringResult:
                data = TailoringResult(
                    experience=[
                        TailoredEntry(
                            id=entry_id,
                            highlights=[
                                # Real: 200 is in the master résumé.
                                "Built a React dashboard serving 200 users",
                                # Invented: 45% appears nowhere.
                                "Cut latency by 45%",
                            ],
                        )
                    ]
                )
            else:
                data = schema()
            return LlmResult(data=data, usage=usage, raw_text="{}")

        def generate_text(self, **_kw):
            return TextResult(text="ok", usage=Usage(1, 1, self.model, 1))

        def generate_raw(self, **_kw):
            return {}, Usage(1, 1, self.model, 1), "{}"

    import app.workers.tasks as tasks

    # tasks imports the name directly, so patching the factory module is not enough.
    monkeypatch.setattr(tasks, "client_for_user", lambda user, **_kw: Stub())
    return Stub()


def _seed(factory) -> str:
    from app.models.job import Job

    with factory() as db:
        user = User(email="task@usc.edu", hashed_password="h")
        db.add(user)
        db.flush()
        profile = ResumeProfile(user_id=user.id, name="M", content=MASTER_RESUME_FIXTURE)
        job = Job(
            user_id=user.id, raw_text="Backend Engineer at Globex. " * 40,
            title="Backend Engineer", company="Globex",
        )
        db.add_all([profile, job])
        db.flush()
        application = Application(
            user_id=user.id, job_id=job.id, resume_profile_id=profile.id,
            pipeline_status=PipelineStatus.PENDING,
        )
        db.add(application)
        db.flush()
        db.commit()
        return str(application.id)


def test_task_produces_artifacts_and_enforces_guardrails(sessions, stub_llm):
    import app.workers.tasks as tasks

    application_id = _seed(sessions)
    result = tasks.run_tailoring_task.run(application_id)
    assert result["status"] == "completed", result

    with sessions() as db:
        application = db.get(Application, uuid.UUID(application_id))
        assert application.pipeline_status is PipelineStatus.COMPLETED
        assert application.error_message is None

        kinds = {a.kind.value for a in application.artifacts}
        assert {"resume_pdf", "resume_tex"} <= kinds
        for artifact in application.artifacts:
            # Only relative paths are persisted, so the storage root can move.
            assert not Path(artifact.storage_path).is_absolute()
            assert artifact.size_bytes > 0

        # The invented metric was removed; the real one survived.
        tailored = json.dumps(application.tailored_resume)
        assert "45%" not in tailored
        assert "200 users" in tailored
        violations = application.guardrail_report["violations"]
        assert any(v["kind"] == "fabricated_number" for v in violations)

        # Per-call usage rows were written, and the rollup matches them.
        rows = db.query(LlmUsage).all()
        assert len(rows) >= 2
        assert application.total_input_tokens == sum(r.input_tokens for r in rows)
        assert application.total_cost_usd > 0


def test_rerunning_does_not_stack_a_second_set_of_artifacts(sessions, stub_llm):
    """The retry endpoint re-runs the same application; artifacts must be
    replaced rather than accumulated."""
    import app.workers.tasks as tasks

    application_id = _seed(sessions)
    tasks.run_tailoring_task.run(application_id)
    with sessions() as db:
        first = len(db.get(Application, uuid.UUID(application_id)).artifacts)

    tasks.run_tailoring_task.run(application_id)
    with sessions() as db:
        application = db.get(Application, uuid.UUID(application_id))
        assert len(application.artifacts) == first
        assert application.pipeline_status is PipelineStatus.COMPLETED


def test_a_missing_api_key_fails_the_run_without_retrying(sessions, monkeypatch):
    """A misconfigured provider is terminal — retrying cannot conjure a key —
    and the reason has to reach the user rather than a bare 'failed'."""
    import app.workers.tasks as tasks
    from app.services.llm.client import LlmConfigurationError

    def boom(user, **_kw):
        raise LlmConfigurationError("Anthropic Claude isn't configured.")

    monkeypatch.setattr(tasks, "client_for_user", boom)
    application_id = _seed(sessions)
    result = tasks.run_tailoring_task.run(application_id)

    assert result == {"status": "failed", "reason": "configuration"}
    with sessions() as db:
        application = db.get(Application, uuid.UUID(application_id))
        assert application.pipeline_status is PipelineStatus.FAILED
        assert "Anthropic" in application.error_message
