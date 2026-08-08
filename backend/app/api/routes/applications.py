"""Application endpoints: start a tailoring run, poll it, download artifacts."""

from __future__ import annotations

import contextlib
import io
import json
import uuid
import zipfile
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession, GenerationUser
from app.core.config import settings
from app.core.logging import get_logger
from app.models.application import (
    Application,
    ApplicationArtifact,
    ArtifactKind,
    PipelineStatus,
    TrackerStatus,
)
from app.models.job import Job
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.schemas.api import (
    ApplicationCreate,
    ApplicationDetail,
    ApplicationStatusResponse,
    ApplicationSummary,
    ApplicationUpdate,
    AssistantApplyRequest,
    AssistantProposal,
    AssistantReviseRequest,
    CoverLetterRequest,
    JobSignalsResponse,
    OutreachDraftResponse,
    OutreachRequest,
    QualityBullet,
    QualityInspect,
    Scorecard,
    ScorecardMetric,
    ScorecardSuggestion,
)
from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.schemas.tailoring import (
    GuardrailReport,
    TailoredEntry,
    TailoredSkillGroup,
    TailoringResult,
)
from app.services import storage
from app.services.evidence import evidence_lines
from app.services.job_signals import analyze_job
from app.services.latex.compiler import LatexCompilationError, compile_latex
from app.services.latex.renderer import render_and_fit, render_cover_letter
from app.services.latex.templates import resolve_filename
from app.services.llm.client import LlmConfigurationError, LlmError
from app.services.llm.factory import client_for_user
from app.services.llm.guardrails import GuardrailEngine, build_diff
from app.services.pipeline import (
    UsageLedger,
    draft_cover_letter,
    generate_outreach,
    revise_resume,
)
from app.services.resume_eval import (
    filter_company_keywords,
    inspect_resume,
    score_from_report,
    suggestions_from_report,
)
from app.services.scraper import ScrapeError, from_pasted_text, scrape_job
from app.services.usage import accrue_usage
from app.workers.tasks import enqueue_tailoring

router = APIRouter(prefix="/applications", tags=["applications"])
logger = get_logger(__name__)

_ARTIFACT_MEDIA = {
    "resume_pdf": ("application/pdf", "resume.pdf"),
    "cover_letter_pdf": ("application/pdf", "cover_letter.pdf"),
    "resume_tex": ("application/x-tex", "resume.tex"),
    "cover_letter_tex": ("application/x-tex", "cover_letter.tex"),
}


def _get_owned(db: DbSession, user_id: uuid.UUID, application_id: uuid.UUID) -> Application:
    application = db.scalar(
        select(Application)
        .where(Application.id == application_id)
        .options(selectinload(Application.artifacts), selectinload(Application.job))
    )
    if application is None or application.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Application not found."
        )
    return application


def _resolve_resume(db: DbSession, user_id: uuid.UUID, profile_id: uuid.UUID | None) -> ResumeProfile:
    if profile_id is not None:
        profile = db.get(ResumeProfile, profile_id)
        if profile is None or profile.user_id != user_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Resume profile not found."
            )
        return profile

    profile = db.scalar(
        select(ResumeProfile)
        .where(ResumeProfile.user_id == user_id)
        .order_by(ResumeProfile.is_default.desc(), ResumeProfile.updated_at.desc())
        .limit(1)
    )
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Upload a master resume before creating an application.",
        )
    return profile


def _resolve_job(db: DbSession, user_id: uuid.UUID, payload: ApplicationCreate) -> Job:
    if payload.job_id is not None:
        job = db.get(Job, payload.job_id)
        if job is None or job.user_id != user_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Job not found."
            )
        return job

    assert payload.job is not None  # guaranteed by the model validator
    source = payload.job
    try:
        scrape = (
            scrape_job(source.url)
            if source.url
            else from_pasted_text(
                source.text or "", title=source.title, company=source.company
            )
        )
    except ScrapeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    job = Job(
        user_id=user_id,
        url=scrape.url,
        source=scrape.source,
        title=source.title or scrape.title,
        company=source.company or scrape.company,
        location=scrape.location,
        raw_text=scrape.text,
    )
    db.add(job)
    db.flush()
    return job


@router.post("", response_model=ApplicationDetail, status_code=status.HTTP_202_ACCEPTED)
def create_application(
    payload: ApplicationCreate, user: GenerationUser, db: DbSession
) -> ApplicationDetail:
    """Create an application and queue the tailoring pipeline."""
    profile = _resolve_resume(db, user.id, payload.resume_profile_id)
    job = _resolve_job(db, user.id, payload)

    application = Application(
        user_id=user.id,
        job_id=job.id,
        resume_profile_id=profile.id,
        pipeline_status=PipelineStatus.PENDING,
        include_cover_letter=payload.include_cover_letter,
        reach_mode=payload.reach_mode,
        notes=payload.notes,
    )
    db.add(application)
    db.commit()
    db.refresh(application)

    _queue_run(db, application)
    db.refresh(application)

    logger.info(
        "application.queued",
        application_id=str(application.id),
        task_id=application.celery_task_id,
        user_id=str(user.id),
    )
    return _to_detail(application)


def _to_detail(application: Application) -> ApplicationDetail:
    detail = ApplicationDetail.model_validate(application)
    detail.scorecard = _scorecard_for(application)
    if application.job:
        sig = analyze_job(application.job.title, application.job.location, application.job.raw_text)
        detail.job_signals = JobSignalsResponse(
            red_flags=sig.red_flags, geo_mismatch=sig.geo_mismatch,
            injection=sig.injection, thin=sig.thin, word_count=sig.word_count,
        )
    # Drop the employer's own name from the keyword lists the UI reads, so the
    # header "Keyword match" and the ATS panel agree with the scorecard.
    if detail.guardrail_report:
        company = application.job.company if application.job else None
        for key in ("keywords_requested", "keywords_verified"):
            values = detail.guardrail_report.get(key)
            if isinstance(values, list):
                detail.guardrail_report[key] = filter_company_keywords(values, company)
    return detail


def _scorecard_for(application: Application) -> Scorecard | None:
    """Deterministic quality readout from what's already stored — no LLM.

    Only for a finished run that produced a tailored résumé + guardrail report.
    A malformed stored blob must never 500 the detail page, so it's best-effort.
    """
    if not application.tailored_resume or not application.guardrail_report:
        return None
    try:
        tailored = MasterResume.model_validate(application.tailored_resume)
        report = GuardrailReport.model_validate(application.guardrail_report)
        company = application.job.company if application.job else None
        card = score_from_report(tailored, report, company=company)
        tips = suggestions_from_report(tailored, report, company=company)
        return Scorecard(
            overall=card.overall,
            metrics=[
                ScorecardMetric(key=m.key, label=m.label, score=m.score, detail=m.detail, measured=m.measured)
                for m in card.metrics
            ],
            suggestions=[
                ScorecardSuggestion(
                    key=t.key, title=t.title, detail=t.detail,
                    metric_key=t.metric_key, keywords=t.keywords, instruction=t.instruction,
                )
                for t in tips
            ],
        )
    except Exception:  # noqa: BLE001 - a bad blob shouldn't break the page
        return None


def _queue_run(db: DbSession, application: Application) -> None:
    """Hand the run to the worker, or fail the application loudly.

    If the broker is unreachable the row would otherwise sit at PENDING for
    ever, with the UI polling a run that nobody is ever going to pick up. Mark
    it failed with a message that invites a retry, and tell the caller it was
    an infrastructure problem rather than returning a bare 500.
    """
    try:
        application.celery_task_id = enqueue_tailoring(application.id)
    except Exception as exc:  # noqa: BLE001 - any publish failure is a 503
        application.pipeline_status = PipelineStatus.FAILED
        application.error_message = (
            "This run could not be queued because the job queue was "
            "unavailable. Press Retry to try again."
        )
        db.commit()
        logger.error(
            "application.enqueue_failed",
            application_id=str(application.id),
            error=str(exc)[:200],
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The job queue is unavailable right now. Please try again shortly.",
        ) from exc
    db.commit()


@router.get("", response_model=list[ApplicationSummary])
def list_applications(
    user: CurrentUser,
    db: DbSession,
    response: Response,
    tracker_status: TrackerStatus | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[ApplicationSummary]:
    """One page of the caller's applications, newest first.

    ``X-Total-Count`` reports how many match the filter in total, which the page
    itself cannot convey. Without it a client had no way to know it was seeing a
    truncated view: the board asked for 200, silently dropped everything beyond
    that, and then rendered its own page length as the user's total — so the
    tracker disagreed with the dashboard and older applications were unreachable
    even by search.
    """
    filters = [Application.user_id == user.id]
    if tracker_status is not None:
        filters.append(Application.tracker_status == tracker_status)

    response.headers["X-Total-Count"] = str(
        db.scalar(select(func.count(Application.id)).where(*filters)) or 0
    )

    stmt = (
        select(Application)
        .where(*filters)
        .options(selectinload(Application.job))
        # created_at alone is not a total order - applications created in the
        # same instant could otherwise repeat or vanish across pages.
        .order_by(Application.created_at.desc(), Application.id.desc())
        .limit(limit)
        .offset(offset)
    )

    return [
        ApplicationSummary(
            id=a.id,
            pipeline_status=a.pipeline_status,
            tracker_status=a.tracker_status,
            job_title=a.job.title if a.job else None,
            company=a.job.company if a.job else None,
            total_cost_usd=a.total_cost_usd,
            interview_at=a.interview_at,
            reminder_at=a.reminder_at,
            has_notes=bool(a.notes and a.notes.strip()),
            created_at=a.created_at,
            updated_at=a.updated_at,
        )
        for a in db.scalars(stmt)
    ]


@router.get("/{application_id}", response_model=ApplicationDetail)
def get_application(
    application_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> ApplicationDetail:
    return _to_detail(_get_owned(db, user.id, application_id))


@router.get("/{application_id}/quality/inspect", response_model=QualityInspect)
def inspect_quality(
    application_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> QualityInspect:
    """The specific bullets/keywords behind each fixable metric — powers the
    per-metric 'fix it' side panel. Deterministic, no LLM."""
    application = _get_owned(db, user.id, application_id)
    if not application.tailored_resume or not application.guardrail_report:
        return QualityInspect()
    tailored = MasterResume.model_validate(application.tailored_resume)
    report = GuardrailReport.model_validate(application.guardrail_report)
    company = application.job.company if application.job else None
    data = inspect_resume(tailored, report, company=company)

    def to_bullets(items: list) -> list[QualityBullet]:
        return [QualityBullet(id=b.id, where=b.where, text=b.text, note=b.note) for b in items]

    return QualityInspect(
        keywords=data["keywords"],
        impact=to_bullets(data["impact"]),
        verbs=to_bullets(data["verbs"]),
        conciseness=to_bullets(data["conciseness"]),
    )


@router.get("/{application_id}/status", response_model=ApplicationStatusResponse)
def get_status(
    application_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> ApplicationStatusResponse:
    """Cheap polling endpoint for the frontend's progress indicator."""
    application = _get_owned(db, user.id, application_id)
    return ApplicationStatusResponse(
        id=application.id,
        pipeline_status=application.pipeline_status,
        error_message=application.error_message,
        stage_message=_STAGE_MESSAGES.get(application.pipeline_status),
        has_pdf=any(a.kind.value == "resume_pdf" for a in application.artifacts),
    )


_STAGE_MESSAGES = {
    PipelineStatus.PENDING: "Queued",
    PipelineStatus.SCRAPING: "Reading the job posting",
    PipelineStatus.EXTRACTING: "Extracting requirements",
    PipelineStatus.OPTIMIZING: "Tailoring your experience",
    PipelineStatus.RENDERING: "Typesetting your PDF",
    PipelineStatus.COMPLETED: "Ready",
    PipelineStatus.FAILED: "Failed",
}


@router.patch("/{application_id}", response_model=ApplicationDetail)
def update_application(
    application_id: uuid.UUID,
    payload: ApplicationUpdate,
    user: CurrentUser,
    db: DbSession,
) -> ApplicationDetail:
    application = _get_owned(db, user.id, application_id)
    fields = payload.model_fields_set
    if payload.tracker_status is not None:
        application.tracker_status = payload.tracker_status
    if payload.notes is not None:
        application.notes = payload.notes
    # These are nullable and clearable: a field only changes if the client
    # actually sent it, and sending null clears it.
    if "interview_at" in fields:
        application.interview_at = payload.interview_at
    if "reminder_at" in fields:
        application.reminder_at = payload.reminder_at
    db.commit()
    db.refresh(application)
    return _to_detail(application)


@router.post("/{application_id}/retry", response_model=ApplicationDetail)
def retry_application(
    application_id: uuid.UUID, user: GenerationUser, db: DbSession
) -> ApplicationDetail:
    application = _get_owned(db, user.id, application_id)
    if application.pipeline_status not in (PipelineStatus.FAILED, PipelineStatus.COMPLETED):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This application is still running.",
        )

    application.pipeline_status = PipelineStatus.PENDING
    application.error_message = None
    db.commit()

    _queue_run(db, application)
    db.refresh(application)
    return _to_detail(application)


def _build_report(application: Application) -> str:
    """A plain-text application report: what was tailored and what was verified."""
    job = application.job
    lines: list[str] = [
        "HireCraft — Application Report",
        "=" * 40,
        f"Role:    {(job.title if job else None) or 'Untitled role'}",
        f"Company: {(job.company if job else None) or '—'}",
        f"Stage:   {application.tracker_status.value}",
        "",
    ]

    report = application.guardrail_report or {}
    requested = report.get("keywords_requested") or []
    verified = report.get("keywords_verified") or []
    if requested:
        missing = [k for k in requested if k not in verified]
        lines += [
            "ATS keyword coverage",
            "-" * 40,
            f"Covered ({len(verified)}/{len(requested)}): {', '.join(verified) or '—'}",
            f"Not backed by your résumé: {', '.join(missing) or 'none'}",
            "",
        ]

    confidence = report.get("bullet_confidence") or []
    if confidence:
        counts: dict[str, int] = {}
        for item in confidence:
            level = item.get("confidence", "unknown")
            counts[level] = counts.get(level, 0) + 1
        summary = ", ".join(f"{n} {level}" for level, n in sorted(counts.items()))
        lines += [
            "Truthfulness verdicts (per bullet)",
            "-" * 40,
            summary,
            "",
        ]

    locks = report.get("locks") or []
    if locks:
        lines += ["Locked facts the AI could not change", "-" * 40, *[f"- {lock}" for lock in locks], ""]

    violations = report.get("violations") or []
    blocked = [v for v in violations if v.get("severity") == "error"]
    if blocked:
        lines += [
            f"Claims blocked for your protection ({len(blocked)})",
            "-" * 40,
            *[f"- {v.get('detail', '')}" for v in blocked],
            "",
        ]

    lines += [
        "-" * 40,
        "Every statement in the tailored résumé traces back to your master "
        "résumé. Generated by HireCraft.",
    ]
    return "\n".join(lines)


def _diff_text(diff: list[dict]) -> str:
    """A readable before→after of the tailoring, for the package export."""
    out = ["Changes vs. your master résumé", "=" * 40, ""]

    def fmt(value: object) -> list[str]:
        if isinstance(value, list):
            return [f"    {v}" for v in value]
        return [f"    {value}"] if value else []

    any_change = False
    for d in diff:
        change = d.get("change")
        if change in (None, "unchanged"):
            continue
        any_change = True
        head = f"[{d.get('section', '')}] {d.get('label') or d.get('field') or ''}".strip()
        out.append(f"{head} — {change}")
        if d.get("before"):
            out += ["  - before:", *fmt(d["before"])]
        if d.get("after"):
            out += ["  + after:", *fmt(d["after"])]
        out.append("")
    if not any_change:
        return "No changes were recorded for this tailoring.\n"
    return "\n".join(out)


def _match_analysis(application: Application) -> dict[str, Any] | None:
    """Structured quality + posting signals, for offline review/versioning."""
    data: dict[str, Any] = {}
    card = _scorecard_for(application)
    if card is not None:
        data["scorecard"] = card.model_dump(mode="json")
    if application.job is not None:
        sig = analyze_job(application.job.title, application.job.location, application.job.raw_text)
        data["job_signals"] = {
            "red_flags": sig.red_flags,
            "geo_mismatch": sig.geo_mismatch,
            "injection": sig.injection,
            "thin": sig.thin,
            "word_count": sig.word_count,
        }
    return data or None


@router.get("/{application_id}/download/package")
def download_package(
    application_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> Response:
    """Bundle the full tailoring session into one zip — a true export.

    Documents you send (résumé + cover letter, PDF and LaTeX) plus the structured
    session data (résumé JSON, the job description, guardrail findings, the
    change diff, and the quality/match analysis), so the download stands alone
    for offline review, debugging, and version control.
    """
    application = _get_owned(db, user.id, application_id)

    artifact_names = {
        "resume_pdf": "resume.pdf",
        "resume_tex": "resume.tex",
        "cover_letter_pdf": "cover_letter.pdf",
        "cover_letter_tex": "cover_letter.tex",
    }
    available = {a.kind.value: a for a in application.artifacts if a.kind.value in artifact_names}
    if not available:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No documents have been generated for this application yet.",
        )

    company = (application.job.company if application.job else None) or "application"
    base = storage.safe_filename(company.replace(" ", "_"), fallback="application")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        def add(name: str, data: bytes | str) -> None:
            archive.writestr(f"{base}/{name}", data)

        # Sendable documents (résumé + cover letter, PDF + LaTeX).
        for kind, filename in artifact_names.items():
            artifact = available.get(kind)
            if artifact is None:
                continue
            try:
                add(filename, storage.read_bytes(artifact.storage_path))
            except storage.StorageError:
                logger.warning(
                    "application.package_artifact_missing",
                    application_id=str(application.id),
                    kind=kind,
                )

        # Self-documenting report + structured session data (best-effort: a bad
        # stored blob must never 500 the export).
        add("report.txt", _build_report(application))
        with contextlib.suppress(Exception):
            if application.tailored_resume:
                add("resume.json", json.dumps(application.tailored_resume, indent=2, ensure_ascii=False))
            if application.job and application.job.raw_text:
                add("job_description.txt", application.job.raw_text)
            if application.guardrail_report:
                add("guardrails.json", json.dumps(application.guardrail_report, indent=2, ensure_ascii=False))
            if application.diff:
                add("changes.diff", _diff_text(application.diff))
            match = _match_analysis(application)
            if match:
                add("match_analysis.json", json.dumps(match, indent=2, ensure_ascii=False))

    buffer.seek(0)
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{base}_package.zip"'
        },
    )


@router.get("/{application_id}/download/{kind}")
def download_artifact(
    application_id: uuid.UUID, kind: str, user: CurrentUser, db: DbSession
) -> Response:
    # NB: this catch-all `{kind}` route is declared AFTER the literal
    # `/download/package` route above, so "package" is matched by that handler
    # rather than falling in here as an unknown kind.
    if kind not in _ARTIFACT_MEDIA:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown artifact kind {kind!r}.",
        )

    application = _get_owned(db, user.id, application_id)
    artifact = next((a for a in application.artifacts if a.kind.value == kind), None)
    if artifact is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No {kind} has been generated for this application yet.",
        )

    media_type, default_name = _ARTIFACT_MEDIA[kind]
    company = (application.job.company if application.job else None) or "application"
    filename = storage.safe_filename(
        f"{company}_{default_name}".replace(" ", "_"), fallback=default_name
    )

    try:
        path = storage.resolve_path(artifact.storage_path)
    except storage.StorageError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Artifact is unavailable."
        ) from exc
    if not path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Artifact file is missing."
        )

    return FileResponse(path=path, media_type=media_type, filename=filename)


# --- Grounded assistant: revise + apply -------------------------------------


def _tailoring_result_from(resume: MasterResume) -> TailoringResult:
    """Rebuild a TailoringResult from a résumé so the guardrail engine can re-vet
    an applied revision against the master before it is saved."""
    return TailoringResult(
        headline=resume.basics.headline,
        summary=resume.basics.summary,
        experience=[TailoredEntry(id=e.id, highlights=list(e.highlights)) for e in resume.experience],
        projects=[TailoredEntry(id=p.id, highlights=list(p.highlights)) for p in resume.projects],
        education=[TailoredEntry(id=ed.id, highlights=list(ed.highlights)) for ed in resume.education],
        skills=[TailoredSkillGroup(category=g.category, items=list(g.items)) for g in resume.skills],
    )


def _summarize_diff(diff: list) -> str:
    if not diff:
        return "No changes were needed — your résumé already reads well for that request."
    where = sorted({d.section for d in diff})
    n = len(diff)
    return (
        f"Proposed {n} change{'s' if n != 1 else ''} in {', '.join(where)}. "
        "Review the diff below, then apply if it looks right."
    )


def _resume_context(
    db: DbSession, user_id: uuid.UUID, application: Application
) -> tuple[MasterResume | None, list[str], JobRequirements | None, ResumeProfile | None]:
    """Master résumé (guardrail source of truth), brag-bank evidence, job requirements."""
    profile = db.get(ResumeProfile, application.resume_profile_id)
    master = MasterResume.model_validate(profile.content) if profile else None
    evidence = evidence_lines(db, user_id)
    requirements = None
    if application.job and application.job.requirements:
        with contextlib.suppress(Exception):
            requirements = JobRequirements.model_validate(application.job.requirements)
    return master, evidence, requirements, profile


def _charge(db: DbSession, user_id: uuid.UUID, application: Application, ledger: UsageLedger) -> None:
    for purpose, usage in ledger.entries:
        db.add(
            LlmUsage(
                user_id=user_id, purpose=purpose, model=usage.model,
                input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
                cost_usd=usage.cost_usd, latency_ms=usage.latency_ms,
            )
        )
    # Fold this run's spend into the application's totals + per-workflow breakdown.
    accrue_usage(application, ledger.entries)


def _write_artifact(
    db: DbSession, application: Application, user_id: uuid.UUID,
    kind: ArtifactKind, filename: str, data: bytes, content_type: str,
) -> None:
    """Overwrite (or create) a stored artifact file for this application."""
    relative = storage.build_relative_path(user_id, application.id, filename)
    size = storage.save_bytes(relative, data)
    existing = next((a for a in application.artifacts if a.kind == kind), None)
    if existing is not None:
        existing.storage_path = relative
        existing.size_bytes = size
        existing.content_type = content_type
    else:
        application.artifacts.append(
            ApplicationArtifact(kind=kind, storage_path=relative, size_bytes=size, content_type=content_type)
        )


@router.post("/{application_id}/assistant/revise", response_model=AssistantProposal)
def assistant_revise(
    application_id: uuid.UUID, payload: AssistantReviseRequest, user: GenerationUser, db: DbSession
) -> AssistantProposal:
    """Propose a grounded, guardrailed revision of the tailored résumé. Saves nothing."""
    application = _get_owned(db, user.id, application_id)
    if application.pipeline_status != PipelineStatus.COMPLETED or not application.tailored_resume:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This application isn't ready to revise yet.")
    current = MasterResume.model_validate(application.tailored_resume)
    master, evidence, requirements, _ = _resume_context(db, user.id, application)
    if master is None:
        master = current

    try:
        client = client_for_user(user)
    except LlmConfigurationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    ledger = UsageLedger()
    try:
        revised, report, diff = revise_resume(
            current, master, payload.instruction,
            evidence=evidence, requirements=requirements, client=client, ledger=ledger,
        )
    except LlmError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"The AI service is unavailable right now: {exc}") from exc

    _charge(db, user.id, application, ledger)
    db.commit()

    return AssistantProposal(
        note=_summarize_diff(diff),
        diff=[d.model_dump(mode="json") for d in diff],
        proposed=revised.model_dump(mode="json"),
        blocked=[v.detail for v in report.violations if v.severity == "error"],
    )


@router.post("/{application_id}/assistant/apply", response_model=ApplicationDetail)
def assistant_apply(
    application_id: uuid.UUID, payload: AssistantApplyRequest, user: CurrentUser, db: DbSession
) -> ApplicationDetail:
    """Apply a proposed revision: re-vet against the master, update the tailored
    résumé + diff + guardrails, and re-render the stored PDF/TeX."""
    application = _get_owned(db, user.id, application_id)
    proposed = payload.proposed
    master, evidence, requirements, profile = _resume_context(db, user.id, application)
    if master is None:
        master = proposed

    # Re-vet on apply (defense in depth) by merging the proposal onto the master.
    merged, report = GuardrailEngine(master, requirements, evidence=evidence).apply(
        _tailoring_result_from(proposed)
    )

    template = resolve_filename(profile.template if profile else None)
    one_page = profile.one_page if profile else False
    try:
        compiled, resume_tex = render_and_fit(
            merged, settings.templates_dir, template_name=template, one_page=one_page, job_name="resume"
        )
    except Exception as exc:  # noqa: BLE001 - typesetting failure -> friendly 422
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"Couldn't typeset the revised résumé: {exc}"
        ) from exc

    _write_artifact(db, application, user.id, ArtifactKind.RESUME_PDF, "resume.pdf", compiled.pdf_bytes, "application/pdf")
    _write_artifact(db, application, user.id, ArtifactKind.RESUME_TEX, "resume.tex", resume_tex.encode("utf-8"), "application/x-tex")

    application.tailored_resume = merged.model_dump(mode="json")
    application.diff = [d.model_dump(mode="json") for d in build_diff(master, merged)]
    application.guardrail_report = report.model_dump(mode="json")
    db.commit()
    db.refresh(application)
    logger.info("application.assistant_applied", application_id=str(application_id), pages=compiled.page_count)
    return _to_detail(application)


@router.post("/{application_id}/cover-letter", response_model=ApplicationDetail)
def generate_cover_letter(
    application_id: uuid.UUID, payload: CoverLetterRequest, user: GenerationUser, db: DbSession
) -> ApplicationDetail:
    """Draft, redraft, or revise-from-feedback a grounded cover letter and store it."""
    application = _get_owned(db, user.id, application_id)
    if not application.tailored_resume:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Tailor the résumé first — the cover letter is written from it.",
        )
    resume = MasterResume.model_validate(application.tailored_resume)
    _, evidence, requirements, _ = _resume_context(db, user.id, application)
    if requirements is None:
        title = (application.job.title if application.job else None) or "the role"
        company = application.job.company if application.job else None
        requirements = JobRequirements(title=title, company=company)
    job_text = (application.job.raw_text if application.job else "") or ""

    try:
        client = client_for_user(user)
    except LlmConfigurationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    ledger = UsageLedger()
    try:
        paragraphs = draft_cover_letter(
            resume, requirements, job_text,
            tone=payload.tone,
            feedback=payload.feedback,
            previous=application.cover_letter if payload.feedback else None,
            evidence=evidence, client=client, ledger=ledger,
        )
    except LlmError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"The AI service is unavailable right now: {exc}") from exc
    if not paragraphs:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Couldn't draft a cover letter grounded in your résumé. Please try again.",
        )

    tex = render_cover_letter(
        resume, paragraphs, settings.templates_dir,
        company=requirements.company, role=requirements.title,
    )
    try:
        compiled = compile_latex(tex, job_name="cover_letter")
    except LatexCompilationError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, f"Couldn't typeset the cover letter: {exc.summary()}"
        ) from exc

    _write_artifact(db, application, user.id, ArtifactKind.COVER_LETTER_PDF, "cover_letter.pdf", compiled.pdf_bytes, "application/pdf")
    _write_artifact(db, application, user.id, ArtifactKind.COVER_LETTER_TEX, "cover_letter.tex", tex.encode("utf-8"), "application/x-tex")
    application.cover_letter = paragraphs
    application.include_cover_letter = True
    _charge(db, user.id, application, ledger)
    db.commit()
    db.refresh(application)
    logger.info("application.cover_letter_generated", application_id=str(application_id))
    return _to_detail(application)


@router.post("/{application_id}/outreach", response_model=OutreachDraftResponse)
def application_outreach(
    application_id: uuid.UUID, payload: OutreachRequest, user: GenerationUser, db: DbSession
) -> OutreachDraftResponse:
    """Draft a short, grounded outreach message (recruiter email, follow-up, referral)."""
    application = _get_owned(db, user.id, application_id)
    if not application.tailored_resume:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tailor the résumé first.")
    resume = MasterResume.model_validate(application.tailored_resume)
    company = application.job.company if application.job else None
    role = application.job.title if application.job else None

    try:
        client = client_for_user(user)
    except LlmConfigurationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    ledger = UsageLedger()
    try:
        draft, warnings = generate_outreach(
            resume, payload.kind, company=company, role=role,
            recipient=payload.recipient, context=payload.context, source=payload.source,
            client=client, ledger=ledger,
        )
    except LlmError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"The AI service is unavailable right now: {exc}") from exc

    _charge(db, user.id, application, ledger)
    db.commit()
    return OutreachDraftResponse(subject=draft.subject, body=draft.body, warnings=warnings)


@router.delete("/{application_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_application(
    application_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> None:
    application = _get_owned(db, user.id, application_id)
    try:
        storage.delete_prefix(f"{user.id}/{application.id}")
    except storage.StorageError:
        logger.warning("application.artifact_cleanup_failed", application_id=str(application.id))
    db.delete(application)
    db.commit()
