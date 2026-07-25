"""Interview-prep endpoints: question generation and STAR answer drafting."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import DbSession, GenerationUser
from app.core.logging import get_logger
from app.models.application import Application
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.models.writing import WritingProfile
from app.schemas.interview import (
    AnswerRequest,
    AnswerResponse,
    QuestionsRequest,
    QuestionsResponse,
)
from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.schemas.writing import VoiceProfile
from app.services.interview import draft_star_answer, generate_questions
from app.services.llm.client import (
    LlmConfigurationError,
    LlmError,
    LlmResponseError,
)
from app.services.llm.factory import client_for_user
from app.services.pipeline import UsageLedger

router = APIRouter(prefix="/interview", tags=["interview"])
logger = get_logger(__name__)


def _owned_resume(db: DbSession, user_id: uuid.UUID, profile_id: uuid.UUID) -> ResumeProfile:
    profile = db.get(ResumeProfile, profile_id)
    if profile is None or profile.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Résumé not found.")
    return profile


def _client_for(user, provider: str | None = None, model: str | None = None):  # noqa: ANN001
    """Build the LLM client for this user's active (or overridden) provider/model."""
    try:
        return client_for_user(user, provider=provider, model=model)
    except LlmConfigurationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


def _voice_for(db: DbSession, user_id: uuid.UUID) -> VoiceProfile | None:
    profile = db.query(WritingProfile).filter(WritingProfile.user_id == user_id).first()
    if profile is None or not profile.voice:
        return None
    try:
        return VoiceProfile.model_validate(profile.voice)
    except Exception:  # noqa: BLE001
        return None


def _record(db: DbSession, user_id: uuid.UUID, ledger: UsageLedger) -> None:
    for purpose, usage in ledger.entries:
        db.add(
            LlmUsage(
                user_id=user_id,
                purpose=purpose,
                model=usage.model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cost_usd=usage.cost_usd,
                latency_ms=usage.latency_ms,
            )
        )
    db.commit()


def _503_502(exc: LlmError) -> HTTPException:
    return HTTPException(
        status.HTTP_502_BAD_GATEWAY,
        f"The AI service is unavailable right now: {exc}",
    )


@router.post("/questions", response_model=QuestionsResponse)
def interview_questions(
    payload: QuestionsRequest, user: GenerationUser, db: DbSession
) -> QuestionsResponse:
    profile = _owned_resume(db, user.id, payload.resume_profile_id)
    resume = MasterResume.model_validate(profile.content)

    role, company, keywords = payload.role, payload.company, None
    # If an application is referenced, borrow its role/company/keywords.
    if payload.application_id is not None:
        application = db.scalar(
            select(Application)
            .where(Application.id == payload.application_id, Application.user_id == user.id)
            .options(selectinload(Application.job))
        )
        if application and application.job:
            role = role or application.job.title
            company = company or application.job.company
            if application.job.requirements:
                try:
                    keywords = JobRequirements.model_validate(
                        application.job.requirements
                    ).all_keywords()[:20]
                except Exception:  # noqa: BLE001
                    keywords = None

    ledger = UsageLedger()
    try:
        questions = generate_questions(
            resume,
            role=role,
            company=company,
            keywords=keywords,
            categories=list(payload.categories),
            count=payload.count,
            client=_client_for(user),
            ledger=ledger,
        )
    except LlmResponseError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "The AI returned an incomplete set of questions. Please try again.",
        ) from exc
    except LlmError as exc:
        raise _503_502(exc) from exc

    _record(db, user.id, ledger)
    return QuestionsResponse(questions=questions, cost_usd=ledger.cost_usd)


@router.post("/answer", response_model=AnswerResponse)
def interview_answer(
    payload: AnswerRequest, user: GenerationUser, db: DbSession
) -> AnswerResponse:
    profile = _owned_resume(db, user.id, payload.resume_profile_id)
    resume = MasterResume.model_validate(profile.content)
    voice = _voice_for(db, user.id) if payload.use_voice else None

    ledger = UsageLedger()
    try:
        star, warnings = draft_star_answer(
            resume,
            payload.question,
            voice=voice,
            client=_client_for(user),
            ledger=ledger,
        )
    except LlmResponseError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "The AI returned an incomplete answer. Please try again.",
        ) from exc
    except LlmError as exc:
        raise _503_502(exc) from exc

    _record(db, user.id, ledger)
    return AnswerResponse(
        star=star,
        used_voice=voice is not None,
        warnings=warnings,
        cost_usd=ledger.cost_usd,
    )
