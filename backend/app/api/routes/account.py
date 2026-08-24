"""Account management: settings, data export, and deletion."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, DbSession
from app.core.config import settings
from app.core.crypto import decrypt, encrypt
from app.core.logging import get_logger
from app.core.rate_limit import check_rate_limit
from app.core.security import generate_extension_key
from app.models.application import Application
from app.models.job import Job
from app.models.llm_usage import LlmUsage
from app.models.resume import ResumeProfile
from app.models.user import DEFAULT_NOTIFICATION_PREFS, User
from app.schemas.api import (
    AccountSettingsUpdate,
    LlmKeyUpdate,
    LlmModelInfo,
    LlmProviderInfo,
    LlmSelectionUpdate,
    LlmSettings,
    MessageResponse,
    UserResponse,
)
from app.schemas.profile import ApiKeyStatus, ApiKeyUpdate
from app.services import storage
from app.services.llm import factory
from app.services.llm import models as registry
from app.services.llm.client import GeminiClient, LlmError
from app.services.llm.factory import resolve_selection

router = APIRouter(prefix="/account", tags=["account"])
logger = get_logger(__name__)


class _ApiKeyProbe(BaseModel):
    """Minimal schema for the key-validation probe call."""

    ok: bool = True


def _throttle_key_probe(user: User) -> None:
    """Limit how often a user can have us call out to a provider to test a key.

    Saving a key makes a live outbound request, so without a limit an
    authenticated user could drive unbounded traffic at Gemini/Anthropic/OpenAI
    one request at a time. It gets its own bucket rather than the generation
    quota: mistyping a key a few times shouldn't eat the budget the user needs
    for actual tailoring runs.
    """
    result = check_rate_limit(
        str(user.id), limit=10, window_seconds=600, bucket="llm_key_probe"
    )
    if not result.allowed:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many key checks. Wait a few minutes and try again.",
            headers={"Retry-After": str(result.reset_after)},
        )


@router.patch("/settings", response_model=UserResponse)
def update_settings(
    payload: AccountSettingsUpdate, user: CurrentUser, db: DbSession
) -> User:
    if payload.theme is not None:
        user.theme = payload.theme
    if payload.full_name is not None:
        user.full_name = payload.full_name or None
    if payload.notification_prefs is not None:
        # Merge onto known keys only, so an unknown key can't pollute prefs.
        merged = {**DEFAULT_NOTIFICATION_PREFS, **user.notification_prefs}
        for key, value in payload.notification_prefs.items():
            if key in DEFAULT_NOTIFICATION_PREFS:
                merged[key] = bool(value)
        user.notification_prefs = merged
    db.commit()
    db.refresh(user)
    return user


@router.get("/api-key", response_model=ApiKeyStatus)
def api_key_status(user: CurrentUser) -> ApiKeyStatus:
    """Whether the user has their own key, and a last-4 hint — never the key."""
    if not user.encrypted_gemini_key:
        return ApiKeyStatus(configured=False)
    try:
        hint = decrypt(user.encrypted_gemini_key)[-4:]
    except Exception:  # noqa: BLE001 - a stale ciphertext shouldn't 500 this
        hint = None
    return ApiKeyStatus(configured=True, hint=f"…{hint}" if hint else None)


@router.put("/api-key", response_model=ApiKeyStatus)
def set_api_key(payload: ApiKeyUpdate, user: CurrentUser, db: DbSession) -> ApiKeyStatus:
    """Validate a Gemini key with a tiny live call, then store it encrypted."""
    _throttle_key_probe(user)
    key = payload.api_key.strip()
    try:
        # A cheap generate confirms the key works before we save it, so a bad
        # key fails here rather than silently on the user's next tailoring run.
        GeminiClient(api_key=key).generate_structured(
            prompt="Return the JSON {\"ok\": true}.",
            schema=_ApiKeyProbe,
            temperature=0.0,
            max_output_tokens=32,
        )
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"That key didn't work: {exc}",
        ) from exc

    user.encrypted_gemini_key = encrypt(key)
    db.commit()
    logger.info("account.api_key_set", user_id=str(user.id))
    return ApiKeyStatus(configured=True, hint=f"…{key[-4:]}")


@router.delete("/api-key", response_model=MessageResponse)
def clear_api_key(user: CurrentUser, db: DbSession) -> MessageResponse:
    user.encrypted_gemini_key = None
    db.commit()
    return MessageResponse(message="Your API key has been removed. Runs use the shared key.")


# --- Multi-provider LLM settings --------------------------------------------

_KEY_ATTR = {
    "gemini": "encrypted_gemini_key",
    "anthropic": "encrypted_anthropic_key",
    "openai": "encrypted_openai_key",
}


def _llm_settings(user: User) -> LlmSettings:
    prov, model = resolve_selection(user)
    providers: list[LlmProviderInfo] = []
    for pid in registry.provider_ids():
        byo = factory.user_key(user, pid)
        providers.append(
            LlmProviderInfo(
                id=pid,
                label=registry.provider_label(pid),
                models=[
                    LlmModelInfo(id=m.id, label=m.label, input_cost=m.input_cost, output_cost=m.output_cost)
                    for m in registry.models_for(pid)
                ],
                has_key=factory.has_key(user, pid),
                byo_key=bool(byo),
                key_hint=byo[-4:] if byo else None,
            )
        )
    return LlmSettings(provider=prov, model=model, providers=providers)


@router.get("/extension-key", response_model=dict)
def extension_key_status(user: CurrentUser) -> dict:
    """Whether a browser-extension key exists, and when it was issued.

    Never the key itself — only its hash is stored, so it genuinely cannot be
    shown again after it is created.
    """
    return {
        "configured": bool(user.extension_key_hash),
        "created_at": (
            user.extension_key_created_at.isoformat()
            if user.extension_key_created_at
            else None
        ),
    }


@router.post("/extension-key", response_model=dict)
def issue_extension_key(user: CurrentUser, db: DbSession) -> dict:
    """Issue a browser-extension key, replacing any existing one.

    The plaintext is returned exactly once. Issuing again invalidates the
    previous key, which is also how a key gets rotated if it leaks.
    """
    key, digest = generate_extension_key()
    user.extension_key_hash = digest
    user.extension_key_created_at = datetime.now(UTC)
    db.commit()
    logger.info("account.extension_key_issued", user_id=str(user.id))
    return {
        "key": key,
        "created_at": user.extension_key_created_at.isoformat(),
        "note": "Copy this now — it is stored only as a hash and cannot be shown again.",
    }


@router.delete("/extension-key", response_model=MessageResponse)
def revoke_extension_key(user: CurrentUser, db: DbSession) -> MessageResponse:
    """Revoke the extension key; the extension stops working immediately."""
    user.extension_key_hash = None
    user.extension_key_created_at = None
    db.commit()
    logger.info("account.extension_key_revoked", user_id=str(user.id))
    return MessageResponse(message="Extension key revoked.")


@router.get("/llm", response_model=LlmSettings)
def get_llm_settings(user: CurrentUser) -> LlmSettings:
    """Current provider/model + every provider's models and key status."""
    return _llm_settings(user)


@router.put("/llm", response_model=LlmSettings)
def set_llm_selection(payload: LlmSelectionUpdate, user: CurrentUser, db: DbSession) -> LlmSettings:
    """Switch the active provider (and optionally model). One at a time."""
    if not registry.is_valid_provider(payload.provider):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown provider.")
    if not factory.has_key(user, payload.provider):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Add a {registry.provider_label(payload.provider)} API key before selecting it.",
        )
    # Validate only what the client actually chose. default_model() may return a
    # model configured via env that isn't in the catalog (an alias, a preview
    # build); rejecting it here made the server's own configured default
    # unselectable.
    if payload.model and not registry.is_valid_model(payload.provider, payload.model):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown model for that provider.")
    model = payload.model or registry.default_model(payload.provider)
    if not model:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That provider has no usable model.")
    user.llm_provider = payload.provider
    user.llm_model = model
    db.commit()
    db.refresh(user)
    logger.info("account.llm_selected", user_id=str(user.id), provider=payload.provider, model=model)
    return _llm_settings(user)


@router.put("/llm/keys/{provider}", response_model=LlmSettings)
def set_llm_key(provider: str, payload: LlmKeyUpdate, user: CurrentUser, db: DbSession) -> LlmSettings:
    """Validate a provider API key with a tiny live call, then store it encrypted."""
    if provider not in _KEY_ATTR:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown provider.")
    _throttle_key_probe(user)
    key = payload.api_key.strip()
    try:
        client = factory.build_client(provider, model=registry.default_model(provider), api_key=key)
        client.generate_text(prompt="Reply with the single word: ok", max_output_tokens=5)
    except LlmError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"That {registry.provider_label(provider)} key was rejected: {exc}",
        ) from exc

    setattr(user, _KEY_ATTR[provider], encrypt(key))
    db.commit()
    db.refresh(user)
    logger.info("account.llm_key_set", user_id=str(user.id), provider=provider)
    return _llm_settings(user)


@router.delete("/llm/keys/{provider}", response_model=LlmSettings)
def clear_llm_key(provider: str, user: CurrentUser, db: DbSession) -> LlmSettings:
    if provider not in _KEY_ATTR:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown provider.")
    setattr(user, _KEY_ATTR[provider], None)
    # If they cleared the key for their active provider and it's now unusable,
    # fall back to a provider that still works.
    if user.llm_provider == provider and not factory.has_key(user, provider):
        fallback = next(iter(factory.available_providers(user)), settings.default_llm_provider)
        user.llm_provider = fallback
        user.llm_model = registry.default_model(fallback)
    db.commit()
    db.refresh(user)
    return _llm_settings(user)


@router.get("/export")
def export_data(user: CurrentUser, db: DbSession) -> JSONResponse:
    """Return everything HireCraft holds for this user as one JSON document."""
    resumes = db.scalars(
        select(ResumeProfile).where(ResumeProfile.user_id == user.id)
    ).all()
    jobs = db.scalars(select(Job).where(Job.user_id == user.id)).all()
    applications = db.scalars(
        select(Application).where(Application.user_id == user.id)
    ).all()
    usage = db.scalars(select(LlmUsage).where(LlmUsage.user_id == user.id)).all()

    document = {
        "exported_at": datetime.now(UTC).isoformat(),
        "account": {
            "id": str(user.id),
            "email": user.email,
            "full_name": user.full_name,
            "is_verified": user.is_verified,
            "theme": user.theme,
            "notification_prefs": user.notification_prefs,
            "created_at": user.created_at.isoformat(),
        },
        "resume_profiles": [
            {"id": str(r.id), "name": r.name, "content": r.content, "is_default": r.is_default}
            for r in resumes
        ],
        "jobs": [
            {"id": str(j.id), "title": j.title, "company": j.company, "url": j.url}
            for j in jobs
        ],
        "applications": [
            {
                "id": str(a.id),
                "pipeline_status": a.pipeline_status.value,
                "tracker_status": a.tracker_status.value,
                "tailored_resume": a.tailored_resume,
                "total_cost_usd": a.total_cost_usd,
                "created_at": a.created_at.isoformat(),
            }
            for a in applications
        ],
        "llm_usage": [
            {
                "purpose": u.purpose,
                "model": u.model,
                "input_tokens": u.input_tokens,
                "output_tokens": u.output_tokens,
                "cost_usd": u.cost_usd,
                "created_at": u.created_at.isoformat(),
            }
            for u in usage
        ],
    }
    filename = f"hirecraft-export-{user.id}.json"
    return JSONResponse(
        content=document,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete("", response_model=MessageResponse)
def delete_account(user: CurrentUser, db: DbSession) -> MessageResponse:
    """Permanently delete the account and everything belonging to it."""
    user_id = user.id
    try:
        storage.delete_prefix(str(user_id))
    except storage.StorageError:
        logger.warning("account.artifact_cleanup_failed", user_id=str(user_id))

    # All child rows cascade via the ORM relationships / FK ondelete.
    db.delete(user)
    db.commit()
    logger.info("account.deleted", user_id=str(user_id))
    return MessageResponse(message="Your account and all its data have been deleted.")
