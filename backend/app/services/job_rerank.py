"""LLM re-ranking of the top job-search results.

The deterministic scorer (matching.analyze_job_fit) is fast, free, and good at
weeding out the clearly-irrelevant, but it reasons over token overlap — it can't
tell that a "Platform Engineer" role is a great fit for someone whose résumé
says "backend / distributed systems" when the words don't line up. So after the
deterministic pass, the top handful of results are handed to the model once, with
a compact view of the résumé, and it returns a semantic fit score + one-line
reason per job.

It is strictly a refinement: one cheap call over only the top N, cached per
(résumé version, query) so repeat views are free, and any failure leaves the
deterministic scores untouched. Never fabricates — the reason must cite the
posting; a bad response is just ignored.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.core.logging import get_logger
from app.schemas.jobsearch import JobSearchResult
from app.schemas.resume import MasterResume
from app.services.llm.factory import LlmClient
from app.services.matching import _content_tokens, _resume_skills
from app.services.pipeline import UsageLedger

logger = get_logger(__name__)

RERANK_TOP_N = 12

_SYSTEM = """\
You are a technical recruiter ranking how well a candidate fits each job.

For every job, return a fit score 0-100 and a one-line reason:
- 80-100: squarely in the candidate's domain and level; they should apply.
- 55-79: adjacent or a stretch in one dimension (domain, seniority, or stack).
- 25-54: weak overlap; mostly a different field or level.
- 0-24: unrelated.

Judge on the actual role and requirements, not surface keyword matches — a lone
shared word is not a match. Weigh domain fit, seniority, the specific tech stack,
and how many of the candidate's real strengths the role uses. Score precisely —
use the full range (e.g. 63, 78, 41), not round multiples of five or ten. The
reason must reference the posting, cite nothing that isn't there, and stay under
16 words. Return one entry per job index."""


class _Ranked(BaseModel):
    index: int
    score: int = Field(ge=0, le=100)
    reason: str = Field(default="", max_length=200)


class _Ranking(BaseModel):
    rankings: list[_Ranked] = Field(default_factory=list)


def _resume_brief(resume: MasterResume) -> str:
    titles = [e.title for e in resume.experience[:4] if e.title]
    skills = sorted(_resume_skills(resume), key=str.lower)[:20]
    lines = [
        f"Headline: {resume.basics.headline or '(none)'}",
        f"Recent titles: {', '.join(titles) or '(none)'}",
        f"Skills: {', '.join(skills) or '(none)'}",
    ]
    if resume.education:
        ed = resume.education[0]
        lines.append(f"Education: {ed.degree} {ed.field_of_study or ''}".strip())
    return "\n".join(lines)


def _job_line(i: int, job: JobSearchResult) -> str:
    snippet = " ".join(_content_tokens(job.snippet))[:240]
    tags = ", ".join(job.tags[:6])
    return f"[{i}] {job.title} @ {job.company}" + (f" | {tags}" if tags else "") + (
        f" | {snippet}" if snippet else ""
    )


def rerank_jobs(
    resume: MasterResume,
    jobs: list[JobSearchResult],
    *,
    client: LlmClient,
    ledger: UsageLedger | None = None,
    top_n: int = RERANK_TOP_N,
) -> dict[int, tuple[int, str]]:
    """Ask the model to score the top ``top_n`` jobs. Returns {index: (score,
    reason)} for the entries it ranked; the caller applies them. Never raises for
    a bad model response — returns what validated, or {} on failure."""
    subset = jobs[:top_n]
    if not subset:
        return {}

    prompt = (
        "CANDIDATE:\n" + _resume_brief(resume) + "\n\nJOBS:\n"
        + "\n".join(_job_line(i, j) for i, j in enumerate(subset))
        + "\n\nReturn a ranking entry for every job index above."
    )
    result = client.generate_structured(
        prompt=prompt, schema=_Ranking, system_instruction=_SYSTEM, temperature=0.0
    )
    if ledger is not None:
        ledger.record("job_rerank", result.usage)

    out: dict[int, tuple[int, str]] = {}
    for r in result.data.rankings:
        if 0 <= r.index < len(subset):
            out[r.index] = (max(0, min(100, r.score)), r.reason.strip())
    logger.info("job_rerank.done", ranked=len(out), of=len(subset))
    return out
