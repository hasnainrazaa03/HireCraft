"""LLM job re-rank: the model's scores/reasons map back onto the right jobs.

The LLM is stubbed, so this pins the seam we own — building the request over the
top-N, and mapping validated {index: (score, reason)} back — not the model."""

from __future__ import annotations

from app.schemas.jobsearch import JobSearchResult
from app.schemas.resume import MasterResume
from app.services.job_rerank import _Ranking, rerank_jobs
from app.services.llm.client import LlmResult, Usage
from app.services.pipeline import UsageLedger
from tests.conftest import MASTER_RESUME_FIXTURE


class _Stub:
    def __init__(self, payload):
        self._payload = payload
        self.seen_prompt = ""

    def generate_structured(self, **kwargs):
        self.seen_prompt = kwargs["prompt"]
        return LlmResult(
            data=_Ranking.model_validate(self._payload),
            usage=Usage(input_tokens=200, output_tokens=60, model="stub", latency_ms=9),
            raw_text="{}",
        )


def _job(title: str, company: str) -> JobSearchResult:
    return JobSearchResult(
        title=title, company=company, location="", url=f"https://x/{title}",
        remote=False, tags=[], snippet="", source="test",
    )


def _resume() -> MasterResume:
    return MasterResume.model_validate(MASTER_RESUME_FIXTURE)


def test_rerank_maps_scores_back_to_indices():
    jobs = [_job("ML Engineer", "A"), _job("Barista", "B"), _job("Data Scientist", "C")]
    client = _Stub({"rankings": [
        {"index": 0, "score": 88, "reason": "Strong ML fit"},
        {"index": 1, "score": 10, "reason": "Unrelated"},
        {"index": 2, "score": 74, "reason": "Adjacent"},
    ]})
    ledger = UsageLedger()
    out = rerank_jobs(_resume(), jobs, client=client, ledger=ledger)
    assert out[0] == (88, "Strong ML fit")
    assert out[1][0] == 10 and out[2][0] == 74
    assert ledger.entries and ledger.entries[0][0] == "job_rerank"
    # The résumé brief and each job line reach the prompt.
    assert "Barista" in client.seen_prompt and "Skills:" in client.seen_prompt


def test_rerank_ignores_out_of_range_indices():
    jobs = [_job("ML Engineer", "A")]
    client = _Stub({"rankings": [
        {"index": 0, "score": 90, "reason": "ok"},
        {"index": 5, "score": 99, "reason": "phantom"},  # no such job
    ]})
    out = rerank_jobs(_resume(), jobs, client=client)
    assert set(out) == {0}


def test_apply_rerank_blends_llm_with_deterministic_base():
    """The final score is a blend of the model's score and the fine-grained
    deterministic base — not the model's (often round) number verbatim."""
    from app.api.routes.jobs import _LLM_WEIGHT, _apply_rerank, _job_key

    job = _job("ML Engineer", "A")
    job.match_score = 60  # deterministic rounded (display) value
    key = _job_key(job)
    precise = {key: 58.4}  # fine-grained deterministic base
    by_key = {key: [90, "Strong fit"]}
    _apply_rerank([job], by_key, precise)
    expected = round(_LLM_WEIGHT * 90 + (1 - _LLM_WEIGHT) * 58.4)
    assert job.match_score == expected
    assert 58 < job.match_score < 90  # strictly between the two inputs
    assert job.summary == "Strong fit"


def test_rerank_empty_jobs_makes_no_call():
    called = {"n": 0}

    class _Count(_Stub):
        def generate_structured(self, **kwargs):
            called["n"] += 1
            return super().generate_structured(**kwargs)

    assert rerank_jobs(_resume(), [], client=_Count({"rankings": []})) == {}
    assert called["n"] == 0
