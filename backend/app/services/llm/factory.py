"""Provider-agnostic client construction.

One place that answers: for this user (and any per-request override), which
provider + model should run, which key pays for it, and build the matching
client. Everything else in the app asks the factory and treats the result as an
opaque ``LlmClient``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from pydantic import BaseModel

from app.core.config import settings
from app.core.crypto import DecryptionError, decrypt
from app.services.llm import models as registry
from app.services.llm.client import (
    GeminiClient,
    LlmConfigurationError,
    LlmResult,
    TextResult,
    Usage,
)
from app.services.llm.providers import AnthropicClient, OpenAIClient

if TYPE_CHECKING:
    from app.models.user import User


class LlmClient(Protocol):
    """The surface every provider client implements."""

    model: str

    def generate_structured(self, *, prompt: str, schema: type[BaseModel], system_instruction: str | None = ...,
                            temperature: float | None = ..., max_output_tokens: int | None = ...) -> LlmResult: ...

    def generate_raw(self, *, prompt: str, schema: type[BaseModel], system_instruction: str | None = ...,
                     temperature: float | None = ..., max_output_tokens: int | None = ...) -> tuple[dict, Usage, str]: ...

    def generate_text(self, *, prompt: str, system_instruction: str | None = ...,
                      temperature: float | None = ..., max_output_tokens: int | None = ...) -> TextResult: ...


_USER_KEY_ATTR = {
    "gemini": "encrypted_gemini_key",
    "anthropic": "encrypted_anthropic_key",
    "openai": "encrypted_openai_key",
}
_SERVER_KEY = {
    "gemini": lambda: settings.gemini_api_key,
    "anthropic": lambda: settings.anthropic_api_key,
    "openai": lambda: settings.openai_api_key,
}
_BUILDERS = {
    "gemini": GeminiClient,
    "anthropic": AnthropicClient,
    "openai": OpenAIClient,
}


def user_key(user: User, provider: str) -> str | None:
    """The user's own decrypted key for a provider, if they've set one."""
    attr = _USER_KEY_ATTR.get(provider)
    encrypted = getattr(user, attr, None) if attr else None
    if not encrypted:
        return None
    try:
        return decrypt(encrypted)
    except DecryptionError:
        return None


def has_key(user: User, provider: str) -> bool:
    """Is this provider usable — the user's key or a server-configured one?"""
    if not registry.is_valid_provider(provider):
        return False
    return bool(user_key(user, provider) or _SERVER_KEY[provider]())


def available_providers(user: User) -> list[str]:
    return [p for p in registry.provider_ids() if has_key(user, p)]


def resolve_selection(user: User, *, provider: str | None = None, model: str | None = None) -> tuple[str, str]:
    """Resolve (provider, model): explicit override → user's saved choice →
    server default. The model falls back to the provider's default."""
    prov = provider or user.llm_provider or settings.default_llm_provider
    if not registry.is_valid_provider(prov):
        prov = settings.default_llm_provider
    mdl = model or (user.llm_model if provider is None else None) or registry.default_model(prov)
    if not registry.is_valid_model(prov, mdl):
        mdl = registry.default_model(prov)
    return prov, mdl


def build_client(provider: str, model: str | None = None, api_key: str | None = None) -> LlmClient:
    if not registry.is_valid_provider(provider):
        raise LlmConfigurationError(f"Unknown LLM provider {provider!r}.")
    return _BUILDERS[provider](api_key=api_key, model=model)


def client_for_user(user: User, *, provider: str | None = None, model: str | None = None) -> LlmClient:
    """Build the client this user's request should run on, billing their key when
    they have one and falling back to the server key. Raises if neither exists."""
    prov, mdl = resolve_selection(user, provider=provider, model=model)
    key = user_key(user, prov) or _SERVER_KEY[prov]()
    if not key:
        raise LlmConfigurationError(
            f"{registry.provider_label(prov)} isn't configured. Add an API key in Settings."
        )
    return build_client(prov, model=mdl, api_key=key)


# Cheap model for the pipeline's mechanical steps (reading the job into
# requirements, coverage planning) so a full tailoring on a premium primary model
# stays inexpensive without giving up writing quality.
_FAST_GEMINI_MODEL = "gemini-flash-latest"


def fast_client_for_user(user: User) -> LlmClient:
    """A cheap client for mechanical steps. Prefers Gemini Flash on any available
    Gemini key (the user's or the server's); falls back to the user's primary
    client when no Gemini key exists — so callers can use it unconditionally.

    When the primary provider is itself Gemini this returns an equivalent client,
    so nothing changes; the split only kicks in for premium primaries (Claude/GPT)."""
    key = user_key(user, "gemini") or _SERVER_KEY["gemini"]()
    if key:
        return build_client("gemini", model=_FAST_GEMINI_MODEL, api_key=key)
    return client_for_user(user)
