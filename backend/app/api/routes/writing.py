"""Writing profile endpoints: manage samples and extract the user's voice."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, DbSession, GenerationUser
from app.core.logging import get_logger
from app.models.llm_usage import LlmUsage
from app.models.writing import WritingProfile, WritingSample
from app.schemas.writing import (
    VoiceProfile,
    WritingProfileResponse,
    WritingSampleCreate,
    WritingSampleResponse,
)
from app.services.llm.client import LlmConfigurationError, LlmError
from app.services.llm.factory import client_for_user
from app.services.llm.voice import extract_voice

router = APIRouter(prefix="/writing", tags=["writing"])
logger = get_logger(__name__)


def _get_or_create(db: DbSession, user_id: uuid.UUID) -> WritingProfile:
    """One profile per user, created lazily. See routes/profile.py for why the
    insert runs inside a savepoint: concurrent first requests both try it, and
    the unique constraint on user_id means one has to lose gracefully."""

    def existing() -> WritingProfile | None:
        return db.scalar(select(WritingProfile).where(WritingProfile.user_id == user_id))

    profile = existing()
    if profile is not None:
        return profile

    profile = WritingProfile(user_id=user_id)
    try:
        with db.begin_nested():
            db.add(profile)
            db.flush()
    except IntegrityError:
        profile = existing()
        if profile is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Your writing profile is being set up. Please retry in a moment.",
            ) from None
    return profile


def _to_response(profile: WritingProfile) -> WritingProfileResponse:
    return WritingProfileResponse(
        voice=VoiceProfile.model_validate(profile.voice) if profile.voice else None,
        analyzed_at=profile.analyzed_at,
        sample_count=len(profile.samples),
        samples=[WritingSampleResponse.model_validate(s) for s in profile.samples],
    )


@router.get("", response_model=WritingProfileResponse)
def get_writing_profile(user: CurrentUser, db: DbSession) -> WritingProfileResponse:
    profile = _get_or_create(db, user.id)
    db.commit()
    return _to_response(profile)


@router.post("/samples", response_model=WritingSampleResponse, status_code=status.HTTP_201_CREATED)
def add_sample(
    payload: WritingSampleCreate, user: CurrentUser, db: DbSession
) -> WritingSample:
    profile = _get_or_create(db, user.id)
    if len(profile.samples) >= 20:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You've reached the 20-sample limit. Delete one to add another.",
        )
    sample = WritingSample(
        writing_profile_id=profile.id,
        kind=payload.kind,
        title=payload.title,
        content=payload.content,
    )
    db.add(sample)
    db.commit()
    db.refresh(sample)
    return sample


@router.delete("/samples/{sample_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sample(sample_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    sample = db.get(WritingSample, sample_id)
    if sample is None or sample.writing_profile.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sample not found.")
    db.delete(sample)
    db.commit()


@router.post("/analyze", response_model=WritingProfileResponse)
def analyze_voice(user: GenerationUser, db: DbSession) -> WritingProfileResponse:
    """Distill the user's voice from their samples (one LLM call)."""
    profile = _get_or_create(db, user.id)
    if not profile.samples:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Add at least one writing sample before analyzing your voice.",
        )

    try:
        client = client_for_user(user)
    except LlmConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    pairs = [(s.kind.value, s.content) for s in profile.samples]
    try:
        voice, usage = extract_voice(pairs, client=client)
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Couldn't analyze your writing right now: {exc}",
        ) from exc

    profile.voice = voice.model_dump(mode="json")
    profile.analyzed_at = datetime.now(UTC)
    db.add(
        LlmUsage(
            user_id=user.id,
            purpose="voice_extraction",
            model=usage.model,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cost_usd=usage.cost_usd,
            latency_ms=usage.latency_ms,
        )
    )
    db.commit()
    return _to_response(profile)
