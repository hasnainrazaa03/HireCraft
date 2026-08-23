"""Multi-provider LLM: registry, pricing, and the client factory's selection +
key-gating logic.

The live Anthropic/OpenAI calls need real keys, so those aren't exercised here;
what's pinned is the routing (which provider/model/key a request resolves to) and
the cost accounting, which are pure and must be correct for any provider.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.llm import factory
from app.services.llm import models as registry
from app.services.llm.client import LlmConfigurationError, Usage
from app.services.llm.factory import client_for_user, resolve_selection


def _user(**kw):
    base = {
        "llm_provider": "gemini",
        "llm_model": None,
        "encrypted_gemini_key": None,
        "encrypted_anthropic_key": None,
        "encrypted_openai_key": None,
    }
    base.update(kw)
    return SimpleNamespace(**base)


# --- Registry ---------------------------------------------------------------


def test_registry_has_all_three_providers():
    assert set(registry.provider_ids()) == {"gemini", "anthropic", "openai"}
    for p in registry.provider_ids():
        assert registry.models_for(p), f"{p} has no models"


def test_model_validation():
    assert registry.is_valid_model("anthropic", "claude-opus-4-8")
    assert registry.is_valid_model("openai", "gpt-4o-mini")
    assert not registry.is_valid_model("openai", "claude-opus-4-8")
    assert not registry.is_valid_model("nope", "x")


def test_pricing_lookup_and_fallback():
    # A catalogued model uses its own price...
    assert registry.price_for("gpt-4o") == (2.50, 10.0)
    # ...an unknown one falls back to the config default.
    from app.core.config import settings
    assert registry.price_for("mystery-model") == (
        settings.llm_input_cost_per_mtok,
        settings.llm_output_cost_per_mtok,
    )


def test_usage_cost_uses_per_model_price():
    # 1M input + 1M output on gpt-4o = 2.50 + 10.0.
    u = Usage(input_tokens=1_000_000, output_tokens=1_000_000, model="gpt-4o", latency_ms=1)
    assert u.cost_usd == 12.50
    # Claude Opus is pricier.
    u2 = Usage(input_tokens=1_000_000, output_tokens=0, model="claude-opus-4-8", latency_ms=1)
    assert u2.cost_usd == 15.0


# --- Factory selection + key gating ----------------------------------------


def test_has_key_true_when_server_gemini_key_set(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "gemini_api_key", "server-key")
    assert factory.has_key(_user(), "gemini")


def test_has_key_false_without_any_key(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    assert not factory.has_key(_user(), "anthropic")


def test_available_providers_reflects_keys(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "gemini_api_key", "g")
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    monkeypatch.setattr(settings, "openai_api_key", "")
    assert factory.available_providers(_user()) == ["gemini"]


def test_resolve_selection_defaults_and_override():
    user = _user(llm_provider="anthropic", llm_model="claude-sonnet-5")
    assert resolve_selection(user) == ("anthropic", "claude-sonnet-5")
    # An explicit override wins and ignores the saved model.
    assert resolve_selection(user, provider="openai", model="gpt-4o") == ("openai", "gpt-4o")
    # An invalid saved model falls back to the provider default.
    bad = _user(llm_provider="openai", llm_model="not-a-model")
    prov, model = resolve_selection(bad)
    assert prov == "openai" and registry.is_valid_model("openai", model)


def test_client_for_user_raises_without_key(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    user = _user(llm_provider="anthropic")
    with pytest.raises(LlmConfigurationError):
        client_for_user(user)


def test_client_for_user_builds_selected_provider(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "openai_api_key", "server-openai")
    user = _user(llm_provider="openai", llm_model="gpt-4o-mini")
    client = client_for_user(user)
    # OpenAIClient is constructed with the resolved model (no live call made).
    assert type(client).__name__ == "OpenAIClient"
    assert client.model == "gpt-4o-mini"


def test_byo_key_preferred_over_server(monkeypatch):
    from app.core.config import settings
    from app.core.crypto import encrypt
    monkeypatch.setattr(settings, "gemini_api_key", "server")
    user = _user(encrypted_gemini_key=encrypt("my-own-key"))
    assert factory.user_key(user, "gemini") == "my-own-key"


# --- generate_raw must not validate -----------------------------------------


class _FakeBlock:
    type = "tool_use"

    def __init__(self, payload):
        self.input = payload


class _FakeMessages:
    def __init__(self, payload):
        self._payload = payload

    def create(self, **_kw):
        return SimpleNamespace(
            content=[_FakeBlock(self._payload)],
            usage=SimpleNamespace(input_tokens=10, output_tokens=20),
        )


def _anthropic_returning(payload):
    client = factory.build_client("anthropic", model="claude-haiku-4-5-20251001", api_key="k")
    client._client = SimpleNamespace(messages=_FakeMessages(payload))
    return client


def _openai_returning(text):
    client = factory.build_client("openai", model="gpt-4o-mini", api_key="k")
    client._call = lambda **_kw: SimpleNamespace(  # type: ignore[method-assign]
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=20),
    )
    return client


# A résumé whose dates arrive in prose form - exactly what generate_raw exists
# to hand back so _repair can normalise it before validation.
_UNREPAIRED = {
    "basics": {"name": "Jane", "email": "jane@x.co"},
    "experience": [{"company": "Acme", "title": "SWE", "start_date": "May 2024"}],
}


@pytest.mark.parametrize(
    "make_client",
    [
        lambda: _anthropic_returning(_UNREPAIRED),
        lambda: _openai_returning(__import__("json").dumps(_UNREPAIRED)),
    ],
    ids=["anthropic", "openai"],
)
def test_generate_raw_returns_unvalidated_payload(make_client):
    """Regression: both providers routed generate_raw through
    generate_structured, which validates. Résumé import calls generate_raw
    precisely because the reply needs repairing first, so any date the model
    wrote as "May 2024" made the whole import fail on those providers."""
    from app.schemas.resume import MasterResume

    payload, usage, _raw = make_client().generate_raw(
        prompt="x", schema=MasterResume
    )
    assert payload["experience"][0]["start_date"] == "May 2024"
    assert usage.input_tokens == 10


@pytest.mark.parametrize(
    "make_client",
    [
        lambda: _anthropic_returning(_UNREPAIRED),
        lambda: _openai_returning(__import__("json").dumps(_UNREPAIRED)),
    ],
    ids=["anthropic", "openai"],
)
def test_generate_structured_still_validates(make_client):
    from app.schemas.resume import MasterResume
    from app.services.llm.client import LlmResponseError

    with pytest.raises(LlmResponseError):
        make_client().generate_structured(prompt="x", schema=MasterResume)


def test_fast_client_is_none_without_a_gemini_key(monkeypatch):
    """Without a Gemini key the cheap client must be None, not an equivalent copy
    of the primary — run_pipeline's `fast is client` check relies on identity to
    avoid pointlessly retrying the same provider after a genuine failure."""
    from app.services.llm import factory

    monkeypatch.setattr(factory, "_SERVER_KEY", {**factory._SERVER_KEY, "gemini": lambda: None})
    monkeypatch.setattr(factory, "user_key", lambda user, provider: None)

    class U:
        llm_provider = "anthropic"
        llm_model = "claude-sonnet-5"

    assert factory.fast_client_for_user(U()) is None


def test_fast_client_uses_gemini_flash_when_a_key_exists(monkeypatch):
    from app.services.llm import factory

    monkeypatch.setattr(factory, "_SERVER_KEY", {**factory._SERVER_KEY, "gemini": lambda: "k"})
    monkeypatch.setattr(factory, "user_key", lambda user, provider: None)

    class U:
        llm_provider = "anthropic"
        llm_model = "claude-sonnet-5"

    client = factory.fast_client_for_user(U())
    assert client is not None
    assert client.model == "gemini-flash-latest"
