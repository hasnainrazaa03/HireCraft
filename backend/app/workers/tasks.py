"""Celery tasks.

The task owns persistence and status transitions; ``app.services.pipeline`` owns
the actual work. Keeping that split means the pipeline stays testable without a
broker, and the task stays a thin, auditable state machine.
"""

from __future__ import annotations

import uuid

from celery.exceptions import SoftTimeLimitExceeded

from app.core.logging import get_logger
from app.db.session import session_scope
from app.models.application import (
    Application,
    ApplicationArtifact,
    ArtifactKind,
    PipelineStatus,
)
from app.models.llm_usage import LlmUsage
from app.schemas.job import ScrapeResult
from app.schemas.resume import MasterResume
from app.services import storage
from app.services.email.sender import Email, EmailError, send_email
from app.services.evidence import evidence_lines
from app.services.latex.compiler import LatexCompilationError
from app.services.llm.client import LlmConfigurationError, LlmError
from app.services.llm.factory import LlmClient, client_for_user
from app.services.pipeline import TailoringOutcome, run_pipeline
from app.services.usage import accrue_usage
from app.workers.celery_app import celery_app

logger = get_logger(__name__)


def _set_status(application_id: str, status: PipelineStatus, error: str | None = None) -> None:
    with session_scope() as db:
        application = db.get(Application, uuid.UUID(application_id))
        if application is None:
            return
        application.pipeline_status = status
        if error is not None:
            # Keep the column bounded; full detail is in the logs.
            application.error_message = error[:2000]


def _persist(application_id: uuid.UUID, user_id: uuid.UUID, outcome: TailoringOutcome) -> None:
    """Write artifacts to storage and the run's results to the database."""
    artifacts: list[tuple[ArtifactKind, str, bytes, str]] = [
        (ArtifactKind.RESUME_PDF, "resume.pdf", outcome.resume_pdf, "application/pdf"),
        (
            ArtifactKind.RESUME_TEX,
            "resume.tex",
            outcome.resume_tex.encode("utf-8"),
            "application/x-tex",
        ),
    ]
    if outcome.cover_letter_pdf and outcome.cover_letter_tex:
        artifacts += [
            (
                ArtifactKind.COVER_LETTER_PDF,
                "cover_letter.pdf",
                outcome.cover_letter_pdf,
                "application/pdf",
            ),
            (
                ArtifactKind.COVER_LETTER_TEX,
                "cover_letter.tex",
                outcome.cover_letter_tex.encode("utf-8"),
                "application/x-tex",
            ),
        ]

    with session_scope() as db:
        application = db.get(Application, application_id)
        if application is None:
            logger.warning("task.application_vanished", application_id=str(application_id))
            return

        # A retry must not stack a second set of artifacts on the first.
        for existing in list(application.artifacts):
            db.delete(existing)
        db.flush()

        for kind, filename, data, content_type in artifacts:
            relative = storage.build_relative_path(user_id, application_id, filename)
            size = storage.save_bytes(relative, data)
            db.add(
                ApplicationArtifact(
                    application_id=application_id,
                    kind=kind,
                    storage_path=relative,
                    size_bytes=size,
                    content_type=content_type,
                )
            )

        application.tailored_resume = outcome.tailored_resume.model_dump(mode="json")
        application.diff = [d.model_dump(mode="json") for d in outcome.diff]
        application.guardrail_report = outcome.guardrail_report.model_dump(mode="json")
        # Reset the cost rollup: a fresh (or retried) tailoring replaces everything.
        accrue_usage(application, outcome.usage.entries, reset=True)
        application.pipeline_status = PipelineStatus.COMPLETED
        application.error_message = None

        for purpose, usage in outcome.usage.entries:
            db.add(
                LlmUsage(
                    user_id=user_id,
                    application_id=application_id,
                    purpose=purpose,
                    model=usage.model,
                    input_tokens=usage.input_tokens,
                    output_tokens=usage.output_tokens,
                    cost_usd=usage.cost_usd,
                    latency_ms=usage.latency_ms,
                )
            )

        job = application.job
        if job is not None and outcome.requirements is not None:
            job.requirements = outcome.requirements.model_dump(mode="json")
            job.title = job.title or outcome.requirements.title
            job.company = job.company or outcome.requirements.company
            job.location = job.location or outcome.requirements.location


def enqueue_tailoring(application_id: uuid.UUID | str) -> str:
    """Publish a tailoring run and return the task id.

    ``ignore_result=True`` is load-bearing rather than an optimisation. Without
    it, publishing makes Celery pre-subscribe to the task's result channel, and
    with Redis unreachable that reconnect loop blocked the calling request for
    ~19 seconds before failing — long enough for an outage to occupy every
    request thread and take down endpoints that need nothing from Redis. With
    it, the publish gives up in ~0.2s and raises a broker error the route can
    turn into a 503.

    Nothing ever reads a task's return value: progress is the application's
    own ``pipeline_status``, polled over HTTP. The subscription was pure cost.
    """
    async_result = run_tailoring_task.apply_async(
        args=[str(application_id)], ignore_result=True
    )
    return async_result.id


@celery_app.task(
    bind=True,
    name="hirecraft.run_tailoring",
    max_retries=2,
    default_retry_delay=30,
)
def run_tailoring_task(self, application_id: str) -> dict[str, object]:
    """Run the full tailoring pipeline for one application."""
    logger.info("task.started", application_id=application_id, task_id=self.request.id)

    # Load everything the pipeline needs, then release the session for the
    # duration of the (slow) LLM and LaTeX work.
    with session_scope() as db:
        application = db.get(Application, uuid.UUID(application_id))
        if application is None:
            logger.error("task.application_not_found", application_id=application_id)
            return {"status": "not_found"}

        user_id = application.user_id
        include_cover_letter = application.include_cover_letter
        reach_mode = application.reach_mode
        master = MasterResume.model_validate(application.resume_profile.content)
        template = application.resume_profile.template
        one_page = application.resume_profile.one_page
        # The brag bank: attested facts the engine may surface and the guardrails
        # treat as valid provenance. Loaded here while the session is open.
        evidence = evidence_lines(db, user_id)
        # Build the client for the provider/model this user actually selected,
        # billing their own key when they have one. Done here, while the session
        # is open, because it reads their encrypted keys and saved selection.
        # Hard-coding Gemini here (as this once did) meant a user who picked
        # Claude or OpenAI in Settings had every tailoring run silently fall
        # back to the shared Gemini key - or fail outright when there wasn't one
        # - while every other AI feature honoured their choice.
        client: LlmClient | None = None
        config_error: str | None = None
        try:
            client = client_for_user(application.user)
        except LlmConfigurationError as exc:
            config_error = str(exc)
        job = application.job
        scrape = ScrapeResult(
            url=job.url,
            source=job.source,
            title=job.title,
            company=job.company,
            location=job.location,
            text=job.raw_text,
        )
        application.pipeline_status = PipelineStatus.EXTRACTING
        application.error_message = None

    def on_progress(stage: str, message: str) -> None:
        mapping = {
            "extracting": PipelineStatus.EXTRACTING,
            "optimizing": PipelineStatus.OPTIMIZING,
            "rendering": PipelineStatus.RENDERING,
        }
        if stage in mapping:
            _set_status(application_id, mapping[stage])
        logger.info("task.progress", application_id=application_id, stage=stage, message=message)

    if config_error is not None:
        # Retrying will not conjure an API key.
        _set_status(application_id, PipelineStatus.FAILED, config_error)
        logger.error("task.misconfigured", application_id=application_id, error=config_error)
        return {"status": "failed", "reason": "configuration"}

    try:
        outcome = run_pipeline(
            master,
            scrape,
            include_cover_letter=include_cover_letter,
            evidence=evidence,
            template=template,
            one_page=one_page,
            reach=reach_mode,
            on_progress=on_progress,
            client=client,
        )
    except LlmConfigurationError as exc:
        # Retrying will not conjure an API key.
        _set_status(application_id, PipelineStatus.FAILED, str(exc))
        logger.error("task.misconfigured", application_id=application_id, error=str(exc))
        return {"status": "failed", "reason": "configuration"}
    except SoftTimeLimitExceeded:
        _set_status(
            application_id,
            PipelineStatus.FAILED,
            "The tailoring run took too long and was stopped. Try again, or shorten "
            "the job description.",
        )
        logger.error("task.timeout", application_id=application_id)
        return {"status": "failed", "reason": "timeout"}
    except LatexCompilationError as exc:
        _set_status(
            application_id,
            PipelineStatus.FAILED,
            f"Your resume could not be typeset: {exc.summary()}",
        )
        logger.error("task.latex_failed", application_id=application_id, summary=exc.summary())
        return {"status": "failed", "reason": "latex"}
    except LlmError as exc:
        if self.request.retries < self.max_retries:
            logger.warning(
                "task.llm_error_retrying",
                application_id=application_id,
                attempt=self.request.retries + 1,
                error=str(exc)[:300],
            )
            raise self.retry(exc=exc) from exc
        _set_status(
            application_id,
            PipelineStatus.FAILED,
            f"The AI service could not complete this request: {exc}",
        )
        return {"status": "failed", "reason": "llm"}
    except Exception as exc:  # noqa: BLE001 - last line of defence
        _set_status(
            application_id,
            PipelineStatus.FAILED,
            "An unexpected error occurred while tailoring your resume.",
        )
        logger.exception(
            "task.unexpected_error", application_id=application_id, error=str(exc)[:300]
        )
        return {"status": "failed", "reason": "unexpected"}

    _persist(uuid.UUID(application_id), user_id, outcome)

    errors = [v for v in outcome.guardrail_report.violations if v.severity == "error"]
    logger.info(
        "task.completed",
        application_id=application_id,
        cost_usd=outcome.usage.cost_usd,
        guardrail_errors=len(errors),
        keyword_coverage=round(outcome.guardrail_report.keyword_coverage, 3),
    )
    return {
        "status": "completed",
        "cost_usd": outcome.usage.cost_usd,
        "guardrail_errors": len(errors),
    }


@celery_app.task(
    bind=True,
    name="hirecraft.send_email",
    max_retries=3,
    default_retry_delay=30,
)
def send_email_task(self, to: str, subject: str, html: str, text: str) -> dict[str, str]:
    """Deliver one transactional email off the request path.

    A failed SMTP send is retried with backoff; an exhausted retry budget is
    logged rather than raised, so a mail outage never crashes the flow that
    queued the message (registration still succeeds even if the welcome email
    is delayed).
    """
    try:
        send_email(Email(to=to, subject=subject, html=html, text=text))
    except EmailError as exc:
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc) from exc
        logger.error("task.email_giving_up", to=to, subject=subject)
        return {"status": "failed", "to": to}
    return {"status": "sent", "to": to}


@celery_app.task(name="hirecraft.housekeeping")
def housekeeping_task() -> dict[str, int]:
    """Daily maintenance slot, driven by Celery beat."""
    logger.info("task.housekeeping_ran")
    return {"ok": 1}


@celery_app.task(name="hirecraft.scan_reminders")
def scan_reminders_task() -> dict[str, int]:
    """Daily: create due reminders (interview soon, follow-up, stale) per user.

    Idempotent via each reminder's dedupe key, so re-running the same day is a
    no-op rather than a spam generator.
    """
    from sqlalchemy import select

    from app.models.user import User
    from app.services.notifications import scan_user

    created = 0
    scanned = 0
    with session_scope() as db:
        users = list(db.scalars(select(User).where(User.is_active.is_(True))))
        for user in users:
            scanned += 1
            created += scan_user(db, user)
        db.commit()
    logger.info("task.reminders_scanned", users=scanned, created=created)
    return {"users": scanned, "created": created}


@celery_app.task(name="hirecraft.weekly_summary")
def weekly_summary_task() -> dict[str, int]:
    """Weekly: a job-search summary notification per active user."""
    from sqlalchemy import select

    from app.models.user import User
    from app.services.dashboard import build_overview
    from app.services.notifications import notify

    sent = 0
    now = _utcnow()
    week_key = f"weekly:{now.isocalendar().year}-W{now.isocalendar().week}"
    with session_scope() as db:
        users = list(db.scalars(select(User).where(User.is_active.is_(True))))
        for user in users:
            overview = build_overview(db, user.id)
            f = overview.funnel
            if f.total == 0:
                continue  # nothing to summarise yet
            body = (
                f"This week: {f.active} in progress, {f.interviewing} interviewing, "
                f"{f.offers} offer(s). Response rate {round(f.response_rate * 100)}%. "
                f"Keep the momentum going."
            )
            made = notify(
                db,
                user,
                kind="weekly_summary",
                title="Your weekly job-search summary",
                body=body,
                link="/analytics",
                dedupe_key=week_key,
                email=True,
            )
            if made is not None:
                sent += 1
        db.commit()
    logger.info("task.weekly_summary_sent", sent=sent)
    return {"sent": sent}


def _utcnow():
    from datetime import UTC, datetime

    return datetime.now(UTC)
