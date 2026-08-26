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
    """Stands in for the LLM client.

    Implements generate_raw rather than generate_structured because that is what
    extraction calls: the reply is repaired before it is validated, and
    validating first would reject exactly the replies the repair exists to save.
    Returning a dict here also lets a test hand back a malformed payload and
    check that it still comes out valid.
    """

    def __init__(self, voice: VoiceProfile | dict):
        self._payload = voice if isinstance(voice, dict) else voice.model_dump(mode="json")
        self.calls = 0

    def generate_raw(self, **kwargs):
        self.calls += 1
        # The caller must ask for the VoiceProfile schema.
        assert kwargs["schema"] is VoiceProfile
        return dict(self._payload), _FakeUsage(), "{}"


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


def test_a_malformed_reply_is_repaired_rather_than_rejected():
    """The failure that made this path unusable against a real model.

    Lists arriving as strings and a capped field overrunning are both replies
    that understood the task, and both used to fail the whole analysis.
    """
    client = _FakeClient({
        "tone": "warm and direct",
        "formality": "semi-professional",          # outside the allowed set
        "sentence_style": "Medium declarative sentences. " * 20,  # over the cap
        "vocabulary": "hands-on, bridge, rigor",   # a string, not a list
        "habits": "quotes the posting; names a hook",
        "avoid": "passive voice",
        "summary": "Write like an earnest graduate student.",
    })
    voice, _usage = extract_voice([("cover_letter", "Sample.")], client=client)

    assert client.calls == 1, "a repairable reply must not cost a retry"
    assert voice.vocabulary == ["hands-on", "bridge", "rigor"]
    assert voice.habits == ["quotes the posting", "names a hook"]
    assert voice.avoid == ["passive voice"]
    assert voice.formality == "unknown"
    assert len(voice.sentence_style) <= 300
