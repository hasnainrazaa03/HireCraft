"""Shared FastAPI dependencies: authentication and rate limiting."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.rate_limit import check_generation_limit
from app.core.security import TokenError, decode_token, token_subject
from app.db.session import get_db
from app.models.user import User

bearer_scheme = HTTPBearer(auto_error=False, description="JWT access token")

DbSession = Annotated[Session, Depends(get_db)]


def get_current_user(
    db: DbSession,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(bearer_scheme)
    ] = None,
) -> User:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if credentials is None or not credentials.credentials:
        raise unauthorized

    try:
        user_id: uuid.UUID = token_subject(credentials.credentials, "access")
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    user = db.get(User, user_id)
    if user is None:
        raise unauthorized
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="This account is disabled."
        )
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_current_session_id(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(bearer_scheme)
    ] = None,
) -> uuid.UUID | None:
    """The session id embedded in the access token, if present.

    Lets a handler act on the caller's *own* session (e.g. log out this device,
    or "log out everywhere else") without a second round-trip.
    """
    if credentials is None or not credentials.credentials:
        return None
    try:
        payload = decode_token(credentials.credentials, "access")
    except TokenError:
        return None
    sid = payload.get("sid")
    try:
        return uuid.UUID(str(sid)) if sid else None
    except ValueError:
        return None


CurrentSessionId = Annotated[uuid.UUID | None, Depends(get_current_session_id)]


def enforce_generation_quota(request: Request, user: CurrentUser) -> User:
    """Tighter limit for endpoints that spend LLM credits."""
    result = check_generation_limit(str(user.id))
    if not result.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"You have reached the generation limit of {result.limit} per hour. "
                f"Try again later."
            ),
            headers={"Retry-After": str(result.reset_after)},
        )
    request.state.rate_limit = result
    return user


GenerationUser = Annotated[User, Depends(enforce_generation_quota)]


def require_admin(user: CurrentUser) -> User:
    """Gate admin-only endpoints on the existing is_superuser flag."""
    if not user.is_superuser:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required.",
        )
    return user


AdminUser = Annotated[User, Depends(require_admin)]
