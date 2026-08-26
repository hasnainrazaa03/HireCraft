"""The tailoring pipeline.

Sequence: scrape -> extract requirements -> optimize -> guardrail merge ->
render LaTeX -> compile PDF. Written as plain synchronous functions with no
Celery or FastAPI imports, so the whole thing is testable without a broker.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.logging import get_logger
from app.schemas.job import JobRequirements, ScrapeResult
from app.schemas.resume import MasterResume
from app.schemas.tailoring import DiffEntry, GuardrailReport, TailoringResult
from app.schemas.writing import VoiceProfile
from app.services.latex.compiler import compile_latex
from app.services.latex.renderer import render_and_fit, render_cover_letter
from app.services.latex.templates import resolve_filename
from app.services.llm.client import LlmError, LlmResult, Usage, get_client
from app.services.llm.guardrails import GuardrailEngine, build_diff
from app.services.llm.prompts import (
    COVER_LETTER_SYSTEM,
    COVERAGE_SYSTEM,
    EXTRACTOR_SYSTEM,
    INTRO_SYSTEM,
    OPTIMIZER_SYSTEM,
    OUTREACH_SYSTEM,
    REWRITE_SYSTEM,
    build_cover_letter_prompt,
    build_coverage_prompt,
    build_extractor_prompt,
    build_intro_prompt,
    build_optimizer_prompt,
    build_optimizer_prompt_with_plan,
    build_outreach_prompt,
    build_rewrite_prompt,
)
from app.services.writing_quality import strip_leak_lines

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from app.services.llm.factory import LlmClient

logger = get_logger(__name__)

ProgressCallback = Callable[[str, str], None]
"""Called as ``(stage, human_readable_message)`` as the pipeline advances."""


class CoverLetterDraft(BaseModel):
    paragraphs: list[str] = Field(default_factory=list, max_length=8)


@dataclass
class UsageLedger:
    """Accumulates per-call token usage across the run."""

    entries: list[tuple[str, Usage]] = field(default_factory=list)

    def record(self, purpose: str, usage: Usage) -> None:
        self.entries.append((purpose, usage))

    @property
    def input_tokens(self) -> int:
        return sum(u.input_tokens for _, u in self.entries)

    @property
    def output_tokens(self) -> int:
        return sum(u.output_tokens for _, u in self.entries)

    @property
    def cost_usd(self) -> float:
        return round(sum(u.cost_usd for _, u in self.entries), 6)


@dataclass
class TailoringOutcome:
    """Everything one pipeline run produced."""

    requirements: JobRequirements
    tailored_resume: MasterResume
    guardrail_report: GuardrailReport
    diff: list[DiffEntry]
    resume_tex: str
    resume_pdf: bytes
    cover_letter_tex: str | None = None
    cover_letter_pdf: bytes | None = None
    cover_letter: list[str] | None = None
    usage: UsageLedger = field(default_factory=UsageLedger)
    page_count: int = 1


def extract_requirements(
    scrape: ScrapeResult,
    *,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> JobRequirements:
    """Stage 2: turn posting text into structured requirements."""
    client = client or get_client()
    result: LlmResult[JobRequirements] = client.generate_structured(
        prompt=build_extractor_prompt(scrape.text, scrape.url),
        schema=JobRequirements,
        system_instruction=EXTRACTOR_SYSTEM,
        temperature=0.1,
    )
    if ledger is not None:
        ledger.record("extract_requirements", result.usage)

    requirements = result.data
    # Prefer scraped metadata when the model left a field empty.
    requirements.title = requirements.title or scrape.title
    requirements.company = requirements.company or scrape.company
    requirements.location = requirements.location or scrape.location
    logger.info(
        "pipeline.requirements_extracted",
        title=requirements.title,
        company=requirements.company,
        keywords=len(requirements.all_keywords()),
    )
    return requirements


class RequirementCoverage(BaseModel):
    requirement: str = Field(max_length=200)
    covered: bool = False
    evidence: str = Field(default="", max_length=400)


class CoveragePlan(BaseModel):
    items: list[RequirementCoverage] = Field(default_factory=list)

    def covered_lines(self) -> list[str]:
        """The requirements the candidate genuinely backs, with their evidence —
        the plan handed to the writer so real strengths get surfaced."""
        return [
            f"{it.requirement}: {it.evidence}".strip().rstrip(":")
            for it in self.items
            if it.covered and it.evidence.strip()
        ]


def plan_coverage(
    master: MasterResume,
    requirements: JobRequirements,
    *,
    evidence: list[str] | None = None,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> CoveragePlan:
    """Stage 1 of two-stage tailoring: map each requirement to real evidence.

    Deciding coverage up front — with the résumé AND brag bank in view — means
    the rewrite can be told exactly which requirements to surface and with what,
    instead of hoping the one-shot optimizer connects them. Genuine gaps stay
    gaps: the plan never invents support, so this can only raise honest coverage."""
    client = client or get_client()
    result: LlmResult[CoveragePlan] = client.generate_structured(
        prompt=build_coverage_prompt(master, requirements, evidence=evidence),
        schema=CoveragePlan,
        system_instruction=COVERAGE_SYSTEM,
        temperature=0.0,
    )
    if ledger is not None:
        ledger.record("plan_coverage", result.usage)
    plan = result.data
    logger.info(
        "pipeline.coverage_planned",
        assessed=len(plan.items),
        covered=sum(1 for it in plan.items if it.covered),
    )
    return plan


def optimize_resume(
    master: MasterResume,
    requirements: JobRequirements,
    job_text: str,
    *,
    evidence: list[str] | None = None,
    two_stage: bool = True,
    reach: bool = False,
    client: LlmClient | None = None,
    plan_client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> tuple[MasterResume, GuardrailReport, list[DiffEntry]]:
    """Stage 3: rewrite presentation, then enforce truthfulness.

    ``evidence`` is the candidate's brag bank — attested facts the model may draw
    on and the guardrails treat as valid provenance (see GuardrailEngine). When
    ``two_stage`` is set, a coverage-planning pass first maps each requirement to
    the candidate's real evidence, and that plan steers the rewrite to surface
    genuine strengths (raising keyword coverage without inventing anything)."""
    client = client or get_client()
    prompt = build_optimizer_prompt(master, requirements, job_text, evidence=evidence, reach=reach)
    if two_stage:
        try:
            plan = plan_coverage(
                master, requirements, evidence=evidence,
                client=plan_client or client, ledger=ledger,
            )
            prompt = build_optimizer_prompt_with_plan(prompt, plan.covered_lines())
        except Exception as exc:  # noqa: BLE001 - the plan is best-effort
            # The plan is an optimisation, not a requirement — any failure (LLM
            # error, malformed response) just falls back to the single-stage prompt.
            logger.info("pipeline.coverage_plan_skipped", error=str(exc)[:200])

    result: LlmResult[TailoringResult] = client.generate_structured(
        prompt=prompt,
        schema=TailoringResult,
        system_instruction=OPTIMIZER_SYSTEM,
        temperature=settings.llm_temperature,
    )
    if ledger is not None:
        ledger.record("optimize_resume", result.usage)

    tailored, report = GuardrailEngine(
        master, requirements, evidence=evidence, reach=reach
    ).apply(result.data)
    diff = build_diff(master, tailored)

    errors = [v for v in report.violations if v.severity == "error"]
    logger.info(
        "pipeline.resume_optimized",
        violations=len(report.violations),
        errors=len(errors),
        keyword_coverage=round(report.keyword_coverage, 3),
        changed_fields=len(diff),
    )
    if errors:
        logger.warning(
            "pipeline.guardrails_intervened",
            count=len(errors),
            kinds=sorted({v.kind for v in errors}),
        )
    return tailored, report, diff


def rewrite_resume(
    master: MasterResume,
    *,
    findings: list[str] | None = None,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> tuple[MasterResume, GuardrailReport, list[DiffEntry]]:
    """Improve a résumé's wording without a target job.

    Same machinery as tailoring, but the prompt is job-agnostic and the guardrail
    engine runs with no requirements — so there is no keyword-injection concern,
    only the truthfulness checks (no invented numbers, no unclaimed skills, no
    altered facts). ``findings`` are the deterministic analysis weaknesses, fed
    in so the model targets real problems.
    """
    client = client or get_client()
    result: LlmResult[TailoringResult] = client.generate_structured(
        prompt=build_rewrite_prompt(master, findings),
        schema=TailoringResult,
        system_instruction=REWRITE_SYSTEM,
        temperature=settings.llm_temperature,
    )
    if ledger is not None:
        ledger.record("rewrite_resume", result.usage)

    # No job -> requirements=None -> no keyword-injection check, truthfulness only.
    improved, report = GuardrailEngine(master, None).apply(result.data)
    diff = build_diff(master, improved)
    logger.info(
        "pipeline.rewrote",
        changed_fields=len(diff),
        errors=len([v for v in report.violations if v.severity == "error"]),
    )
    return improved, report, diff


def revise_resume(
    current: MasterResume,
    master: MasterResume,
    instruction: str,
    *,
    evidence: list[str] | None = None,
    requirements: JobRequirements | None = None,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> tuple[MasterResume, GuardrailReport, list[DiffEntry]]:
    """Apply a user's plain-language edit request to an already-tailored résumé.

    The model rewrites ``current`` per ``instruction``; the guardrail engine then
    vets the result against the ORIGINAL ``master`` (+ brag-bank ``evidence`` and,
    if present, the job ``requirements``) so a revision can only reword facts the
    candidate has actually attested to — never invent. Returns the vetted résumé,
    its guardrail report, and the diff *from the current tailored version*.
    """
    client = client or get_client()
    result: LlmResult[TailoringResult] = client.generate_structured(
        prompt=build_rewrite_prompt(current, instruction=instruction),
        schema=TailoringResult,
        system_instruction=REWRITE_SYSTEM,
        temperature=settings.llm_temperature,
    )
    if ledger is not None:
        ledger.record("revise_resume", result.usage)

    revised, report = GuardrailEngine(master, requirements, evidence=evidence).apply(result.data)
    diff = build_diff(current, revised)
    logger.info(
        "pipeline.revised",
        changed_fields=len(diff),
        errors=len([v for v in report.violations if v.severity == "error"]),
    )
    return revised, report, diff


class ProfileIntro(BaseModel):
    headline: str = Field(default="", max_length=200)
    summary: str = Field(default="", max_length=1200)


def generate_profile_intro(
    master: MasterResume,
    *,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> ProfileIntro:
    """Draft a truthful headline + summary from the rest of the résumé.

    Powers the builder's "Generate with AI" button on the Basics section. Uses
    only facts the résumé already contains (enforced by the prompt and, for
    numbers/skills, re-checked below): the summary can't claim a metric or a
    technology the candidate hasn't listed. Costs one LLM call.
    """
    client = client or get_client()
    result: LlmResult[ProfileIntro] = client.generate_structured(
        prompt=build_intro_prompt(master),
        schema=ProfileIntro,
        system_instruction=INTRO_SYSTEM,
        temperature=settings.llm_temperature,
    )
    if ledger is not None:
        ledger.record("generate_profile_intro", result.usage)

    from app.services.llm.guardrails import _master_numbers, _numbers_in

    intro = result.data
    # Truthfulness backstop: drop the summary if it introduces a number the
    # résumé doesn't contain (the headline is short and rarely carries metrics).
    allowed = _master_numbers(master)
    if intro.summary and not _numbers_in(intro.summary) <= allowed:
        logger.info("pipeline.intro_summary_had_unverified_number")
        intro = ProfileIntro(headline=intro.headline, summary="")
    logger.info("pipeline.generated_intro", has_summary=bool(intro.summary))
    return intro


class OutreachDraft(BaseModel):
    subject: str = Field(default="", max_length=300)
    body: str = Field(default="", max_length=4000)


def draft_cover_letter(
    resume: MasterResume,
    requirements: JobRequirements,
    job_text: str,
    *,
    tone: str | None = None,
    voice: VoiceProfile | None = None,
    evidence: list[str] | None = None,
    feedback: str | None = None,
    previous: list[str] | None = None,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> list[str]:
    """Optional stage: draft cover letter paragraphs, vetted like everything else.

    Pass ``feedback`` (+ the ``previous`` paragraphs) to revise an existing letter
    per the candidate's request instead of drafting from scratch.
    """
    client = client or get_client()
    result: LlmResult[CoverLetterDraft] = client.generate_structured(
        prompt=build_cover_letter_prompt(
            resume, requirements, job_text, tone=tone, voice=voice,
            evidence=evidence, feedback=feedback, previous=previous,
        ),
        schema=CoverLetterDraft,
        system_instruction=COVER_LETTER_SYSTEM,
        temperature=0.4,
    )
    if ledger is not None:
        ledger.record("cover_letter", result.usage)

    # Reuse the resume guardrails: a cover letter must not out-claim the resume
    # (plus the attested brag bank).
    engine = GuardrailEngine(resume, requirements, evidence=evidence)
    vetted: list[str] = []
    for paragraph in result.data.paragraphs:
        if engine.vet_paragraph(paragraph) is not None:
            vetted.append(paragraph)
        else:
            logger.warning("pipeline.cover_letter_paragraph_rejected")
    # Drop any model self-talk that slipped past the schema ("Here is the letter:").
    return strip_leak_lines(vetted)


def compose_cover_letter(
    resume: MasterResume,
    job_text: str,
    *,
    company: str | None = None,
    role: str | None = None,
    tone: str = "modern",
    voice: VoiceProfile | None = None,
    evidence: list[str] | None = None,
    feedback: str | None = None,
    previous: list[str] | None = None,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> tuple[list[str], GuardrailReport]:
    """Standalone cover-letter generation for the writing studio.

    With `feedback` and `previous`, this is a revision rather than a fresh
    draft: the model is shown the letter it wrote and what to change about it,
    so the paragraphs the note does not touch survive verbatim.

    No job extraction is run — a lightweight requirements object (just role +
    company) is enough for the prompt, so this is a single LLM call. Paragraphs
    that make a claim neither the résumé nor the attested brag bank supports are
    dropped, and the report surfaces exactly what (if anything) was removed.
    """
    client = client or get_client()
    requirements = JobRequirements(title=role, company=company)
    result: LlmResult[CoverLetterDraft] = client.generate_structured(
        prompt=build_cover_letter_prompt(
            resume,
            requirements,
            job_text,
            tone=tone,
            voice=voice,
            evidence=evidence,
            feedback=feedback,
            previous=previous,
        ),
        schema=CoverLetterDraft,
        system_instruction=COVER_LETTER_SYSTEM,
        temperature=0.4,
    )
    if ledger is not None:
        ledger.record("cover_letter", result.usage)

    engine = GuardrailEngine(resume, requirements, evidence=evidence)
    vetted = [p for p in result.data.paragraphs if engine.vet_paragraph(p) is not None]
    # Only hard failures matter here; the soft proper-noun flags fire on the
    # company name itself (which of course isn't in the résumé) and would be noise.
    errors = [v for v in engine.violations if v.severity == "error"]
    report = GuardrailReport(
        violations=errors,
        keywords_requested=[],
        keywords_verified=[],
        bullet_confidence=[],
    )
    if not vetted:
        # Everything failed verification. Returning the raw draft here (as this
        # once did) was the one path where unverified claims reached the user,
        # which is exactly the promise the guardrails exist to keep. Return
        # nothing and let the report explain why, so the user can adjust the
        # inputs and regenerate.
        logger.warning(
            "pipeline.cover_letter_fully_rejected", violations=len(errors)
        )
    return vetted, report


def generate_outreach(
    resume: MasterResume,
    kind: str,
    *,
    company: str | None = None,
    role: str | None = None,
    recipient: str | None = None,
    context: str | None = None,
    source: str | None = None,
    voice: VoiceProfile | None = None,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> tuple[OutreachDraft, list[str]]:
    """Short-form outreach for the writing studio.

    The user reads and sends this themselves, and it legitimately draws on
    context they provide (a date they met, a mutual contact) that isn't in the
    résumé — so the truthfulness check here is advisory: it never edits the
    draft, it only flags numbers or claims the résumé doesn't back so the user
    can double-check before sending.
    """
    client = client or get_client()
    result: LlmResult[OutreachDraft] = client.generate_structured(
        prompt=build_outreach_prompt(
            kind,
            resume,
            company=company,
            role=role,
            recipient=recipient,
            context=context,
            source=source,
            voice=voice,
        ),
        schema=OutreachDraft,
        system_instruction=OUTREACH_SYSTEM,
        temperature=0.5,
    )
    if ledger is not None:
        ledger.record(f"outreach_{kind}", result.usage)

    warnings = _advisory_number_check(resume, result.data.body, context)
    return result.data, warnings


def _advisory_number_check(
    resume: MasterResume, body: str, context: str | None
) -> list[str]:
    """Flag numbers in ``body`` backed by neither the résumé nor the user's
    context. Advisory only — outreach may legitimately cite provided facts."""
    from app.services.llm.guardrails import _master_numbers, _numbers_in

    allowed = _master_numbers(resume) | _numbers_in(context or "")
    unbacked = sorted(_numbers_in(body) - allowed)
    if unbacked:
        return [
            "Double-check these figures before sending — they aren't in your "
            f"résumé or the context you gave: {', '.join(unbacked)}."
        ]
    return []


def run_pipeline(
    master: MasterResume,
    scrape: ScrapeResult,
    *,
    include_cover_letter: bool = False,
    evidence: list[str] | None = None,
    templates_dir: str | None = None,
    template: str | None = None,
    one_page: bool = False,
    reach: bool = False,
    client: LlmClient | None = None,
    fast_client: LlmClient | None = None,
    on_progress: ProgressCallback | None = None,
) -> TailoringOutcome:
    """Run every stage after scraping and return the finished artifacts.

    ``evidence`` is the candidate's brag bank, threaded into both the tailoring
    and cover-letter stages so attested facts are usable and never flagged.

    ``fast_client`` (optional) runs the mechanical steps — reading the job into
    requirements and coverage planning — on a cheap model (e.g. Gemini Flash),
    while ``client`` (the primary) does the writing. Falls back to ``client`` if
    the fast step errors, so a cheap-model hiccup never fails the run."""
    templates_dir = templates_dir or settings.templates_dir
    client = client or get_client()
    fast = fast_client or client
    ledger = UsageLedger()

    def progress(stage: str, message: str) -> None:
        if on_progress:
            on_progress(stage, message)

    progress("extracting", "Reading the job description")
    try:
        requirements = extract_requirements(scrape, client=fast, ledger=ledger)
    except LlmError:
        if fast is client:
            raise
        logger.info("pipeline.fast_extract_fell_back_to_primary")
        requirements = extract_requirements(scrape, client=client, ledger=ledger)

    progress("optimizing", "Tailoring your experience to the role")
    tailored, report, diff = optimize_resume(
        master, requirements, scrape.text, evidence=evidence, reach=reach,
        client=client, plan_client=fast, ledger=ledger,
    )

    cover_tex: str | None = None
    cover_pdf: bytes | None = None
    cover_paragraphs: list[str] = []
    if include_cover_letter:
        progress("optimizing", "Drafting your cover letter")
        cover_paragraphs = draft_cover_letter(
            tailored, requirements, scrape.text, evidence=evidence, client=client, ledger=ledger
        )
        if cover_paragraphs:
            cover_tex = render_cover_letter(
                tailored,
                cover_paragraphs,
                templates_dir,
                company=requirements.company,
                role=requirements.title,
            )

    progress("rendering", "Typesetting your PDF")
    compiled, resume_tex, tailored = render_and_fit(
        tailored,
        templates_dir,
        template_name=resolve_filename(template),
        one_page=one_page,
        job_name="resume",
    )
    # `tailored` is now what the PDF actually contains (one-page fit may have
    # trimmed bullets), so the stored/scored/exported résumé matches the document.

    if cover_tex:
        cover_compiled = compile_latex(cover_tex, job_name="cover_letter")
        cover_pdf = cover_compiled.pdf_bytes

    logger.info(
        "pipeline.completed",
        cost_usd=ledger.cost_usd,
        input_tokens=ledger.input_tokens,
        output_tokens=ledger.output_tokens,
        pages=compiled.page_count,
    )

    return TailoringOutcome(
        requirements=requirements,
        tailored_resume=tailored,
        guardrail_report=report,
        diff=diff,
        resume_tex=resume_tex,
        resume_pdf=compiled.pdf_bytes,
        cover_letter_tex=cover_tex,
        cover_letter_pdf=cover_pdf,
        cover_letter=cover_paragraphs or None,
        usage=ledger,
        page_count=compiled.page_count,
    )
