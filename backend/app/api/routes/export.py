"""Export center: take your data anywhere.

Application history as CSV, and a full account backup as a zip — the résumés,
applications, career profile, and writing samples the user has created. Read-only
and self-service; this is the data-portability side of the account.
"""

from __future__ import annotations

import csv
import io
import json
import zipfile
from datetime import UTC, datetime

from fastapi import APIRouter, Response
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbSession
from app.models.application import Application
from app.models.profile import CareerProfile
from app.models.resume import ResumeProfile
from app.models.writing import WritingProfile

router = APIRouter(prefix="/export", tags=["export"])

_APP_COLUMNS = [
    "created_at",
    "job_title",
    "company",
    "tracker_status",
    "pipeline_status",
    "interview_at",
    "reminder_at",
    "total_cost_usd",
]


def _applications(db: DbSession, user_id) -> list[Application]:  # noqa: ANN001
    return list(
        db.scalars(
            select(Application)
            .where(Application.user_id == user_id)
            .options(selectinload(Application.job))
            .order_by(Application.created_at.desc())
        )
    )


def _applications_csv(applications: list[Application]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(_APP_COLUMNS)
    for app in applications:
        writer.writerow([
            app.created_at.isoformat() if app.created_at else "",
            (app.job.title if app.job else "") or "",
            (app.job.company if app.job else "") or "",
            app.tracker_status.value,
            app.pipeline_status.value,
            app.interview_at.isoformat() if app.interview_at else "",
            app.reminder_at.isoformat() if app.reminder_at else "",
            f"{app.total_cost_usd:.6f}",
        ])
    return buffer.getvalue()


@router.get("/applications.csv")
def export_applications_csv(user: CurrentUser, db: DbSession) -> Response:
    csv_text = _applications_csv(_applications(db, user.id))
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="applications.csv"'},
    )


@router.get("/account.zip")
def export_account_backup(user: CurrentUser, db: DbSession) -> Response:
    """A full, self-contained backup of everything the user has created."""
    resumes = list(
        db.scalars(select(ResumeProfile).where(ResumeProfile.user_id == user.id))
    )
    applications = _applications(db, user.id)
    profile = db.scalar(select(CareerProfile).where(CareerProfile.user_id == user.id))
    writing = db.scalar(
        select(WritingProfile)
        .where(WritingProfile.user_id == user.id)
        .options(selectinload(WritingProfile.samples))
    )

    account = {
        "email": str(user.email),
        "full_name": user.full_name,
        "exported_at": datetime.now(UTC).isoformat(),
    }
    resumes_json = [
        {
            "name": r.name,
            "template": r.template,
            "tags": list(r.tags or []),
            "current_version": r.current_version,
            "content": r.content,
        }
        for r in resumes
    ]
    applications_json = [
        {
            "job_title": a.job.title if a.job else None,
            "company": a.job.company if a.job else None,
            "tracker_status": a.tracker_status.value,
            "pipeline_status": a.pipeline_status.value,
            "created_at": a.created_at.isoformat() if a.created_at else None,
            "notes": a.notes,
            "tailored_resume": a.tailored_resume,
        }
        for a in applications
    ]
    profile_json = (
        {
            "headline": profile.headline,
            "years_experience": profile.years_experience,
            "preferred_roles": list(profile.preferred_roles or []),
            "work_arrangement": profile.work_arrangement,
        }
        if profile
        else None
    )
    writing_json = (
        {
            "voice": writing.voice,
            "samples": [
                {"kind": s.kind.value, "title": s.title, "content": s.content}
                for s in writing.samples
            ],
        }
        if writing
        else None
    )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("hirecraft/account.json", _dumps(account))
        archive.writestr("hirecraft/resumes.json", _dumps(resumes_json))
        archive.writestr("hirecraft/applications.json", _dumps(applications_json))
        archive.writestr("hirecraft/applications.csv", _applications_csv(applications))
        if profile_json is not None:
            archive.writestr("hirecraft/career_profile.json", _dumps(profile_json))
        if writing_json is not None:
            archive.writestr("hirecraft/writing.json", _dumps(writing_json))
        archive.writestr(
            "hirecraft/README.txt",
            "Your HireCraft data export.\n\n"
            "- resumes.json: every résumé (full structured content)\n"
            "- applications.json / .csv: your application history\n"
            "- career_profile.json, writing.json: your profile and writing voice\n",
        )

    buffer.seek(0)
    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="hirecraft_backup.zip"'},
    )


def _dumps(obj: object) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False, default=str)
