"""Endpoints for the browser extension's autofill.

Deliberately narrow. The extension holds a long-lived key (see
``app.core.security.generate_extension_key``), so what that key can reach is
kept to exactly what filling an application form needs: the details that go in
the form, the résumé PDF to attach, and a way to record that the application
happened. It cannot read or change anything else about the account.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DbSession, ExtensionUser
from app.core.config import settings
from app.core.logging import get_logger
from app.models.profile import CareerProfile
from app.models.resume import ResumeProfile
from app.schemas.api import ApplicationCreate, ApplicationDetail, JobCreate
from app.services.latex.compiler import LatexCompilationError
from app.services.latex.renderer import render_and_fit
from app.services.latex.templates import resolve_filename
from app.schemas.resume import MasterResume
from app.services import storage

logger = get_logger(__name__)

router = APIRouter(prefix="/extension", tags=["extension"])


class ExtensionTrackRequest(BaseModel):
    """Record a posting the user is applying to, at a given stage."""

    job: JobCreate
    resume_profile_id: uuid.UUID | None = None
    #: Where the user is with it. "draft" while filling, "applied" once the
    #: form has gone through — the extension sends the latter when it sees a
    #: submission, so the date recorded is the date it happened.
    status: str = "draft"
    notes: str | None = Field(default=None, max_length=4000)


class ExtensionCoverLetterRequest(BaseModel):
    """Draft a cover letter for the posting on the page."""

    job_text: str = Field(min_length=40, max_length=20000)
    company: str | None = Field(default=None, max_length=200)
    role: str | None = Field(default=None, max_length=200)
    resume_profile_id: uuid.UUID | None = None
    tone: str = "modern"


def _split_name(full_name: str | None) -> tuple[str, str]:
    """Best-effort first/last split.

    Application forms almost always ask for the two separately while HireCraft
    stores one name, so the split has to happen somewhere; doing it here keeps
    the rule in one place instead of in every ATS adapter. Everything before the
    final token is the first name, so "Mohammad Hasnain Raza" gives "Mohammad
    Hasnain" and "Raza" — which is the right answer more often than splitting on
    the first space.
    """
    parts = (full_name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return " ".join(parts[:-1]), parts[-1]


@router.get("/profile", response_model=dict)
def extension_profile(user: ExtensionUser, db: DbSession) -> dict:
    """Everything the autofiller puts into a form, plus the résumés to attach.

    Contact details come from the Career Profile where it has them and from the
    default résumé otherwise; work authorisation and years of experience exist
    only on the Career Profile. Also serves as the extension's connection check:
    a valid key returns this, anything else returns 401.
    """
    profile = db.execute(
        select(CareerProfile).where(CareerProfile.user_id == user.id)
    ).scalars().first()
    resumes = db.execute(
        select(ResumeProfile)
        .where(ResumeProfile.user_id == user.id)
        .order_by(ResumeProfile.is_default.desc(), ResumeProfile.updated_at.desc())
    ).scalars().all()

    # The résumé already carries the contact details, and it is the document the
    # user actually maintains — so it fills any gap the Career Profile leaves
    # rather than making them type the same phone number twice. The Career
    # Profile still wins where it has a value: it is the more deliberate answer.
    basics: dict = {}
    basics_source: dict = {}
    if resumes:
        default = next((r for r in resumes if r.is_default), resumes[0])
        basics_source = default.content or {}
        basics = basics_source.get("basics") or {}

    def pick(profile_value: object, basics_key: str) -> str:
        return str(profile_value or basics.get(basics_key) or "").strip()

    full_name = user.full_name or str(basics.get("name") or "")
    # A form's plain "First name" belongs to the employment record, so it gets
    # the legal name where one is stored; a form that asks for a preferred name
    # gets that instead. Answering either with the other is wrong both ways.
    legal_first = (profile.legal_first_name if profile else "") or ""
    legal_last = (profile.legal_last_name if profile else "") or ""
    if not (legal_first or legal_last):
        legal_first, legal_last = _split_name(full_name)
    preferred = (profile.preferred_name if profile else "") or _split_name(full_name)[0]

    return {
        "full_name": full_name,
        "first_name": legal_first,
        "last_name": legal_last,
        "legal_first_name": legal_first,
        "legal_last_name": legal_last,
        "preferred_name": preferred,
        # The address an employer should write to, which is not necessarily the
        # one used to sign in here.
        "email": pick(profile.contact_email if profile else None, "email") or user.email,
        "login_email": user.email,
        "country": pick(profile.country if profile else None, "country"),
        "phone": pick(profile.phone if profile else None, "phone"),
        "location": pick(profile.location if profile else None, "location"),
        "linkedin": pick(profile.linkedin_url if profile else None, "linkedin"),
        "github": pick(profile.github_url if profile else None, "github"),
        "portfolio": pick(profile.portfolio_url if profile else None, "portfolio"),
        "website": pick(profile.website_url if profile else None, "website"),
        "work_authorization": (profile.work_authorization if profile else "") or "",
        "visa_status": (profile.visa_status if profile else "") or "",
        # None means unanswered, and the filler must leave the question alone
        # rather than guess — telling an employer the wrong thing here is worse
        # than an empty box they will ask about.
        "authorized_to_work": (profile.authorized_to_work if profile else None),
        "requires_sponsorship": (profile.requires_sponsorship if profile else None),
        "years_experience": (profile.years_experience if profile else None),
        "open_to_relocation": bool(profile.open_to_relocation) if profile else False,
        # The most recent degree, which is what "School", "Degree", "Graduation
        # year" and "GPA" on an application form are asking about. Taken from the
        # résumé because that is where it already lives — re-entering a degree
        # into a second form would be the app failing to use what it holds.
        "education": _latest_education(basics_source),
        "resumes": [
            {"id": str(r.id), "name": r.name, "is_default": r.is_default}
            for r in resumes
        ],
    }


def _latest_education(content: dict) -> dict:
    """The most recent degree from a résumé, flattened for form filling.

    "Most recent" is by end date, falling back to document order: a résumé lists
    education newest-first by convention, but the dates are the fact and the
    ordering is only a habit.
    """
    entries = [e for e in (content.get("education") or []) if isinstance(e, dict)]
    if not entries:
        return {}

    def sort_key(entry: dict) -> str:
        end = str(entry.get("end_date") or "")
        return "9999" if end.lower() == "present" else end

    latest = max(entries, key=sort_key)
    start = str(latest.get("start_date") or "")
    end = str(latest.get("end_date") or "")
    return {
        "school": latest.get("institution") or "",
        "degree": latest.get("degree") or "",
        "field_of_study": latest.get("field_of_study") or "",
        "gpa": latest.get("gpa") or "",
        # Forms ask for the year alone far more often than a full date.
        "start_year": start[:4],
        "end_year": "" if end.lower() == "present" else end[:4],
    }


@router.get("/resume/{profile_id}.pdf")
def extension_resume_pdf(
    profile_id: uuid.UUID, user: ExtensionUser, db: DbSession
) -> Response:
    """The résumé as a PDF, for attaching to a form's file input."""
    resume_profile = db.get(ResumeProfile, profile_id)
    if resume_profile is None or resume_profile.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Résumé not found.")

    resume = MasterResume.model_validate(resume_profile.content)
    safe = storage.safe_filename(resume_profile.name.replace(" ", "_"), fallback="resume")
    try:
        result, _tex, _rendered = render_and_fit(
            resume,
            settings.templates_dir,
            template_name=resolve_filename(resume_profile.template),
            one_page=resume_profile.one_page,
            job_name=safe,
        )
    except LatexCompilationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Could not typeset this résumé: {exc.summary()}",
        ) from exc

    return Response(
        content=result.pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{safe}.pdf"'},
    )


@router.post(
    "/track", response_model=ApplicationDetail, status_code=status.HTTP_201_CREATED
)
def extension_track(
    payload: ExtensionTrackRequest, user: ExtensionUser, db: DbSession
) -> ApplicationDetail:
    """Record an application the user is filling in, or has just submitted.

    Always untailored: the extension's job is to note that an application
    happened, not to rewrite a résumé behind the user's back.

    ``status`` is what makes this a tracker rather than a bookmark. The
    extension sends "applied" when it sees a submission go through, and the
    stage is stamped with the time it happened rather than the time anyone
    remembers to record it.
    """
    from app.api.routes.applications import (
        _attach_untailored,
        _resolve_job,
        _resolve_resume,
        _to_detail,
    )
    from app.models.application import Application, PipelineStatus
    from app.services.activity import log_event

    from app.models.application import TrackerStatus

    from app.models.job import Job

    profile = _resolve_resume(db, user.id, payload.resume_profile_id)

    # One posting, one application. The extension calls this twice for the same
    # job — once while filling the form, once when it sees the submission — and
    # the second call must advance the first row rather than leave two
    # half-told versions of the same application in the tracker.
    #
    # Matching on the URL rather than on a freshly resolved job id is the whole
    # point: _resolve_job scrapes and inserts a *new* Job each time it is
    # called, so a lookup by its id never matches the earlier row, and every
    # call created another application. Reusing the stored job also means the
    # posting is not re-fetched from the employer on the second call.
    job = None
    if payload.job.url:
        job = (
            db.query(Job)
            .filter(Job.user_id == user.id, Job.url == payload.job.url)
            .order_by(Job.created_at.desc())
            .first()
        )
    if job is None:
        job = _resolve_job(
            db,
            user.id,
            ApplicationCreate(
                job=payload.job,
                resume_profile_id=payload.resume_profile_id,
                tailor=False,
            ),
        )

    application = (
        db.query(Application)
        .filter(Application.user_id == user.id, Application.job_id == job.id)
        .first()
    )
    fresh = application is None
    if fresh:
        application = Application(
            user_id=user.id,
            job_id=job.id,
            resume_profile_id=profile.id,
            pipeline_status=PipelineStatus.PENDING,
            include_cover_letter=False,
            reach_mode=False,
            notes=payload.notes,
        )
        db.add(application)
        db.flush()
        log_event(application, "created", "Added from the browser extension")

    stage = TrackerStatus(payload.status)
    if application.tracker_status != stage:
        log_event(
            application,
            "status_changed",
            f"Status → {stage.value.replace('_', ' ').title()} (browser extension)",
            {"from": application.tracker_status.value, "to": stage.value},
        )
        application.tracker_status = stage
    if stage is TrackerStatus.APPLIED and not application.applied_at:
        application.applied_at = datetime.now(UTC)
    db.commit()
    db.refresh(application)

    if fresh:
        _attach_untailored(db, application, profile)
        db.refresh(application)
    logger.info(
        "extension.tracked",
        application_id=str(application.id),
        user_id=str(user.id),
        status=stage.value,
        created=fresh,
    )
    return _to_detail(application)


@router.post("/cover-letter", response_model=dict)
def extension_cover_letter(
    payload: ExtensionCoverLetterRequest, user: ExtensionUser, db: DbSession
) -> dict:
    """Draft a cover letter for the posting the user is looking at.

    The one endpoint on this key that costs money, and the reason it is allowed
    is that it cannot happen quietly: the user ticks a box on the page and waits
    for the result. The rule the key enforces is that nothing bills *silently*,
    not that nothing bills at all.

    The draft is checked for the phrasings that make writing read as machine-
    generated and the count is returned with it, so the reader can see whether
    the instruction took rather than having to judge it cold.
    """
    from app.services.evidence import evidence_lines
    from app.services.llm.client import LlmError, LlmResponseError
    from app.services.llm.usage import UsageLedger
    from app.services.pipeline import compose_cover_letter
    from app.services.writing_tells import find_tells, uniformity

    from app.api.routes.studio import _client_for, _greeting, _record, _voice_for

    profile = _resolve_resume(db, user.id, payload.resume_profile_id)
    resume = MasterResume.model_validate(profile.content)

    ledger = UsageLedger()
    try:
        paragraphs, report = compose_cover_letter(
            resume,
            payload.job_text,
            company=payload.company,
            role=payload.role,
            tone=payload.tone,
            # The user's own writing samples, when they have given any. This is
            # the whole point of the Writing Voice page.
            voice=_voice_for(db, user.id),
            evidence=evidence_lines(db, user.id),
            client=_client_for(user),
            ledger=ledger,
        )
    except LlmResponseError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "The AI returned an incomplete letter. Please try again.",
        ) from exc
    except LlmError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"The AI service is unavailable: {exc}"
        ) from exc

    _record(db, user.id, ledger)
    body = "\n\n".join(paragraphs)
    return {
        "greeting": _greeting(None, payload.company),
        "paragraphs": paragraphs,
        "signature": resume.basics.name,
        "cost_usd": ledger.cost_usd,
        "resume_name": profile.name,
        # Style signals, so the reader can judge the draft rather than trust it.
        "tells": find_tells(body)[:8],
        "uniformity": round(uniformity(body), 2),
        "guardrail_report": report.model_dump(mode="json") if report else None,
    }
