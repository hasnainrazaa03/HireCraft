"""Authentication endpoints: accounts, sessions, and email flows."""

from __future__ import annotations

import time
import uuid
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from app.api.deps import CurrentSessionId, CurrentUser, DbSession
from app.core.config import settings
from app.core.logging import get_logger
from app.core.rate_limit import check_rate_limit
from app.core.security import (
    hash_password,
    validate_password_strength,
    verify_password,
)
from app.models.auth import AuthTokenPurpose
from app.models.user import User
from app.schemas.api import (
    ChangeEmailRequest,
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    MessageResponse,
    RefreshRequest,
    RegisterRequest,
    ResetPasswordRequest,
    SessionResponse,
    TokenResponse,
    UserResponse,
    VerifyEmailRequest,
)
from app.services import auth_service, feature_flags
from app.services.auth_service import TokenError
from app.services.email.templates import password_reset_email, verification_email
from app.workers.tasks import send_email_task

router = APIRouter(prefix="/auth", tags=["auth"])
logger = get_logger(__name__)


# --- helpers ----------------------------------------------------------------


def _client(request: Request) -> tuple[str | None, str | None]:
    ua = request.headers.get("user-agent")
    ip = request.client.host if request.client else None
    return ua, ip


def _issue_session(request: Request, db: DbSession, user: User) -> TokenResponse:
    ua, ip = _client(request)
    access, refresh, _ = auth_service.create_session(
        db, user, user_agent=ua, ip_address=ip
    )
    return TokenResponse(
        access_token=access,
        refresh_token=refresh,
        expires_in=settings.access_token_ttl_minutes * 60,
    )


def _queue_email(email_builder) -> None:
    send_email_task.delay(
        to=email_builder.to,
        subject=email_builder.subject,
        html=email_builder.html,
        text=email_builder.text,
    )


def _throttle(request: Request, bucket: str, *, limit: int = 10, window: int = 300) -> None:
    """Rate limit credential endpoints by client IP against brute force."""
    client_ip = request.client.host if request.client else "unknown"
    result = check_rate_limit(client_ip, limit=limit, window_seconds=window, bucket=bucket)
    if not result.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many attempts. Please wait a few minutes and try again.",
            headers={"Retry-After": str(result.reset_after)},
        )


def _pad_timing(started: float, target_ms: float = 250.0) -> None:
    elapsed_ms = (time.perf_counter() - started) * 1000
    if elapsed_ms < target_ms:
        time.sleep((target_ms - elapsed_ms) / 1000)


def _send_verification(db: DbSession, user: User) -> None:
    token = auth_service.issue_auth_token(
        db,
        user,
        AuthTokenPurpose.EMAIL_VERIFY,
        ttl=timedelta(hours=settings.email_verify_ttl_hours),
    )
    _queue_email(verification_email(user.email, token, user.full_name))


# --- registration & login ---------------------------------------------------


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, request: Request, db: DbSession) -> TokenResponse:
    _throttle(request, "register")

    if not feature_flags.is_enabled(db, "signups_enabled"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="New registrations are temporarily disabled.",
        )

    try:
        validate_password_strength(payload.password)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    email = payload.email.lower()
    if db.scalar(select(User).where(User.email == email)) is not None:
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
    db.flush()

    _send_verification(db, user)
    tokens = _issue_session(request, db, user)
    db.commit()
    logger.info("auth.registered", user_id=str(user.id))
    return tokens


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: DbSession) -> TokenResponse:
    _throttle(request, "login")

    started = time.perf_counter()
    user = db.scalar(select(User).where(User.email == payload.email.lower()))

    if user is None:
        hash_password(payload.password)  # equalize timing vs. a real account
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
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="This account is disabled."
        )
    if upgraded_hash:
        user.hashed_password = upgraded_hash

    tokens = _issue_session(request, db, user)
    db.commit()
    logger.info("auth.login", user_id=str(user.id))
    return tokens


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, db: DbSession) -> TokenResponse:
    try:
        access, new_refresh, session = auth_service.rotate_session(db, payload.refresh_token)
    except TokenError as exc:
        db.commit()  # persist any revocation the rotation performed
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)
        ) from exc
    db.commit()
    return TokenResponse(
        access_token=access,
        refresh_token=new_refresh,
        expires_in=settings.access_token_ttl_minutes * 60,
    )


# --- sessions ---------------------------------------------------------------


@router.get("/sessions", response_model=list[SessionResponse])
def list_sessions(
    user: CurrentUser, db: DbSession, current_sid: CurrentSessionId
) -> list[SessionResponse]:
    return [
        SessionResponse(
            id=s.id,
            user_agent=s.user_agent,
            ip_address=s.ip_address,
            last_used_at=s.last_used_at,
            created_at=s.created_at,
            current=s.id == current_sid,
        )
        for s in auth_service.active_sessions(db, user)
    ]


@router.delete("/sessions/{session_id}", response_model=MessageResponse)
def revoke_session(
    session_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> MessageResponse:
    if not auth_service.revoke_session(db, user, session_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found.")
    db.commit()
    return MessageResponse(message="Signed out of that device.")


@router.post("/logout", response_model=MessageResponse)
def logout(user: CurrentUser, db: DbSession, current_sid: CurrentSessionId) -> MessageResponse:
    if current_sid is not None:
        auth_service.revoke_session(db, user, current_sid)
        db.commit()
    return MessageResponse(message="Signed out.")


@router.post("/logout-all", response_model=MessageResponse)
def logout_all(user: CurrentUser, db: DbSession) -> MessageResponse:
    count = auth_service.revoke_all_sessions(db, user)
    db.commit()
    return MessageResponse(message=f"Signed out of {count} device(s).")


# --- email verification -----------------------------------------------------


@router.post("/verify-email", response_model=MessageResponse)
def verify_email(payload: VerifyEmailRequest, db: DbSession) -> MessageResponse:
    from datetime import UTC, datetime

    token = auth_service.consume_auth_token(
        db, payload.token, AuthTokenPurpose.EMAIL_VERIFY
    )
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This verification link is invalid or has expired.",
        )
    user = db.get(User, token.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found.")

    # A verify token may carry a pending new email (from a change-email flow).
    if token.payload:
        if db.scalar(select(User).where(User.email == token.payload, User.id != user.id)):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="That email is now used by another account.",
            )
        user.email = token.payload

    user.is_verified = True
    user.verified_at = datetime.now(UTC)
    db.commit()
    logger.info("auth.verified", user_id=str(user.id))
    return MessageResponse(message="Your email is verified.")


@router.post("/resend-verification", response_model=MessageResponse)
def resend_verification(
    user: CurrentUser, request: Request, db: DbSession
) -> MessageResponse:
    _throttle(request, "resend_verify", limit=5, window=600)
    if user.is_verified:
        return MessageResponse(message="Your email is already verified.")
    _send_verification(db, user)
    db.commit()
    return MessageResponse(message="Verification email sent.")


# --- password reset ---------------------------------------------------------


@router.post("/forgot-password", response_model=MessageResponse)
def forgot_password(
    payload: ForgotPasswordRequest, request: Request, db: DbSession
) -> MessageResponse:
    _throttle(request, "forgot", limit=5, window=600)
    user = db.scalar(select(User).where(User.email == payload.email.lower()))
    if user is not None and user.is_active:
        token = auth_service.issue_auth_token(
            db,
            user,
            AuthTokenPurpose.PASSWORD_RESET,
            ttl=timedelta(minutes=settings.password_reset_ttl_minutes),
        )
        _queue_email(password_reset_email(user.email, token, user.full_name))
        db.commit()
    # Always the same response, so the endpoint can't be used to probe which
    # emails have accounts.
    return MessageResponse(
        message="If an account exists for that email, a reset link is on its way."
    )


@router.post("/reset-password", response_model=MessageResponse)
def reset_password(payload: ResetPasswordRequest, db: DbSession) -> MessageResponse:
    try:
        validate_password_strength(payload.new_password)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    token = auth_service.consume_auth_token(
        db, payload.token, AuthTokenPurpose.PASSWORD_RESET
    )
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This reset link is invalid or has expired.",
        )
    user = db.get(User, token.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found.")

    user.hashed_password = hash_password(payload.new_password)
    # A password reset invalidates every existing session — if the account was
    # compromised, this locks the attacker out everywhere.
    auth_service.revoke_all_sessions(db, user)
    db.commit()
    logger.info("auth.password_reset", user_id=str(user.id))
    return MessageResponse(message="Your password has been reset. Please sign in.")


# --- change email / password (authenticated) --------------------------------


@router.post("/change-password", response_model=MessageResponse)
def change_password(
    payload: ChangePasswordRequest,
    user: CurrentUser,
    db: DbSession,
    current_sid: CurrentSessionId,
) -> MessageResponse:
    valid, _ = verify_password(payload.current_password, user.hashed_password)
    if not valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect."
        )
    try:
        validate_password_strength(payload.new_password)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    user.hashed_password = hash_password(payload.new_password)
    if payload.logout_other_sessions:
        auth_service.revoke_all_sessions(db, user, except_id=current_sid)
    db.commit()
    return MessageResponse(message="Your password has been changed.")


@router.post("/change-email", response_model=MessageResponse)
def change_email(
    payload: ChangeEmailRequest, request: Request, user: CurrentUser, db: DbSession
) -> MessageResponse:
    _throttle(request, "change_email", limit=5, window=600)
    valid, _ = verify_password(payload.password, user.hashed_password)
    if not valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Password is incorrect."
        )

    new_email = payload.new_email.lower()
    if new_email == user.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That is already your email address.",
        )
    if db.scalar(select(User).where(User.email == new_email)):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That email is already in use.",
        )

    # Don't switch the address until the new one is confirmed. Stash it on the
    # verification token; verify-email applies it on success.
    token = auth_service.issue_auth_token(
        db,
        user,
        AuthTokenPurpose.EMAIL_VERIFY,
        ttl=timedelta(hours=settings.email_verify_ttl_hours),
        payload=new_email,
    )
    _queue_email(verification_email(new_email, token, user.full_name))
    db.commit()
    return MessageResponse(
        message="Check your new inbox for a link to confirm the change."
    )


@router.get("/me", response_model=UserResponse)
def me(user: CurrentUser) -> User:
    return user
