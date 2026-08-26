"""Extract a reusable "voice" from a user's writing samples.

This only *describes* how the user writes — it never stores or reproduces the
sample text as fact. The resulting VoiceProfile is a style guide, fed later into
cover-letter and outreach prompts so the output sounds like the user. Anything
subsequently generated still passes the truthfulness guardrails.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import ValidationError

from app.core.logging import get_logger
from app.schemas.writing import VoiceProfile
from app.services.llm.client import LlmResponseError, Usage, get_client

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from app.services.llm.factory import LlmClient

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


#: Fields the schema declares as lists. The model returns them as a list most
#: of the time and as a single string the rest of the time — "concise, direct,
#: specific" instead of ["concise", "direct", "specific"] — inconsistently
#: enough that the same prompt succeeds and fails on consecutive calls.
_LIST_FIELDS = ("vocabulary", "habits", "avoid")

#: Strings the schema caps. The model has no way to count characters, so an
#: otherwise perfect answer gets thrown away for being twenty characters long.
_STRING_CAPS = {"tone": 300, "sentence_style": 300, "summary": 600}

_FORMALITY = {"casual", "conversational", "professional", "formal", "unknown"}


def _repair(payload: dict) -> dict:
    """Make a nearly-right reply valid, rather than discarding it.

    The same approach the résumé importer takes: the model understood the task
    and got the shape slightly wrong, and rejecting that outright loses good
    work over punctuation. Nothing here invents content — it only reshapes what
    was returned.
    """
    for field in _LIST_FIELDS:
        value = payload.get(field)
        if isinstance(value, str):
            # Split on the separators a model actually uses for an inline list,
            # keeping commas last so a phrase like "warm, but direct" survives
            # a semicolon- or newline-separated list intact.
            for separator in ("\n", ";", ","):
                if separator in value:
                    payload[field] = [p.strip(" -•\t") for p in value.split(separator) if p.strip(" -•\t")]
                    break
            else:
                payload[field] = [value.strip()] if value.strip() else []
        elif value is None:
            payload[field] = []
        elif isinstance(value, list):
            payload[field] = [str(v).strip() for v in value if str(v).strip()]

    for field, cap in _STRING_CAPS.items():
        value = payload.get(field)
        if isinstance(value, str) and len(value) > cap:
            # Cut at a sentence or clause boundary so the description still
            # reads as written rather than stopping mid-word.
            cut = value[:cap]
            for boundary in (". ", "; ", ", ", " "):
                index = cut.rfind(boundary)
                if index > cap * 0.6:
                    cut = cut[: index + (1 if boundary == ". " else 0)]
                    break
            payload[field] = cut.strip()

    if payload.get("formality") not in _FORMALITY:
        payload["formality"] = "unknown"
    return payload


#: VoiceProfile is a tightly constrained schema — capped lists, a Literal for
#: formality, length limits on every string — and a model asked to fill it will
#: occasionally overrun one of them. A single non-conforming reply used to fail
#: the whole analysis, which the user meets as "couldn't analyse your writing"
#: after uploading a dozen samples. Retrying costs one more call and succeeds
#: almost always, because the failure is a sampling accident rather than a
#: misunderstanding.
_ATTEMPTS = 3


def extract_voice(
    samples: list[tuple[str, str]],
    *,
    client: LlmClient | None = None,
) -> tuple[VoiceProfile, Usage]:
    """Return the distilled voice plus token usage for the call."""
    client = client or get_client()
    prompt = build_voice_prompt(samples)

    last: Exception | None = None
    for attempt in range(1, _ATTEMPTS + 1):
        # generate_raw rather than generate_structured, for the same reason the
        # résumé importer uses it: the reply needs repairing before it is
        # validated, and validating first throws away exactly the replies the
        # repair exists to save.
        try:
            payload, usage, _ = client.generate_raw(
                prompt=prompt,
                schema=VoiceProfile,
                system_instruction=VOICE_SYSTEM,
                # Lower the temperature on each retry: the first pass is allowed
                # some latitude for a livelier description, and a reply that
                # overran the schema is more likely to fit when the model is
                # sampling less adventurously.
                temperature=max(0.0, 0.3 - 0.15 * (attempt - 1)),
            )
            voice = VoiceProfile.model_validate(_repair(payload))
        except (LlmResponseError, ValidationError) as exc:
            last = exc
            logger.info("voice.retrying", attempt=attempt, error=str(exc)[:140])
            continue
        logger.info(
            "voice.extracted", samples=len(samples), attempts=attempt, cost_usd=usage.cost_usd
        )
        return voice, usage

    raise LlmResponseError(f"Could not extract a voice profile: {last}")
