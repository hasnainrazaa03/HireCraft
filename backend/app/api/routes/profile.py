"""Career profile endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, DbSession
from app.models.profile import CareerProfile
from app.schemas.profile import CareerProfileResponse, CareerProfileUpdate

router = APIRouter(prefix="/profile", tags=["profile"])


def _get_or_create(db: DbSession, user_id) -> CareerProfile:
    """One profile per user, created lazily on first access.

    Two requests arriving together on a brand-new account both see "no profile"
    and both insert; user_id is unique, so one of them loses. The savepoint
    keeps that loss local to this insert instead of poisoning the session, and
    we re-read the winner's row.
    """
    def existing() -> CareerProfile | None:
        return db.scalar(select(CareerProfile).where(CareerProfile.user_id == user_id))

    profile = existing()
    if profile is not None:
        return profile

    profile = CareerProfile(user_id=user_id)
    try:
        with db.begin_nested():
            db.add(profile)
            db.flush()
    except IntegrityError:
        profile = existing()
        if profile is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Your profile is being set up. Please retry in a moment.",
            ) from None
    return profile


@router.get("", response_model=CareerProfileResponse)
def get_profile(user: CurrentUser, db: DbSession) -> CareerProfile:
    profile = _get_or_create(db, user.id)
    db.commit()
    return profile


@router.patch("", response_model=CareerProfileResponse)
def update_profile(
    payload: CareerProfileUpdate, user: CurrentUser, db: DbSession
) -> CareerProfile:
    profile = _get_or_create(db, user.id)

    # Only apply fields the client actually sent; HttpUrl values become strings.
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(profile, field, str(value) if _is_url_field(field) and value else value)

    db.commit()
    db.refresh(profile)
    return profile


_URL_FIELDS = {"linkedin_url", "github_url", "portfolio_url", "website_url"}


def _is_url_field(field: str) -> bool:
    return field in _URL_FIELDS
