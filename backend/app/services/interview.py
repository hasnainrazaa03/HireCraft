"""Interview-prep service: question generation and STAR answer drafting.

Interview prep is COACHING, not résumé verification. Questions are prep material,
and a STAR answer is practice material: it's anchored in the candidate's real
background (real employers, projects, and technologies) but is free to construct
the realistic narrative and approach details a complete answer needs — how a
disagreement was resolved, how work was delegated, how a hypothetical would be
tackled. Those need not be things that literally happened, only things that
plausibly could have. The one light-touch safeguard that remains is advisory: a
specific figure the résumé can't back is surfaced as a "know your numbers" note,
never blocked — so the candidate can be ready to defend it.
"""

from __future__ import annotations

import re
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
from app.services.pipeline import UsageLedger

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from app.services.llm.factory import LlmClient

logger = get_logger(__name__)

# A standalone figure the candidate could be pressed on in the room — deliberately
# NOT a digit buried in a technology name ("3D", "INT8", "S3", "GPT-4"), which is a
# label, not a metric. A unit (%, x, +, k/m/b) may trail the number.
_METRIC_RE = re.compile(
    r"(?<![A-Za-z0-9.,\-–])\d[\d,]*(?:\.\d+)?(?=%|\+|[×xXkKmMbB]|\s|[.,;:)!?]|$)"
)


def _advisory_metric_numbers(resume: MasterResume, body: str, context: str) -> list[str]:
    """Coaching nudge (never a block): standalone figures in the answer that
    neither the résumé nor the brag bank backs, so the candidate is ready to
    defend them. Digits inside tech names are ignored — only real metrics count."""
    from app.services.llm.guardrails import _master_numbers, _numbers_in

    allowed = _master_numbers(resume) | _numbers_in(context or "")
    found = {m.replace(",", "") for m in _METRIC_RE.findall(body)}
    unbacked = sorted(n for n in (found - allowed) if n)
    if not unbacked:
        return []
    return [
        "Know your numbers — "
        + ", ".join(unbacked)
        + " aren't in your résumé or brag bank, so be ready to back them up (or swap "
        "in a real figure)."
    ]


def generate_questions(
    resume: MasterResume,
    *,
    role: str | None = None,
    company: str | None = None,
    keywords: list[str] | None = None,
    categories: list[str] | None = None,
    count: int = 8,
    exclude: list[str] | None = None,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> list[InterviewQuestion]:
    """``exclude`` lists questions already generated for this role, so asking for
    more produces genuinely new ground instead of the same set again."""
    client = client or get_client()
    result: LlmResult[QuestionSet] = client.generate_structured(
        prompt=build_questions_prompt(
            resume,
            role=role,
            company=company,
            keywords=keywords,
            categories=categories,
            count=count,
            exclude=exclude,
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
    # Coaching-only safeguard: surface a specific *metric* the résumé/brag bank can't
    # back so the candidate can be ready to defend it. Everything else — narrative,
    # approach, hypothetical reasoning — is theirs to construct.
    warnings = _advisory_metric_numbers(resume, combined, " ".join(evidence or []))
    return star, warnings
