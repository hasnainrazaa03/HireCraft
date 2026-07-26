"""Interview-prep service: question generation and STAR answer drafting.

Questions are prep material (not claims about the candidate), so they need no
guardrail. A STAR answer, though, is the candidate's real story — it's grounded
in the résumé and gets the same advisory truthfulness check as outreach: any
figure not backed by the résumé is flagged for the candidate to verify, never
silently presented as fact.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.core.logging import get_logger
from app.schemas.interview import InterviewQuestion, QuestionSet, StarAnswer
from app.schemas.resume import MasterResume
from app.schemas.writing import VoiceProfile
from app.services.llm.client import LlmResult, get_client
from app.services.llm.prompts import (
    INTERVIEW_ANSWER_SYSTEM,
    INTERVIEW_QUESTIONS_SYSTEM,
    build_answer_prompt,
    build_questions_prompt,
)
from app.services.pipeline import UsageLedger, _advisory_number_check

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from app.services.llm.factory import LlmClient

logger = get_logger(__name__)


def generate_questions(
    resume: MasterResume,
    *,
    role: str | None = None,
    company: str | None = None,
    keywords: list[str] | None = None,
    categories: list[str] | None = None,
    count: int = 8,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> list[InterviewQuestion]:
    client = client or get_client()
    result: LlmResult[QuestionSet] = client.generate_structured(
        prompt=build_questions_prompt(
            resume,
            role=role,
            company=company,
            keywords=keywords,
            categories=categories,
            count=count,
        ),
        schema=QuestionSet,
        system_instruction=INTERVIEW_QUESTIONS_SYSTEM,
        temperature=0.6,
    )
    if ledger is not None:
        ledger.record("interview_questions", result.usage)
    logger.info("interview.questions_generated", count=len(result.data.questions))
    return result.data.questions


def draft_star_answer(
    resume: MasterResume,
    question: str,
    *,
    voice: VoiceProfile | None = None,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> tuple[StarAnswer, list[str]]:
    client = client or get_client()
    result: LlmResult[StarAnswer] = client.generate_structured(
        prompt=build_answer_prompt(resume, question, voice=voice),
        schema=StarAnswer,
        system_instruction=INTERVIEW_ANSWER_SYSTEM,
        temperature=0.4,
    )
    if ledger is not None:
        ledger.record("interview_answer", result.usage)

    star = result.data
    combined = " ".join([star.situation, star.task, star.action, star.result])
    warnings = _advisory_number_check(resume, combined, None)
    return star, warnings
