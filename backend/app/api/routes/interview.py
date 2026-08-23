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
from app.models.interview import SavedInterviewQuestion
from app.schemas.interview import (
    AnswerRequest,
    AnswerResponse,
    QuestionsRequest,
    QuestionsResponse,
    SavedAnswerRequest,
    SavedQuestion,
)
from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.schemas.writing import VoiceProfile
from app.services.evidence import evidence_lines
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

    saved: list[SavedQuestion] = []
    if payload.save:
        # One live set per application (or one standalone set), so regenerating
        # replaces the previous batch instead of piling sets on top of each other.
        db.query(SavedInterviewQuestion).filter(
            SavedInterviewQuestion.user_id == user.id,
            SavedInterviewQuestion.application_id == payload.application_id,
        ).delete(synchronize_session=False)
        rows = [
            SavedInterviewQuestion(
                user_id=user.id,
                application_id=payload.application_id,
                resume_profile_id=payload.resume_profile_id,
                category=q.category,
                question=q.question,
                why=q.why,
                tip=q.tip,
                role=role,
                company=company,
                order_index=index,
            )
            for index, q in enumerate(questions)
        ]
        db.add_all(rows)
        db.flush()
        saved = [SavedQuestion.model_validate(r) for r in rows]

    _record(db, user.id, ledger)  # commits
    return QuestionsResponse(questions=questions, cost_usd=ledger.cost_usd, saved=saved)


@router.get("/saved", response_model=list[SavedQuestion])
def list_saved_questions(
    user: GenerationUser, db: DbSession, application_id: uuid.UUID | None = None
) -> list[SavedQuestion]:
    """The saved set for an application, or the standalone set when no id is given.

    Answers ride along, so the UI can tell answered questions from unanswered ones
    and offer "Draft an answer" vs "Redraft" per question.
    """
    rows = db.execute(
        select(SavedInterviewQuestion)
        .where(
            SavedInterviewQuestion.user_id == user.id,
            SavedInterviewQuestion.application_id == application_id,
        )
        .order_by(SavedInterviewQuestion.order_index)
    ).scalars().all()
    return [SavedQuestion.model_validate(r) for r in rows]


@router.post("/saved/{question_id}/answer", response_model=SavedQuestion)
def answer_saved_question(
    question_id: uuid.UUID,
    payload: SavedAnswerRequest,
    user: GenerationUser,
    db: DbSession,
) -> SavedQuestion:
    """Draft the answer for a saved question — or redraft it when one already
    exists and the candidate wants a different take. The new answer replaces the
    stored one, so a question always carries at most one answer."""
    row = db.get(SavedInterviewQuestion, question_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Question not found.")

    profile = (
        db.get(ResumeProfile, row.resume_profile_id) if row.resume_profile_id else None
    )
    if profile is None or profile.user_id != user.id:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "The résumé this question was generated from is no longer available.",
        )
    resume = MasterResume.model_validate(profile.content)
    voice = _voice_for(db, user.id) if payload.use_voice else None

    ledger = UsageLedger()
    try:
        star, warnings = draft_star_answer(
            resume,
            row.question,
            voice=voice,
            evidence=evidence_lines(db, user.id),
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

    row.answer = star.model_dump()
    row.answer_warnings = warnings
    row.used_voice = voice is not None
    _record(db, user.id, ledger)  # commits
    db.refresh(row)
    return SavedQuestion.model_validate(row)


@router.delete("/saved/{question_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_saved_question(
    question_id: uuid.UUID, user: GenerationUser, db: DbSession
) -> None:
    row = db.get(SavedInterviewQuestion, question_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Question not found.")
    db.delete(row)
    db.commit()


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
            evidence=evidence_lines(db, user.id),
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
