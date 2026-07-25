"""Gemini client wrapper.

Responsibilities kept deliberately narrow: send a prompt, get back a *validated*
Pydantic object, and report exactly what it cost. Everything about resume
truthfulness lives in ``guardrails.py`` - this layer never decides what is
acceptable, only what was said and what it cost to say it.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.core.config import settings
from app.core.logging import get_logger
from app.services.llm.schema import to_gemini_schema

logger = get_logger(__name__)

T = TypeVar("T", bound=BaseModel)

# Models sometimes wrap JSON in a markdown fence despite a JSON mime type.
_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


class LlmError(Exception):
    """Base class for LLM failures."""


class LlmConfigurationError(LlmError):
    """Raised when the client is used without a configured API key."""


class LlmTransientError(LlmError):
    """A failure worth retrying: rate limit, timeout, 5xx."""


class LlmResponseError(LlmError):
    """The model replied, but not with data matching the requested schema."""


@dataclass(frozen=True)
class Usage:
    """Token accounting for a single call."""

    input_tokens: int
    output_tokens: int
    model: str
    latency_ms: int

    @property
    def cost_usd(self) -> float:
        # Per-model pricing from the registry, falling back to the config default
        # for any model not catalogued.
        from app.services.llm.models import price_for

        in_price, out_price = price_for(self.model)
        return round(
            self.input_tokens / 1_000_000 * in_price
            + self.output_tokens / 1_000_000 * out_price,
            6,
        )


@dataclass(frozen=True)
class LlmResult[TModel: BaseModel]:
    data: TModel
    usage: Usage
    raw_text: str


@dataclass(frozen=True)
class TextResult:
    """Free-form (non-JSON) generation result."""

    text: str
    usage: Usage


def _strip_fence(text: str) -> str:
    if match := _JSON_FENCE.search(text):
        return match.group(1)
    return text.strip()


def _loads(text: str) -> Any:
    """Parse a model reply as JSON, unwrapping a single-element list wrapper."""
    payload = _strip_fence(text)
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise LlmResponseError(
            f"Gemini did not return valid JSON: {exc}. First 200 chars: {payload[:200]!r}"
        ) from exc
    if isinstance(parsed, list) and len(parsed) == 1 and isinstance(parsed[0], dict):
        parsed = parsed[0]
    return parsed


def _classify(exc: Exception) -> LlmError:
    """Map a provider exception onto our retryable / terminal split."""
    message = str(exc)
    lowered = message.lower()
    transient_markers = (
        "429",
        "500",
        "502",
        "503",
        "504",
        "rate limit",
        "resource_exhausted",
        "unavailable",
        "deadline",
        "timeout",
        "internal error",
    )
    if any(marker in lowered for marker in transient_markers):
        return LlmTransientError(message)
    return LlmError(message)


class GeminiClient:
    """Thin, testable wrapper around the google-genai SDK."""

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key if api_key is not None else settings.gemini_api_key
        self.model = model or settings.gemini_model
        self._client: Any = None

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def _ensure_client(self) -> Any:
        if not self.configured:
            raise LlmConfigurationError(
                "GEMINI_API_KEY is not set. Add it to backend/.env - get one at "
                "https://aistudio.google.com/apikey"
            )
        if self._client is None:
            try:
                from google import genai
            except ImportError as exc:  # pragma: no cover
                raise LlmConfigurationError(
                    "google-genai is not installed. Run: pip install google-genai"
                ) from exc
            self._client = genai.Client(api_key=self.api_key)
        return self._client

    def _generate_text(
        self,
        *,
        prompt: str,
        schema: type[BaseModel],
        system_instruction: str | None,
        temperature: float | None,
        max_output_tokens: int | None,
    ) -> tuple[str, Usage]:
        """Make the Gemini call and return the raw reply text plus usage. Shared
        by generate_structured (validates) and generate_raw (does not)."""

        @retry(
            retry=retry_if_exception_type(LlmTransientError),
            stop=stop_after_attempt(settings.llm_max_retries),
            wait=wait_exponential(multiplier=1, min=2, max=20),
            reraise=True,
        )
        def _call() -> tuple[str, int, int]:
            client = self._ensure_client()
            config: dict[str, Any] = {
                "response_mime_type": "application/json",
                # A sanitized schema, not the Pydantic model. Gemini rejects the
                # $ref/anyOf/default keywords Pydantic emits with a bare
                # 400 INVALID_ARGUMENT; to_gemini_schema reduces the model to the
                # subset Gemini accepts. The full model is still enforced by
                # _parse on the way back, so nothing is lost.
                "response_schema": to_gemini_schema(schema),
                "temperature": (
                    temperature if temperature is not None else settings.llm_temperature
                ),
                "max_output_tokens": max_output_tokens or settings.llm_max_output_tokens,
            }
            if system_instruction:
                config["system_instruction"] = system_instruction
            # Cap internal reasoning so it can't consume the output budget and
            # truncate the JSON. Sent only when set, since some models reject 0.
            if settings.llm_thinking_budget > 0:
                config["thinking_config"] = {
                    "thinking_budget": settings.llm_thinking_budget
                }

            try:
                response = client.models.generate_content(
                    model=self.model, contents=prompt, config=config
                )
            except Exception as exc:  # SDK raises provider-specific types
                error = _classify(exc)
                logger.warning(
                    "llm.call_failed",
                    model=self.model,
                    retryable=isinstance(error, LlmTransientError),
                    error=str(exc)[:300],
                )
                raise error from exc

            text = getattr(response, "text", None) or ""
            meta = getattr(response, "usage_metadata", None)
            prompt_tokens = getattr(meta, "prompt_token_count", 0) or 0
            output_tokens = getattr(meta, "candidates_token_count", 0) or 0

            if not text.strip():
                # An empty body with a length finish reason means the schema was
                # too large for the token budget, not a transient blip.
                raise LlmResponseError(
                    "Gemini returned an empty response. The output token limit may "
                    "be too low for a resume this size."
                )
            return text, prompt_tokens, output_tokens

        started = time.perf_counter()
        text, prompt_tokens, output_tokens = _call()
        latency_ms = int((time.perf_counter() - started) * 1000)

        usage = Usage(
            input_tokens=prompt_tokens,
            output_tokens=output_tokens,
            model=self.model,
            latency_ms=latency_ms,
        )
        return text, usage

    def generate_structured(
        self,
        *,
        prompt: str,
        schema: type[T],
        system_instruction: str | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> LlmResult[T]:
        """Call Gemini and parse the reply into ``schema`` (validated).

        Raises:
            LlmConfigurationError: no API key configured.
            LlmTransientError: retryable provider failure, after retries are spent.
            LlmResponseError: reply could not be validated against ``schema``.
        """
        text, usage = self._generate_text(
            prompt=prompt,
            schema=schema,
            system_instruction=system_instruction,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        data = self._parse(text, schema)
        logger.info(
            "llm.call_succeeded",
            model=self.model,
            schema=schema.__name__,
            cost_usd=usage.cost_usd,
            latency_ms=usage.latency_ms,
        )
        return LlmResult(data=data, usage=usage, raw_text=text)

    def generate_raw(
        self,
        *,
        prompt: str,
        schema: type[BaseModel],
        system_instruction: str | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> tuple[dict[str, Any], Usage, str]:
        """Like generate_structured, but return the parsed JSON dict WITHOUT
        validating it against ``schema`` (the schema still guides Gemini).

        For cases that must repair the JSON before it can pass strict validation
        — e.g. importing a résumé whose dates arrive as "May 2024". Returns
        ``(payload, usage, raw_text)``.
        """
        text, usage = self._generate_text(
            prompt=prompt,
            schema=schema,
            system_instruction=system_instruction,
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        )
        payload = _loads(text)
        if not isinstance(payload, dict):
            raise LlmResponseError("Expected a JSON object from Gemini.")
        return payload, usage, text

    def generate_text(
        self,
        *,
        prompt: str,
        system_instruction: str | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> TextResult:
        """Free-form text generation (no JSON schema) — for conversational replies.

        Same transport, retry, and cost accounting as the structured path, minus
        the response_schema/JSON mime that would force structured output.
        """

        @retry(
            retry=retry_if_exception_type(LlmTransientError),
            stop=stop_after_attempt(settings.llm_max_retries),
            wait=wait_exponential(multiplier=1, min=2, max=20),
            reraise=True,
        )
        def _call() -> tuple[str, int, int]:
            client = self._ensure_client()
            config: dict[str, Any] = {
                "temperature": (
                    temperature if temperature is not None else settings.llm_temperature
                ),
                "max_output_tokens": max_output_tokens or settings.llm_max_output_tokens,
            }
            if system_instruction:
                config["system_instruction"] = system_instruction
            if settings.llm_thinking_budget > 0:
                config["thinking_config"] = {"thinking_budget": settings.llm_thinking_budget}

            try:
                response = client.models.generate_content(
                    model=self.model, contents=prompt, config=config
                )
            except Exception as exc:
                error = _classify(exc)
                logger.warning(
                    "llm.call_failed",
                    model=self.model,
                    retryable=isinstance(error, LlmTransientError),
                    error=str(exc)[:300],
                )
                raise error from exc

            text = getattr(response, "text", None) or ""
            meta = getattr(response, "usage_metadata", None)
            prompt_tokens = getattr(meta, "prompt_token_count", 0) or 0
            output_tokens = getattr(meta, "candidates_token_count", 0) or 0
            if not text.strip():
                raise LlmResponseError("Gemini returned an empty response.")
            return text, prompt_tokens, output_tokens

        started = time.perf_counter()
        text, prompt_tokens, output_tokens = _call()
        usage = Usage(
            input_tokens=prompt_tokens,
            output_tokens=output_tokens,
            model=self.model,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
        logger.info("llm.text_succeeded", model=self.model, cost_usd=usage.cost_usd)
        return TextResult(text=text.strip(), usage=usage)

    @staticmethod
    def _parse(text: str, schema: type[T]) -> T:
        parsed = _loads(text)
        try:
            return schema.model_validate(parsed)
        except ValidationError as exc:
            raise LlmResponseError(
                f"Gemini's reply did not match {schema.__name__}: {exc.error_count()} "
                f"validation error(s). First: {exc.errors()[0] if exc.errors() else 'n/a'}"
            ) from exc


_default_client: GeminiClient | None = None


def get_client() -> GeminiClient:
    """Process-wide client singleton."""
    global _default_client
    if _default_client is None:
        _default_client = GeminiClient()
    return _default_client
