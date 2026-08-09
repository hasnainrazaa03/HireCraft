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


def _advisory_borrowed_terms(
    resume: MasterResume, question: str, answer: str, context: str
) -> list[str]:
    """Flag tool/tech names the QUESTION introduced that the answer echoes but the
    résumé (or attested context) doesn't back — the classic "the interviewer
    mentioned SNPE, don't claim you've used it" case. Advisory, never blocking:
    scoped to terms present in BOTH question and answer so it stays high-signal on
    conversational, first-person text."""
    from app.services.llm.guardrails import (
        _master_corpus,
        _stems,
        _suspicious_tokens,
        _tokens,
    )

    vocab = _tokens(f"{_master_corpus(resume)} {context}".lower())
    stem_vocab = _stems(vocab)
    q_terms = {
        t.lower() for t in _suspicious_tokens(question, vocab, stem_vocab) if len(t) >= 2
    }
    seen: set[str] = set()
    borrowed: list[str] = []
    for t in _suspicious_tokens(answer, vocab, stem_vocab):
        low = t.lower()
        if len(t) >= 2 and low in q_terms and low not in seen:
            seen.add(low)
            borrowed.append(t)
    if not borrowed:
        return []
    names = ", ".join(borrowed[:6])
    return [
        f"Your answer names {names} — raised by the question but not backed by your "
        f"résumé. Present these as how you'd approach the problem, not experience you "
        f"already have."
    ]


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
    evidence: list[str] | None = None,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> tuple[StarAnswer, list[str]]:
    client = client or get_client()
    result: LlmResult[StarAnswer] = client.generate_structured(
        prompt=build_answer_prompt(resume, question, voice=voice, evidence=evidence),
        schema=StarAnswer,
        system_instruction=INTERVIEW_ANSWER_SYSTEM,
        temperature=0.4,
    )
    if ledger is not None:
        ledger.record("interview_answer", result.usage)

    star = result.data
    combined = " ".join([star.situation, star.task, star.action, star.result])
    # The brag bank is attested context, so a number from it isn't unbacked.
    evidence_text = " ".join(evidence or [])
    warnings = _advisory_number_check(resume, combined, evidence_text)
    # …and a tool/tech the question raised but the résumé can't back (e.g. SNPE).
    warnings += _advisory_borrowed_terms(resume, question, combined, evidence_text)
    return star, warnings
