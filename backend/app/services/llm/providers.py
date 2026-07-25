"""Anthropic (Claude) and OpenAI clients.

Both mirror ``GeminiClient``'s surface — ``generate_structured`` /
``generate_raw`` / ``generate_text`` returning the same LlmResult / TextResult /
Usage types and raising the same LlmError hierarchy — so every service and route
can treat any provider identically. Structured output uses each provider's native
mechanism: a forced tool call for Claude, JSON mode for OpenAI.

The SDKs are imported lazily so the app still boots (and unrelated tests run)
without them installed; a provider is only ever constructed when it's selected.
"""

from __future__ import annotations

import json
import time
from typing import Any

from pydantic import BaseModel, ValidationError

from app.core.config import settings
from app.core.logging import get_logger
from app.services.llm.client import (
    LlmConfigurationError,
    LlmResponseError,
    LlmResult,
    TextResult,
    Usage,
    _classify,
    _loads,
)

logger = get_logger(__name__)


def _parse[T: BaseModel](text: str, schema: type[T]) -> T:
    try:
        return schema.model_validate(_loads(text))
    except ValidationError as exc:
        raise LlmResponseError(
            f"Reply did not match {schema.__name__}: {exc.error_count()} error(s)."
        ) from exc


class AnthropicClient:
    """Claude via the official anthropic SDK. Structured output = forced tool use."""

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or settings.anthropic_api_key
        self.model = model or settings.anthropic_model
        self._client: Any = None

    def _ensure(self) -> Any:
        if not self.api_key:
            raise LlmConfigurationError("No Anthropic API key configured.")
        if self._client is None:
            try:
                import anthropic
            except ImportError as exc:  # pragma: no cover
                raise LlmConfigurationError("The anthropic package is not installed.") from exc
            self._client = anthropic.Anthropic(api_key=self.api_key)
        return self._client

    def _base_kwargs(self, system_instruction: str | None, temperature: float | None,
                     max_output_tokens: int | None) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": max_output_tokens or settings.llm_max_output_tokens,
            "temperature": temperature if temperature is not None else settings.llm_temperature,
        }
        if system_instruction:
            kwargs["system"] = system_instruction
        return kwargs

    def generate_text(self, *, prompt: str, system_instruction: str | None = None,
                      temperature: float | None = None, max_output_tokens: int | None = None) -> TextResult:
        client = self._ensure()
        started = time.perf_counter()
        try:
            resp = client.messages.create(
                messages=[{"role": "user", "content": prompt}],
                **self._base_kwargs(system_instruction, temperature, max_output_tokens),
            )
        except Exception as exc:  # noqa: BLE001
            raise _classify(exc) from exc
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        return TextResult(text=text.strip(), usage=self._usage(resp, started))

    def generate_structured[T: BaseModel](self, *, prompt: str, schema: type[T], system_instruction: str | None = None,
                            temperature: float | None = None, max_output_tokens: int | None = None) -> LlmResult[T]:
        client = self._ensure()
        tool = {
            "name": "emit_result",
            "description": "Return the answer as structured data matching the schema.",
            "input_schema": schema.model_json_schema(),
        }
        started = time.perf_counter()
        try:
            resp = client.messages.create(
                messages=[{"role": "user", "content": prompt}],
                tools=[tool],
                tool_choice={"type": "tool", "name": "emit_result"},
                **self._base_kwargs(system_instruction, temperature, max_output_tokens),
            )
        except Exception as exc:  # noqa: BLE001
            raise _classify(exc) from exc
        block = next((b for b in resp.content if getattr(b, "type", None) == "tool_use"), None)
        if block is None:
            raise LlmResponseError("Claude did not return the structured result.")
        try:
            data = schema.model_validate(block.input)
        except ValidationError as exc:
            raise LlmResponseError(f"Claude's reply did not match {schema.__name__}.") from exc
        return LlmResult(data=data, usage=self._usage(resp, started), raw_text=json.dumps(block.input))

    def generate_raw(self, *, prompt: str, schema: type[BaseModel], system_instruction: str | None = None,
                     temperature: float | None = None, max_output_tokens: int | None = None) -> tuple[dict[str, Any], Usage, str]:
        result = self.generate_structured(
            prompt=prompt, schema=schema, system_instruction=system_instruction,
            temperature=temperature, max_output_tokens=max_output_tokens,
        )
        payload = json.loads(result.raw_text)
        return payload, result.usage, result.raw_text

    def _usage(self, resp: Any, started: float) -> Usage:
        meta = getattr(resp, "usage", None)
        return Usage(
            input_tokens=getattr(meta, "input_tokens", 0) or 0,
            output_tokens=getattr(meta, "output_tokens", 0) or 0,
            model=self.model,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )


class OpenAIClient:
    """OpenAI via the official SDK. Structured output = JSON mode + schema-in-prompt."""

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or settings.openai_api_key
        self.model = model or settings.openai_model
        self._client: Any = None

    def _ensure(self) -> Any:
        if not self.api_key:
            raise LlmConfigurationError("No OpenAI API key configured.")
        if self._client is None:
            try:
                import openai
            except ImportError as exc:  # pragma: no cover
                raise LlmConfigurationError("The openai package is not installed.") from exc
            self._client = openai.OpenAI(api_key=self.api_key)
        return self._client

    def _is_reasoning(self) -> bool:
        # o-series reasoning models reject a custom temperature.
        return self.model.startswith("o")

    def _call(self, *, messages: list[dict], max_output_tokens: int | None,
              temperature: float | None, json_mode: bool) -> Any:
        client = self._ensure()
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_completion_tokens": max_output_tokens or settings.llm_max_output_tokens,
        }
        if not self._is_reasoning():
            kwargs["temperature"] = temperature if temperature is not None else settings.llm_temperature
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            return client.chat.completions.create(**kwargs)
        except Exception as exc:  # noqa: BLE001
            raise _classify(exc) from exc

    def _messages(self, prompt: str, system_instruction: str | None) -> list[dict]:
        messages: list[dict] = []
        if system_instruction:
            messages.append({"role": "system", "content": system_instruction})
        messages.append({"role": "user", "content": prompt})
        return messages

    def generate_text(self, *, prompt: str, system_instruction: str | None = None,
                      temperature: float | None = None, max_output_tokens: int | None = None) -> TextResult:
        started = time.perf_counter()
        resp = self._call(
            messages=self._messages(prompt, system_instruction),
            max_output_tokens=max_output_tokens, temperature=temperature, json_mode=False,
        )
        text = (resp.choices[0].message.content or "").strip()
        return TextResult(text=text, usage=self._usage(resp, started))

    def generate_structured[T: BaseModel](self, *, prompt: str, schema: type[T], system_instruction: str | None = None,
                            temperature: float | None = None, max_output_tokens: int | None = None) -> LlmResult[T]:
        schema_hint = (
            "Respond with a single JSON object that matches this JSON Schema exactly, "
            "with no extra prose:\n" + json.dumps(schema.model_json_schema())
        )
        system = f"{system_instruction}\n\n{schema_hint}" if system_instruction else schema_hint
        started = time.perf_counter()
        resp = self._call(
            messages=self._messages(prompt, system),
            max_output_tokens=max_output_tokens, temperature=temperature, json_mode=True,
        )
        text = resp.choices[0].message.content or ""
        data = _parse(text, schema)
        return LlmResult(data=data, usage=self._usage(resp, started), raw_text=text)

    def generate_raw(self, *, prompt: str, schema: type[BaseModel], system_instruction: str | None = None,
                     temperature: float | None = None, max_output_tokens: int | None = None) -> tuple[dict[str, Any], Usage, str]:
        result = self.generate_structured(
            prompt=prompt, schema=schema, system_instruction=system_instruction,
            temperature=temperature, max_output_tokens=max_output_tokens,
        )
        payload = _loads(result.raw_text)
        if not isinstance(payload, dict):
            raise LlmResponseError("Expected a JSON object from OpenAI.")
        return payload, result.usage, result.raw_text

    def _usage(self, resp: Any, started: float) -> Usage:
        meta = getattr(resp, "usage", None)
        return Usage(
            input_tokens=getattr(meta, "prompt_tokens", 0) or 0,
            output_tokens=getattr(meta, "completion_tokens", 0) or 0,
            model=self.model,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
