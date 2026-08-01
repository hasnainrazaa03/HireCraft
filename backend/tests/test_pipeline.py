"""Pipeline tests for the standalone rewrite engine.

`rewrite_resume` is thin — it delegates truthfulness to the guardrail engine
(exhaustively covered in test_guardrails) — so these tests focus on the seam:
the rewrite runs with NO job requirements (truthfulness checks only, no
keyword-injection stage), records usage, and produces a diff. The LLM is
stubbed so the tests are deterministic and free.
"""

from __future__ import annotations

from app.schemas.resume import MasterResume
from app.schemas.tailoring import TailoringResult
from app.services.llm.client import LlmResult, Usage
from app.services.pipeline import (
    CoveragePlan,
    ProfileIntro,
    RequirementCoverage,
    UsageLedger,
    generate_profile_intro,
    optimize_resume,
    plan_coverage,
    rewrite_resume,
)


class StubClient:
    """A GeminiClient stand-in that returns a canned TailoringResult."""

    def __init__(self, payload: dict) -> None:
        self._payload = payload
        self.calls = 0

    def generate_structured(self, **kwargs):  # noqa: ANN003
        self.calls += 1
        return LlmResult(
            data=TailoringResult.model_validate(self._payload),
            usage=Usage(
                input_tokens=100, output_tokens=50, model="stub", latency_ms=5
            ),
            raw_text="{}",
        )


def test_clean_rewrite_is_kept_and_diffed(master: MasterResume, experience_id: str):
    client = StubClient(
        {
            "summary": "Computer Science student building React and Python tools.",
            "experience": [
                {
                    "id": experience_id,
                    "highlights": [
                        "Engineered an internal React dashboard serving 200 users",
                        "Automated report generation with Python scripts",
                    ],
                }
            ],
        }
    )
    ledger = UsageLedger()
    improved, report, diff = rewrite_resume(master, client=client, ledger=ledger)

    bullets = [h for e in improved.experience for h in e.highlights]
    assert "Engineered an internal React dashboard serving 200 users" in bullets
    assert not report.has_errors
    assert diff  # wording changed, so the diff is non-empty
    assert ledger.entries and ledger.entries[0][0] == "rewrite_resume"


def test_rewrite_drops_invented_metric(master: MasterResume, experience_id: str):
    client = StubClient(
        {
            "experience": [
                {
                    "id": experience_id,
                    "highlights": ["Scaled the dashboard to 5 million daily users"],
                }
            ]
        }
    )
    improved, report, _ = rewrite_resume(master, client=client)
    bullets = " ".join(h for e in improved.experience for h in e.highlights)
    assert "5 million" not in bullets
    assert report.has_errors


def test_rewrite_flags_unclaimed_technology(master: MasterResume, experience_id: str):
    """With no job, there is no hard keyword-injection drop — but an unclaimed
    proper noun like 'Docker' must still be surfaced: flagged as a warning and
    marked needs-review so the user is never told it silently passed."""
    client = StubClient(
        {
            "experience": [
                {
                    "id": experience_id,
                    "highlights": ["Containerized the dashboard with Docker"],
                }
            ]
        }
    )
    improved, report, _ = rewrite_resume(master, client=client)
    assert any(v.kind == "fabricated_proper_noun" for v in report.violations)
    docker_bullet = next(
        c for c in report.bullet_confidence if "Docker" in c.text
    )
    assert docker_bullet.confidence == "needs_review"


def test_rewrite_confidence_covers_every_bullet(master: MasterResume):
    """Even when the model returns nothing, the confidence report must cover
    every final bullet (backfilled as Verified)."""
    client = StubClient({})
    improved, report, _ = rewrite_resume(master, client=client)
    final = [h for e in improved.experience for h in e.highlights]
    assert len(report.bullet_confidence) == len(final)
    assert all(c.confidence == "verified" for c in report.bullet_confidence)


# --- generate_profile_intro -------------------------------------------------


class IntroStub:
    """A client stand-in that returns a canned ProfileIntro."""

    def __init__(self, headline: str, summary: str) -> None:
        self._intro = ProfileIntro(headline=headline, summary=summary)

    def generate_structured(self, **kwargs):  # noqa: ANN003
        return LlmResult(
            data=self._intro,
            usage=Usage(input_tokens=80, output_tokens=40, model="stub", latency_ms=3),
            raw_text="{}",
        )


def test_generate_intro_returns_and_records_usage(master: MasterResume):
    client = IntroStub(
        "Software Engineer building React and Python tools",
        "Computer Science student who has built internal React dashboards.",
    )
    ledger = UsageLedger()
    intro = generate_profile_intro(master, client=client, ledger=ledger)
    assert intro.headline.startswith("Software Engineer")
    assert "React" in intro.summary
    assert ledger.entries and ledger.entries[0][0] == "generate_profile_intro"


def test_generate_intro_drops_summary_with_invented_number(master: MasterResume):
    """The summary must not smuggle in a metric the résumé never states — the
    fixture mentions 200 users, so 9,000 is fabricated and the summary is dropped
    while a clean headline survives."""
    client = IntroStub(
        "Backend Engineer focused on data pipelines",
        "Engineer who scaled a dashboard to 9,000 daily users.",
    )
    intro = generate_profile_intro(master, client=client)
    assert intro.summary == ""
    assert intro.headline == "Backend Engineer focused on data pipelines"


def test_generate_intro_keeps_summary_with_resume_number(master: MasterResume):
    """A number the résumé already contains (200) is allowed through."""
    client = IntroStub(
        "Software Engineer",
        "Built an internal React dashboard serving 200 users.",
    )
    intro = generate_profile_intro(master, client=client)
    assert "200" in intro.summary


# --- two-stage tailoring (coverage plan) ------------------------------------


class TwoStageStub:
    """Returns a CoveragePlan for stage 1 and a TailoringResult for stage 2,
    keyed on the schema requested — so it can stand in for the whole pipeline."""

    def __init__(self, plan: dict, tailoring: dict) -> None:
        self._plan = plan
        self._tailoring = tailoring
        self.prompts: list[str] = []

    def generate_structured(self, *, schema, prompt, **kwargs):  # noqa: ANN001
        self.prompts.append(prompt)
        data = (
            CoveragePlan.model_validate(self._plan)
            if schema is CoveragePlan
            else TailoringResult.model_validate(self._tailoring)
        )
        return LlmResult(
            data=data,
            usage=Usage(input_tokens=50, output_tokens=20, model="stub", latency_ms=2),
            raw_text="{}",
        )


def test_coverage_plan_lists_only_backed_requirements():
    plan = CoveragePlan(items=[
        RequirementCoverage(requirement="Python", covered=True, evidence="built Python tooling"),
        RequirementCoverage(requirement="Kubernetes", covered=False, evidence=""),
        RequirementCoverage(requirement="SQL", covered=True, evidence=""),  # no evidence → skipped
    ])
    assert plan.covered_lines() == ["Python: built Python tooling"]


def test_plan_coverage_records_usage(master, requirements):
    client = TwoStageStub(
        {"items": [{"requirement": "Python", "covered": True, "evidence": "Python scripts"}]},
        {},
    )
    ledger = UsageLedger()
    plan = plan_coverage(master, requirements, client=client, ledger=ledger)
    assert plan.covered_lines() == ["Python: Python scripts"]
    assert ledger.entries and ledger.entries[0][0] == "plan_coverage"


def test_two_stage_injects_the_plan_into_the_optimizer_prompt(master, requirements, experience_id):
    client = TwoStageStub(
        {"items": [{"requirement": "Python", "covered": True, "evidence": "wrote Python tools"}]},
        {"experience": [{"id": experience_id, "highlights": ["Wrote Python tools"]}]},
    )
    optimize_resume(master, requirements, "job text", two_stage=True, client=client)
    # Two prompts: the coverage plan, then the optimizer with the plan spliced in.
    assert len(client.prompts) == 2
    assert "REQUIREMENT COVERAGE PLAN" in client.prompts[1]
    assert "wrote Python tools" in client.prompts[1]


def test_single_stage_makes_one_call_and_no_plan(master, requirements, experience_id):
    client = TwoStageStub(
        {}, {"experience": [{"id": experience_id, "highlights": ["Wrote Python tools"]}]}
    )
    optimize_resume(master, requirements, "job text", two_stage=False, client=client)
    assert len(client.prompts) == 1
    assert "REQUIREMENT COVERAGE PLAN" not in client.prompts[0]
