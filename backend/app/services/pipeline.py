"""The tailoring pipeline.

Sequence: scrape -> extract requirements -> optimize -> guardrail merge ->
render LaTeX -> compile PDF. Written as plain synchronous functions with no
Celery or FastAPI imports, so the whole thing is testable without a broker.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.logging import get_logger
from app.schemas.job import JobRequirements, ScrapeResult
from app.schemas.resume import MasterResume
from app.schemas.tailoring import DiffEntry, GuardrailReport, TailoringResult
from app.services.latex.compiler import CompileResult, compile_latex
from app.services.latex.renderer import render_cover_letter, render_resume
from app.services.llm.client import GeminiClient, LlmResult, Usage, get_client
from app.services.llm.guardrails import GuardrailEngine, build_diff
from app.services.llm.prompts import (
    COVER_LETTER_SYSTEM,
    EXTRACTOR_SYSTEM,
    OPTIMIZER_SYSTEM,
    build_cover_letter_prompt,
    build_extractor_prompt,
    build_optimizer_prompt,
)

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
    usage: UsageLedger = field(default_factory=UsageLedger)
    page_count: int = 1


def extract_requirements(
    scrape: ScrapeResult,
    *,
    client: GeminiClient | None = None,
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


def optimize_resume(
    master: MasterResume,
    requirements: JobRequirements,
    job_text: str,
    *,
    client: GeminiClient | None = None,
    ledger: UsageLedger | None = None,
) -> tuple[MasterResume, GuardrailReport, list[DiffEntry]]:
    """Stage 3: rewrite presentation, then enforce truthfulness."""
    client = client or get_client()
    result: LlmResult[TailoringResult] = client.generate_structured(
        prompt=build_optimizer_prompt(master, requirements, job_text),
        schema=TailoringResult,
        system_instruction=OPTIMIZER_SYSTEM,
        temperature=settings.llm_temperature,
    )
    if ledger is not None:
        ledger.record("optimize_resume", result.usage)

    tailored, report = GuardrailEngine(master, requirements).apply(result.data)
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


def draft_cover_letter(
    resume: MasterResume,
    requirements: JobRequirements,
    job_text: str,
    *,
    client: GeminiClient | None = None,
    ledger: UsageLedger | None = None,
) -> list[str]:
    """Optional stage: draft cover letter paragraphs, vetted like everything else."""
    client = client or get_client()
    result: LlmResult[CoverLetterDraft] = client.generate_structured(
        prompt=build_cover_letter_prompt(resume, requirements, job_text),
        schema=CoverLetterDraft,
        system_instruction=COVER_LETTER_SYSTEM,
        temperature=0.4,
    )
    if ledger is not None:
        ledger.record("cover_letter", result.usage)

    # Reuse the resume guardrails: a cover letter must not out-claim the resume.
    engine = GuardrailEngine(resume, requirements)
    vetted: list[str] = []
    for paragraph in result.data.paragraphs:
        if engine.vet_paragraph(paragraph) is not None:
            vetted.append(paragraph)
        else:
            logger.warning("pipeline.cover_letter_paragraph_rejected")
    return vetted


def run_pipeline(
    master: MasterResume,
    scrape: ScrapeResult,
    *,
    include_cover_letter: bool = False,
    templates_dir: str | None = None,
    client: GeminiClient | None = None,
    on_progress: ProgressCallback | None = None,
) -> TailoringOutcome:
    """Run every stage after scraping and return the finished artifacts."""
    templates_dir = templates_dir or settings.templates_dir
    client = client or get_client()
    ledger = UsageLedger()

    def progress(stage: str, message: str) -> None:
        if on_progress:
            on_progress(stage, message)

    progress("extracting", "Reading the job description")
    requirements = extract_requirements(scrape, client=client, ledger=ledger)

    progress("optimizing", "Tailoring your experience to the role")
    tailored, report, diff = optimize_resume(
        master, requirements, scrape.text, client=client, ledger=ledger
    )

    cover_tex: str | None = None
    cover_pdf: bytes | None = None
    if include_cover_letter:
        progress("optimizing", "Drafting your cover letter")
        paragraphs = draft_cover_letter(
            tailored, requirements, scrape.text, client=client, ledger=ledger
        )
        if paragraphs:
            cover_tex = render_cover_letter(
                tailored,
                paragraphs,
                templates_dir,
                company=requirements.company,
                role=requirements.title,
            )

    progress("rendering", "Typesetting your PDF")
    resume_tex = render_resume(tailored, templates_dir)
    compiled: CompileResult = compile_latex(resume_tex, job_name="resume")

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
        usage=ledger,
        page_count=compiled.page_count,
    )
