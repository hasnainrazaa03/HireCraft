"""Application endpoints: start a tailoring run, poll it, download artifacts."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession, GenerationUser
from app.core.logging import get_logger
from app.models.application import (
    Application,
    PipelineStatus,
    TrackerStatus,
)
from app.models.job import Job
from app.models.resume import ResumeProfile
from app.schemas.api import (
    ApplicationCreate,
    ApplicationDetail,
    ApplicationStatusResponse,
    ApplicationSummary,
    ApplicationUpdate,
)
from app.services import storage
from app.services.scraper import ScrapeError, from_pasted_text, scrape_job
from app.workers.tasks import run_tailoring_task

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
        notes=payload.notes,
    )
    db.add(application)
    db.commit()
    db.refresh(application)

    task = run_tailoring_task.delay(str(application.id))
    application.celery_task_id = task.id
    db.commit()
    db.refresh(application)

    logger.info(
        "application.queued",
        application_id=str(application.id),
        task_id=task.id,
        user_id=str(user.id),
    )
    return _to_detail(application)


def _to_detail(application: Application) -> ApplicationDetail:
    return ApplicationDetail.model_validate(application)


@router.get("", response_model=list[ApplicationSummary])
def list_applications(
    user: CurrentUser,
    db: DbSession,
    tracker_status: TrackerStatus | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[ApplicationSummary]:
    stmt = (
        select(Application)
        .where(Application.user_id == user.id)
        .options(selectinload(Application.job))
        .order_by(Application.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if tracker_status is not None:
        stmt = stmt.where(Application.tracker_status == tracker_status)

    return [
        ApplicationSummary(
            id=a.id,
            pipeline_status=a.pipeline_status,
            tracker_status=a.tracker_status,
            job_title=a.job.title if a.job else None,
            company=a.job.company if a.job else None,
            total_cost_usd=a.total_cost_usd,
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
    if payload.tracker_status is not None:
        application.tracker_status = payload.tracker_status
    if payload.notes is not None:
        application.notes = payload.notes
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

    task = run_tailoring_task.delay(str(application.id))
    application.celery_task_id = task.id
    db.commit()
    db.refresh(application)
    return _to_detail(application)


@router.get("/{application_id}/download/{kind}")
def download_artifact(
    application_id: uuid.UUID, kind: str, user: CurrentUser, db: DbSession
) -> Response:
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
