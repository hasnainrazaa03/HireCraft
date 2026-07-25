"""LLM provider + model registry.

The catalog of every model path the app can drive, grouped by provider, with
approximate per-model pricing used for cost accounting. Adding a model here makes
it selectable everywhere (account settings, the Copilot switcher) without touching
the client code.

Prices are USD per 1M tokens (input, output) and are approximate public list
prices — they inform the cost estimate, not billing.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import settings


@dataclass(frozen=True)
class ModelInfo:
    id: str
    label: str
    input_cost: float
    output_cost: float


# Ordered best-default-first within each provider.
_GEMINI = [
    ModelInfo("gemini-flash-latest", "Gemini Flash (latest)", 0.10, 0.40),
    ModelInfo("gemini-2.5-flash", "Gemini 2.5 Flash", 0.30, 2.50),
    ModelInfo("gemini-2.5-pro", "Gemini 2.5 Pro", 1.25, 10.0),
    ModelInfo("gemini-2.0-flash", "Gemini 2.0 Flash", 0.10, 0.40),
    ModelInfo("gemini-1.5-pro", "Gemini 1.5 Pro", 1.25, 5.0),
    ModelInfo("gemini-1.5-flash", "Gemini 1.5 Flash", 0.075, 0.30),
]

_ANTHROPIC = [
    ModelInfo("claude-haiku-4-5-20251001", "Claude Haiku 4.5", 1.0, 5.0),
    ModelInfo("claude-sonnet-5", "Claude Sonnet 5", 3.0, 15.0),
    ModelInfo("claude-opus-4-8", "Claude Opus 4.8", 15.0, 75.0),
    ModelInfo("claude-fable-5", "Claude Fable 5", 1.0, 5.0),
    ModelInfo("claude-3-5-sonnet-latest", "Claude 3.5 Sonnet", 3.0, 15.0),
    ModelInfo("claude-3-5-haiku-latest", "Claude 3.5 Haiku", 0.80, 4.0),
]

_OPENAI = [
    ModelInfo("gpt-4o-mini", "GPT-4o mini", 0.15, 0.60),
    ModelInfo("gpt-4o", "GPT-4o", 2.50, 10.0),
    ModelInfo("gpt-4.1", "GPT-4.1", 2.0, 8.0),
    ModelInfo("gpt-4.1-mini", "GPT-4.1 mini", 0.40, 1.60),
    ModelInfo("gpt-4.1-nano", "GPT-4.1 nano", 0.10, 0.40),
    ModelInfo("o4-mini", "o4-mini (reasoning)", 1.10, 4.40),
    ModelInfo("o3", "o3 (reasoning)", 2.0, 8.0),
    ModelInfo("o3-mini", "o3-mini (reasoning)", 1.10, 4.40),
]

PROVIDERS: dict[str, dict] = {
    "gemini": {"label": "Google Gemini", "models": _GEMINI},
    "anthropic": {"label": "Anthropic Claude", "models": _ANTHROPIC},
    "openai": {"label": "OpenAI", "models": _OPENAI},
}

_ALL_MODELS: dict[str, ModelInfo] = {
    m.id: m for prov in PROVIDERS.values() for m in prov["models"]
}


def provider_ids() -> list[str]:
    return list(PROVIDERS)


def provider_label(provider: str) -> str:
    return PROVIDERS.get(provider, {}).get("label", provider)


def models_for(provider: str) -> list[ModelInfo]:
    return PROVIDERS.get(provider, {}).get("models", [])


def is_valid_provider(provider: str) -> bool:
    return provider in PROVIDERS


def is_valid_model(provider: str, model: str) -> bool:
    return any(m.id == model for m in models_for(provider))


def default_model(provider: str) -> str:
    """The provider's configured default, or its first listed model."""
    configured = {
        "gemini": settings.gemini_model,
        "anthropic": settings.anthropic_model,
        "openai": settings.openai_model,
    }.get(provider)
    if configured and is_valid_model(provider, configured):
        return configured
    models = models_for(provider)
    # If the configured default isn't in the catalog, still honor it (aliases
    # like "gemini-flash-latest" may be configured but unlisted variants exist).
    return configured or (models[0].id if models else "")


def price_for(model: str) -> tuple[float, float]:
    """(input, output) USD per 1M tokens for a model, or the config fallback."""
    info = _ALL_MODELS.get(model)
    if info is not None:
        return info.input_cost, info.output_cost
    return settings.llm_input_cost_per_mtok, settings.llm_output_cost_per_mtok
