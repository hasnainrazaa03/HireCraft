"""Authentication endpoints."""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.core.logging import get_logger
from app.core.rate_limit import check_rate_limit
from app.core.security import (
    TokenError,
    create_token,
    hash_password,
    token_subject,
    validate_password_strength,
    verify_password,
)
from app.models.user import User
from app.schemas.api import (
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
    UserResponse,
)

router = APIRouter(prefix="/auth", tags=["auth"])
logger = get_logger(__name__)


def _issue_tokens(user: User) -> TokenResponse:
    return TokenResponse(
        access_token=create_token(user.id, "access"),
        refresh_token=create_token(user.id, "refresh"),
        expires_in=settings.access_token_ttl_minutes * 60,
    )


def _throttle_auth(request: Request, bucket: str) -> None:
    """Rate limit by client IP; credential endpoints are brute-force targets."""
    client_ip = request.client.host if request.client else "unknown"
    result = check_rate_limit(client_ip, limit=10, window_seconds=300, bucket=bucket)
    if not result.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please wait a few minutes and try again.",
            headers={"Retry-After": str(result.reset_after)},
        )


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, request: Request, db: DbSession) -> TokenResponse:
    _throttle_auth(request, "register")

    try:
        validate_password_strength(payload.password)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    email = payload.email.lower()
    if db.scalar(select(User).where(User.email == email)) is not None:
        # Deliberately the same shape as a successful-looking conflict; we do not
        # confirm or deny which addresses exist beyond this necessary 409.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with that email already exists.",
        )

    user = User(
        email=email,
        hashed_password=hash_password(payload.password),
        full_name=payload.full_name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    logger.info("auth.registered", user_id=str(user.id))
    return _issue_tokens(user)


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: DbSession) -> TokenResponse:
    _throttle_auth(request, "login")

    started = time.perf_counter()
    user = db.scalar(select(User).where(User.email == payload.email.lower()))

    if user is None:
        # Hash anyway so a missing account is not distinguishable by response
        # time from a wrong password.
        hash_password(payload.password)
        _pad_timing(started)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password."
        )

    valid, upgraded_hash = verify_password(payload.password, user.hashed_password)
    if not valid:
        _pad_timing(started)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password."
        )

    if upgraded_hash:
        user.hashed_password = upgraded_hash
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="This account is disabled."
        )

    db.commit()
    logger.info("auth.login", user_id=str(user.id))
    return _issue_tokens(user)


def _pad_timing(started: float, target_ms: float = 250.0) -> None:
    elapsed_ms = (time.perf_counter() - started) * 1000
    if elapsed_ms < target_ms:
        time.sleep((target_ms - elapsed_ms) / 1000)


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, db: DbSession) -> TokenResponse:
    try:
        user_id = token_subject(payload.refresh_token, "refresh")
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc

    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token."
        )
    return _issue_tokens(user)


@router.get("/me", response_model=UserResponse)
def me(user: CurrentUser) -> User:
    return user
