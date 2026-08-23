"""Interview-prep tests.

Questions are prep material and only need to flow through cleanly. A STAR answer,
though, is the candidate's real story, so the advisory truthfulness check must
flag a figure the résumé doesn't support.
"""

from __future__ import annotations

from typing import get_args

from app.schemas.interview import InterviewQuestion, QuestionCategory, QuestionSet, StarAnswer
from app.schemas.resume import MasterResume
from app.services.interview import draft_star_answer, generate_questions
from app.services.llm.client import LlmResult, Usage
from app.services.llm.prompts import build_answer_prompt, build_questions_prompt


class StubClient:
    def __init__(self, data) -> None:
        self._data = data
        self.last_prompt = ""

    def generate_structured(self, *, prompt, **kwargs):  # noqa: ANN001, ANN003
        self.last_prompt = prompt
        return LlmResult(
            data=self._data,
            usage=Usage(input_tokens=100, output_tokens=60, model="stub", latency_ms=5),
            raw_text="{}",
        )


def test_questions_prompt_includes_role_company_and_categories(master: MasterResume):
    prompt = build_questions_prompt(
        master, role="Backend Engineer", company="Globex",
        keywords=["Python", "REST"], categories=["behavioral", "system_design"],
    )
    assert "Backend Engineer" in prompt
    assert "Globex" in prompt
    assert "behavioral" in prompt and "system_design" in prompt
    assert "Python" in prompt


def test_generate_questions_returns_and_meters(master: MasterResume):
    from app.services.pipeline import UsageLedger

    qs = QuestionSet(questions=[
        InterviewQuestion(category="behavioral", question="Tell me about a conflict.", why="probes teamwork", tip="Use STAR"),
        InterviewQuestion(category="technical", question="Explain a REST API you built.", why="depth", tip="Be concrete"),
    ])
    client = StubClient(qs)
    ledger = UsageLedger()
    out = generate_questions(master, role="SWE", client=client, ledger=ledger)
    assert len(out) == 2
    assert ledger.entries[0][0] == "interview_questions"


def test_answer_prompt_grounds_in_resume(master: MasterResume):
    prompt = build_answer_prompt(master, "Tell me about a project you're proud of.")
    assert "Acme" in prompt  # the candidate's real experience is provided to the model
    assert "Tell me about a project" in prompt


def test_star_answer_flags_unbacked_numbers(master: MasterResume):
    # The résumé's only metric is 200 users; 5,000,000 is invented.
    star = StarAnswer(
        situation="At Acme I owned the dashboard.",
        task="Improve adoption.",
        action="I rebuilt it in React.",
        result="It reached 5000000 users.",
    )
    client = StubClient(star)
    answer, warnings = draft_star_answer(master, "Tell me about impact.", client=client)
    assert answer.result  # never edited
    assert warnings and "5000000" in warnings[0]


def test_star_answer_clean_has_no_warnings(master: MasterResume):
    star = StarAnswer(
        situation="At Acme I built an internal dashboard.",
        task="Serve the ops team.",
        action="I used React and Python.",
        result="It was adopted by 200 users.",
    )
    answer, warnings = draft_star_answer(master, "Impact?", client=StubClient(star))
    assert warnings == []


def test_category_literal_covers_expected_values():
    cats = set(get_args(QuestionCategory))
    assert {"behavioral", "technical", "system_design", "coding", "resume"} <= cats


def test_metric_advisory_ignores_tech_names(master: MasterResume):
    from app.services.interview import _advisory_metric_numbers

    # Digits inside technology names are labels, not metrics — no nudge.
    assert _advisory_metric_numbers(master, "Optimized 3D CNNs with INT8 on S3 and GPT-4.", "") == []
    # A standalone, unbacked figure is a real metric — surfaced as coaching.
    out = _advisory_metric_numbers(master, "I cut latency by 47% for 9,000 users.", "")
    assert out and "47" in out[0] and "9000" in out[0]


def test_star_answer_allows_constructed_hypothetical(master: MasterResume):
    """Interview prep coaches, it doesn't verify: an answer that reasons about a
    tool the question raised (even one not on the résumé) draws NO warning — only a
    specific unbacked *figure* would get an advisory note."""
    star = StarAnswer(
        situation="At my last role I optimized 3D CNNs for on-device inference.",
        task="The interviewer asks how I'd target Qualcomm Snapdragon with SNPE.",
        action=(
            "If I were deploying there, I'd map my INT8 quantization work onto SNPE "
            "and validate operator support on the NPU."
        ),
        result="A plausible, well-reasoned deployment plan I can walk through.",
    )
    _, warnings = draft_star_answer(
        master,
        "How would you deploy on Qualcomm Snapdragon using SNPE?",
        client=StubClient(star),
    )
    assert warnings == []


def test_questions_prompt_excludes_already_asked(master: MasterResume):
    """Asking again means "give me more" — previously generated questions must be
    shown to the model as off-limits, or it just returns the same set."""
    prompt = build_questions_prompt(
        master,
        role="Backend Engineer",
        exclude=["Tell me about a time you led a team."],
    )
    assert "ALREADY ASKED" in prompt
    assert "Tell me about a time you led a team." in prompt
    assert "do NOT repeat" in prompt


def test_questions_prompt_has_no_asked_block_on_a_first_run(master: MasterResume):
    prompt = build_questions_prompt(master, role="Backend Engineer")
    assert "ALREADY ASKED" not in prompt


def test_norm_question_collapses_trivial_rewording():
    """Duplicate detection has to survive punctuation/case/whitespace drift, since
    a lightly-reworded repeat is exactly what slips past the prompt."""
    from app.api.routes.interview import _norm_question

    assert _norm_question("Tell me about a time you led a team.") == _norm_question(
        "  tell me about a TIME you led a team!!  "
    )
    assert _norm_question("Describe a conflict") != _norm_question("Describe a failure")
