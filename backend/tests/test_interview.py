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
