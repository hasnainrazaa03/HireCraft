"""Voice-extraction tests. The LLM call is mocked; we verify the prompt
construction and that the service returns the parsed voice plus usage."""

from __future__ import annotations

from dataclasses import dataclass

from app.schemas.writing import VoiceProfile
from app.services.llm.voice import MAX_SAMPLE_CHARS, build_voice_prompt, extract_voice


def test_prompt_includes_each_sample_with_kind():
    prompt = build_voice_prompt([("email", "Hi there"), ("cover_letter", "Dear team")])
    assert "SAMPLE 1 (email)" in prompt
    assert "SAMPLE 2 (cover_letter)" in prompt
    assert "Hi there" in prompt and "Dear team" in prompt


def test_prompt_is_budget_bounded():
    huge = [("email", "x" * 50_000), ("email", "y" * 50_000)]
    prompt = build_voice_prompt(huge)
    # The combined sample text must not exceed the budget (plus small framing).
    assert prompt.count("x") + prompt.count("y") <= MAX_SAMPLE_CHARS + 10


@dataclass
class _FakeUsage:
    input_tokens: int = 100
    output_tokens: int = 50
    model: str = "fake-model"
    latency_ms: int = 10
    cost_usd: float = 0.0001


@dataclass
class _FakeResult:
    data: VoiceProfile
    usage: _FakeUsage
    raw_text: str = "{}"


class _FakeClient:
    def __init__(self, voice: VoiceProfile):
        self._voice = voice
        self.calls = 0

    def generate_structured(self, **kwargs):
        self.calls += 1
        # The caller must ask for the VoiceProfile schema.
        assert kwargs["schema"] is VoiceProfile
        return _FakeResult(data=self._voice, usage=_FakeUsage())


def test_extract_voice_returns_parsed_voice_and_usage():
    voice = VoiceProfile(
        tone="warm and direct",
        formality="conversational",
        summary="Write like a friendly, concise engineer.",
    )
    client = _FakeClient(voice)
    result, usage = extract_voice([("email", "Sample text here.")], client=client)  # type: ignore[arg-type]
    assert client.calls == 1
    assert result.tone == "warm and direct"
    assert result.formality == "conversational"
    assert usage.cost_usd == 0.0001
