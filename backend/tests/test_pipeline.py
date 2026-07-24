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
from app.services.pipeline import UsageLedger, rewrite_resume


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
