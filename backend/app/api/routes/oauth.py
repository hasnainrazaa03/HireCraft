"""OAuth sign-in routes (Google, GitHub).

Flow: the frontend links to /authorize, which 302s to the provider with a CSRF
state cookie; the provider redirects back to /callback, which validates the
state, links or creates the account, issues our own session tokens, and redirects
to the frontend's callback page with the tokens in the URL fragment.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse

from app.api.deps import DbSession
from app.core.config import settings
from app.core.logging import get_logger
from app.services import auth_service
from app.services import oauth as oauth_service
from app.services.oauth import OAuthError

router = APIRouter(prefix="/auth/oauth", tags=["auth"])
logger = get_logger(__name__)

_STATE_COOKIE = "hc_oauth_state"


def _api_base(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@router.get("/providers")
def list_providers() -> dict[str, list[str]]:
    """Which providers are configured — the frontend shows a button per entry."""
    return {"providers": oauth_service.enabled_providers()}


@router.get("/{provider}/authorize")
def authorize(provider: str, request: Request) -> RedirectResponse:
    try:
        url, state = oauth_service.build_authorize_url(provider, _api_base(request))
    except OAuthError as exc:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, str(exc)) from exc

    response = RedirectResponse(url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    response.set_cookie(
        _STATE_COOKIE,
        state,
        max_age=600,
        httponly=True,
        samesite="lax",
        secure=settings.environment == "production",
    )
    return response


@router.get("/{provider}/callback")
def callback(
    provider: str, request: Request, db: DbSession, code: str = "", state: str = ""
) -> RedirectResponse:
    expected = request.cookies.get(_STATE_COOKIE)
    front = settings.frontend_base_url.rstrip("/")

    def fail(reason: str) -> RedirectResponse:
        logger.warning("oauth.failed", provider=provider, reason=reason)
        resp = RedirectResponse(
            f"{front}/login?oauth_error={reason}", status_code=status.HTTP_303_SEE_OTHER
        )
        resp.delete_cookie(_STATE_COOKIE)
        return resp

    if not code or not state or not expected or state != expected:
        return fail("invalid_state")

    try:
        token = oauth_service.exchange_code(provider, code, _api_base(request))
        identity = oauth_service.fetch_identity(provider, token)
        user = oauth_service.link_or_create_user(db, identity)
        # The password login path refuses a disabled account; this one has to as
        # well, or a suspended user just walks in through the side door.
        if not user.is_active:
            db.rollback()
            return fail("account_disabled")
        access, refresh, _ = auth_service.create_session(
            db, user, user_agent=request.headers.get("user-agent"), ip_address=None
        )
        db.commit()
    except OAuthError:
        db.rollback()
        return fail("provider_error")

    logger.info("oauth.success", provider=provider, user_id=str(user.id))
    resp = RedirectResponse(
        f"{front}/oauth/callback#access_token={access}&refresh_token={refresh}",
        status_code=status.HTTP_303_SEE_OTHER,
    )
    resp.delete_cookie(_STATE_COOKIE)
    return resp
