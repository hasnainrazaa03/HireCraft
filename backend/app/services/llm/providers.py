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


# Models that have deprecated a custom ``temperature`` and reject the parameter
# (e.g. claude-sonnet-5). Discovered at call time and cached, so the whole newer
# Claude family is handled without a brittle hardcoded list.
_ANTHROPIC_NO_TEMPERATURE: set[str] = set()


def _temperature_rejected(exc: Exception) -> bool:
    """Is this the model (or SDK) refusing the temperature parameter?

    Two shapes, and only the first was handled originally.

    The API can reject it in the response — "temperature is deprecated for this
    model". But a newer SDK drops the parameter from the method signature
    altogether, and then it never reaches the API at all: Python raises
    ``TypeError: Messages.create() got an unexpected keyword argument
    'temperature'`` before the request is made. That form was not recognised, so
    the retry never fired and every structured call failed — which took résumé
    import down completely on Claude Sonnet 5.
    """
    msg = str(exc).lower()
    if "temperature" not in msg:
        return False
    return (
        "deprecat" in msg
        or "unsupported" in msg
        or "not support" in msg
        or "unexpected keyword argument" in msg
    )


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
        }
        # Omit temperature for any model we've learned rejects it (see _create).
        if self.model not in _ANTHROPIC_NO_TEMPERATURE:
            kwargs["temperature"] = temperature if temperature is not None else settings.llm_temperature
        if system_instruction:
            kwargs["system"] = system_instruction
        return kwargs

    def _create(self, *, system_instruction: str | None, temperature: float | None,
                max_output_tokens: int | None, **extra: Any) -> Any:
        """``messages.create`` with a one-time retry that drops ``temperature`` for
        a model that has deprecated it, then remembers so later calls skip it."""
        client = self._ensure()
        kwargs = self._base_kwargs(system_instruction, temperature, max_output_tokens)
        try:
            return client.messages.create(**kwargs, **extra)
        except Exception as exc:  # noqa: BLE001
            if "temperature" in kwargs and _temperature_rejected(exc):
                _ANTHROPIC_NO_TEMPERATURE.add(self.model)
                kwargs.pop("temperature", None)
                try:
                    return client.messages.create(**kwargs, **extra)
                except Exception as exc2:  # noqa: BLE001
                    raise _classify(exc2) from exc2
            raise _classify(exc) from exc

    def generate_text(self, *, prompt: str, system_instruction: str | None = None,
                      temperature: float | None = None, max_output_tokens: int | None = None) -> TextResult:
        started = time.perf_counter()
        resp = self._create(
            system_instruction=system_instruction, temperature=temperature,
            max_output_tokens=max_output_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        return TextResult(text=text.strip(), usage=self._usage(resp, started))

    def stream_text(self, *, prompt: str, system_instruction: str | None = None,
                    temperature: float | None = None, max_output_tokens: int | None = None):
        """Yield the reply as it is generated, then a final Usage.

        Chat answers are long enough that waiting for the whole response feels
        broken; streaming shows the first words in well under a second. Yields
        ``(text_chunk, None)`` repeatedly and finally ``(None, Usage)``.
        """
        client = self._ensure()
        kwargs = self._base_kwargs(system_instruction, temperature, max_output_tokens)
        started = time.perf_counter()
        try:
            with client.messages.stream(
                messages=[{"role": "user", "content": prompt}], **kwargs
            ) as stream:
                for chunk in stream.text_stream:
                    if chunk:
                        yield chunk, None
                final = stream.get_final_message()
        except Exception as exc:  # noqa: BLE001
            if "temperature" in kwargs and _temperature_rejected(exc):
                _ANTHROPIC_NO_TEMPERATURE.add(self.model)
                kwargs.pop("temperature", None)
                with client.messages.stream(
                    messages=[{"role": "user", "content": prompt}], **kwargs
                ) as stream:
                    for chunk in stream.text_stream:
                        if chunk:
                            yield chunk, None
                    final = stream.get_final_message()
            else:
                raise _classify(exc) from exc
        yield None, self._usage(final, started)

    def _tool_call(self, *, prompt: str, schema: type[BaseModel], system_instruction: str | None,
                   temperature: float | None, max_output_tokens: int | None) -> tuple[Any, Usage]:
        """Force the structured tool call and return its raw, UNVALIDATED input."""
        tool = {
            "name": "emit_result",
            "description": "Return the answer as structured data matching the schema.",
            "input_schema": schema.model_json_schema(),
        }
        started = time.perf_counter()
        resp = self._create(
            system_instruction=system_instruction, temperature=temperature,
            max_output_tokens=max_output_tokens,
            messages=[{"role": "user", "content": prompt}],
            tools=[tool],
            tool_choice={"type": "tool", "name": "emit_result"},
        )
        block = next((b for b in resp.content if getattr(b, "type", None) == "tool_use"), None)
        if block is None:
            raise LlmResponseError("Claude did not return the structured result.")
        return block.input, self._usage(resp, started)

    def generate_structured[T: BaseModel](self, *, prompt: str, schema: type[T], system_instruction: str | None = None,
                            temperature: float | None = None, max_output_tokens: int | None = None) -> LlmResult[T]:
        payload, usage = self._tool_call(
            prompt=prompt, schema=schema, system_instruction=system_instruction,
            temperature=temperature, max_output_tokens=max_output_tokens,
        )
        try:
            data = schema.model_validate(payload)
        except ValidationError as exc:
            raise LlmResponseError(f"Claude's reply did not match {schema.__name__}.") from exc
        return LlmResult(data=data, usage=usage, raw_text=json.dumps(payload))

    def generate_raw(self, *, prompt: str, schema: type[BaseModel], system_instruction: str | None = None,
                     temperature: float | None = None, max_output_tokens: int | None = None) -> tuple[dict[str, Any], Usage, str]:
        # Deliberately does NOT validate against ``schema`` - callers use this
        # precisely because the reply needs repairing first (a résumé import
        # whose dates arrive as "May 2024"). Routing it through
        # generate_structured would validate and reject exactly those replies,
        # defeating the repair step that exists to salvage them.
        payload, usage = self._tool_call(
            prompt=prompt, schema=schema, system_instruction=system_instruction,
            temperature=temperature, max_output_tokens=max_output_tokens,
        )
        if not isinstance(payload, dict):
            raise LlmResponseError("Expected a JSON object from Claude.")
        return payload, usage, json.dumps(payload)

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

    def _json_call(self, *, prompt: str, schema: type[BaseModel], system_instruction: str | None,
                   temperature: float | None, max_output_tokens: int | None) -> tuple[str, Usage]:
        """Run the JSON-mode call and return the raw reply text plus usage."""
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
        return (resp.choices[0].message.content or ""), self._usage(resp, started)

    def generate_structured[T: BaseModel](self, *, prompt: str, schema: type[T], system_instruction: str | None = None,
                            temperature: float | None = None, max_output_tokens: int | None = None) -> LlmResult[T]:
        text, usage = self._json_call(
            prompt=prompt, schema=schema, system_instruction=system_instruction,
            temperature=temperature, max_output_tokens=max_output_tokens,
        )
        return LlmResult(data=_parse(text, schema), usage=usage, raw_text=text)

    def generate_raw(self, *, prompt: str, schema: type[BaseModel], system_instruction: str | None = None,
                     temperature: float | None = None, max_output_tokens: int | None = None) -> tuple[dict[str, Any], Usage, str]:
        # No schema validation here on purpose - see AnthropicClient.generate_raw.
        text, usage = self._json_call(
            prompt=prompt, schema=schema, system_instruction=system_instruction,
            temperature=temperature, max_output_tokens=max_output_tokens,
        )
        payload = _loads(text)
        if not isinstance(payload, dict):
            raise LlmResponseError("Expected a JSON object from OpenAI.")
        return payload, usage, text

    def _usage(self, resp: Any, started: float) -> Usage:
        meta = getattr(resp, "usage", None)
        return Usage(
            input_tokens=getattr(meta, "prompt_tokens", 0) or 0,
            output_tokens=getattr(meta, "completion_tokens", 0) or 0,
            model=self.model,
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
