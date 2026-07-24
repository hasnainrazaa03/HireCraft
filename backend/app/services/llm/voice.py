"""Extract a reusable "voice" from a user's writing samples.

This only *describes* how the user writes — it never stores or reproduces the
sample text as fact. The resulting VoiceProfile is a style guide, fed later into
cover-letter and outreach prompts so the output sounds like the user. Anything
subsequently generated still passes the truthfulness guardrails.
"""

from __future__ import annotations

from app.core.logging import get_logger
from app.schemas.writing import VoiceProfile
from app.services.llm.client import GeminiClient, Usage, get_client

logger = get_logger(__name__)

VOICE_SYSTEM = """\
You are a writing coach analyzing a person's writing samples to capture their \
voice, so another writer could later produce text that sounds authentically like \
them.

Describe only their STYLE — tone, formality, sentence rhythm, favored vocabulary, \
habits, and things they avoid. Do NOT summarize the content, and do NOT invent \
traits you cannot see in the samples. If the samples are thin, keep the profile \
short rather than padding it. The `summary` should read as a direct instruction \
to another writer on how to sound like this person.
"""

MAX_SAMPLE_CHARS = 12_000


def build_voice_prompt(samples: list[tuple[str, str]]) -> str:
    """``samples`` is a list of (kind, content) pairs."""
    blocks: list[str] = []
    budget = MAX_SAMPLE_CHARS
    for i, (kind, content) in enumerate(samples, 1):
        excerpt = content[: min(len(content), budget)]
        budget -= len(excerpt)
        blocks.append(f"--- SAMPLE {i} ({kind}) ---\n{excerpt}")
        if budget <= 0:
            break
    return (
        "Analyze these writing samples and capture the author's voice as JSON "
        "matching the schema.\n\n" + "\n\n".join(blocks)
    )


def extract_voice(
    samples: list[tuple[str, str]],
    *,
    client: GeminiClient | None = None,
) -> tuple[VoiceProfile, Usage]:
    """Return the distilled voice plus token usage for the call."""
    client = client or get_client()
    result = client.generate_structured(
        prompt=build_voice_prompt(samples),
        schema=VoiceProfile,
        system_instruction=VOICE_SYSTEM,
        temperature=0.3,
    )
    logger.info(
        "voice.extracted",
        samples=len(samples),
        cost_usd=result.usage.cost_usd,
    )
    return result.data, result.usage
