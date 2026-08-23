"""Structure extracted résumé text into a validated Master Resume.

Unlike tailoring, this is *import*: the goal is to faithfully transcribe what the
résumé already says into our schema — not to change it. So the prompt's whole
job is fidelity: copy every fact exactly, invent nothing, and leave unknown
fields empty. The result is validated against MasterResume before it is
returned, and light repairs (date normalization) are applied first.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from pydantic import ValidationError

from app.core.logging import get_logger
from app.schemas.resume import MasterResume
from app.services.llm.client import Usage, get_client

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from app.services.llm.factory import LlmClient

logger = get_logger(__name__)

STRUCTURE_SYSTEM = """\
You are a précis parser that transcribes a résumé into structured JSON. Your only \
job is fidelity.

Rules:
- Copy every fact EXACTLY as written — names, employers, titles, schools, degrees, \
dates, bullet points, skills. Do not reword, summarize, embellish, or infer.
- Invent NOTHING. If a field isn't in the résumé, leave it empty/null. Never guess \
an email, phone, or date that isn't present.
- Dates must be "YYYY", "YYYY-MM", or "Present". Convert "May 2024" to "2024-05", \
"2024" stays "2024", "current"/"now" becomes "Present". If a date is unreadable, \
omit it rather than guess.
- NEVER write a `summary` or `headline` the résumé does not already contain. If \
there is no summary/objective/profile section, leave both null — do not compose one \
from the rest of the résumé. An invented summary silently rewrites the candidate's \
document and pushes real content off the page.
- Preserve bullet points verbatim as separate highlight entries.
- Group skills the way the résumé groups them; if ungrouped, use one "Skills" group.
- Put work experience in `experience`, personal/side projects in `projects`, and \
schooling in `education`. Internships, part-time jobs, and teaching/research/course \
assistant roles are work experience — list each as its own `experience` entry, never \
merged. Only degrees and schools go in `education`.

Return JSON matching the provided schema.
"""

# A date that slipped through as "May 2024", "Jan 2023", etc. Best-effort repair.
_MONTHS = {
    "jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06",
    "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12",
}
_MONTH_YEAR = re.compile(r"^([A-Za-z]{3,9})\.?\s+(\d{4})$")


def _repair_date(value: object) -> object:
    if not isinstance(value, str):
        return value
    v = value.strip()
    if v.lower() in ("present", "current", "now", "ongoing"):
        return "Present"
    if match := _MONTH_YEAR.match(v):
        month = _MONTHS.get(match.group(1)[:3].lower())
        if month:
            return f"{match.group(2)}-{month}"
    return v


def _repair_url(value: object) -> object:
    """Make a scheme-less URL absolute; blank out anything that clearly isn't one.

    Résumés often list links as 'github.com/jane', which HttpUrl rejects. Adding
    a scheme fixes the common case; a value with no dot is dropped rather than
    forced into a bogus URL.
    """
    if not isinstance(value, str):
        return value
    v = value.strip()
    if not v:
        return None
    if "://" in v:
        return v
    if "." not in v or " " in v:
        return None  # not a URL — don't fabricate a scheme onto it
    return f"https://{v}"


def _repair(payload: dict) -> dict:
    """Best-effort repairs so a faithfully-parsed résumé passes strict
    validation: normalize dates, absolutize scheme-less URLs, and pin the
    schema version constant."""
    payload["schema_version"] = "1.0"

    # section_order and entry ids are server-owned, not résumé facts. Now that the
    # Gemini schema requires every array (so no section is dropped), the model
    # also emits these — discard them: import always uses the default section
    # order, and every entry id is recomputed as a stable hash so the guardrail
    # index can never be poisoned by a model-invented id.
    payload.pop("section_order", None)
    for section in ("experience", "education", "projects"):
        for entry in payload.get(section) or []:
            if isinstance(entry, dict):
                entry.pop("id", None)

    basics = payload.get("basics")
    if isinstance(basics, dict):
        for key in ("website", "linkedin", "github"):
            if key in basics:
                basics[key] = _repair_url(basics[key])
        for link in basics.get("links") or []:
            if isinstance(link, dict) and "url" in link:
                link["url"] = _repair_url(link["url"])
        # A link whose url we had to drop can't validate; remove it.
        if isinstance(basics.get("links"), list):
            basics["links"] = [
                link for link in basics["links"]
                if isinstance(link, dict) and link.get("url")
            ]

    for section in ("experience", "education", "projects"):
        for entry in payload.get(section) or []:
            if not isinstance(entry, dict):
                continue
            for key in ("start_date", "end_date"):
                if key in entry:
                    entry[key] = _repair_date(entry[key])
            if "url" in entry:
                entry["url"] = _repair_url(entry["url"])
    return payload


# Kept for the existing tests; the endpoint now calls _repair.
def _repair_dates(payload: dict) -> dict:
    for section in ("experience", "education", "projects"):
        for entry in payload.get(section) or []:
            if isinstance(entry, dict):
                for key in ("start_date", "end_date"):
                    if key in entry:
                        entry[key] = _repair_date(entry[key])
    return payload


class ParsingError(Exception):
    """Raised when text can't be structured into a valid résumé."""


# Optional string fields on an entry that can simply be nulled when invalid.
_NULLABLE_ENTRY_FIELDS = {
    "start_date", "end_date", "location", "gpa", "field_of_study", "url",
    "description", "phone", "website", "linkedin", "github", "headline", "summary",
}


def _coerce_valid(payload: dict) -> MasterResume:
    """Validate, salvaging what we can rather than rejecting the whole import.

    Résumé parsing is best-effort: if one field or entry won't fit the schema,
    drop just that piece and try again, so the user gets a mostly-complete draft
    to finish in the builder instead of nothing. Bounded so it always terminates.
    """
    for _ in range(12):
        try:
            return MasterResume.model_validate(payload)
        except ValidationError as exc:
            if not _drop_offending(payload, exc):
                logger.warning("parsing.unsalvageable", errors=exc.error_count())
                raise ParsingError(
                    "We read your résumé but couldn't fit it into the schema. "
                    "Use the builder to finish it."
                ) from exc
    raise ParsingError("We couldn't fully structure that résumé. Use the builder.")


def _drop_offending(payload: dict, exc: ValidationError) -> bool:
    """Remove the fields/entries the validator complained about. Returns True if
    it changed anything (so the caller should retry).

    Entry deletions are collected first and applied in descending index order.
    Popping as each error is handled would shift every later index by one, so
    the next error's index would point at - and silently delete - a different,
    perfectly valid entry further down the résumé.
    """
    changed = False
    doomed: dict[str, set[int]] = {}

    def condemn(section: object, index: int) -> None:
        doomed.setdefault(str(section), set()).add(index)

    for error in exc.errors():
        loc = error["loc"]
        if not loc:
            continue
        # ("experience", 0, "start_date")  -> null the field, or drop the entry.
        if len(loc) >= 3 and isinstance(loc[1], int):
            section, idx, field = loc[0], loc[1], loc[2]
            entries = payload.get(section)
            if not isinstance(entries, list) or not 0 <= idx < len(entries):
                continue
            entry = entries[idx]
            if isinstance(entry, dict) and field in _NULLABLE_ENTRY_FIELDS:
                if field in entry:
                    del entry[field]
                    changed = True
            else:
                condemn(section, idx)  # required field bad -> drop whole entry
        # ("experience", 0) -> whole entry is malformed.
        elif len(loc) == 2 and isinstance(loc[1], int):
            entries = payload.get(loc[0])
            if isinstance(entries, list) and 0 <= loc[1] < len(entries):
                condemn(loc[0], loc[1])
        # ("basics", "github") -> null an optional basics field.
        elif len(loc) == 2 and loc[0] == "basics":
            basics = payload.get("basics")
            if (
                isinstance(basics, dict)
                and loc[1] in _NULLABLE_ENTRY_FIELDS
                and loc[1] in basics
            ):
                del basics[loc[1]]
                changed = True

    for section, indices in doomed.items():
        entries = payload.get(section)
        if not isinstance(entries, list):
            continue
        for idx in sorted(indices, reverse=True):
            del entries[idx]
            changed = True
    return changed


# Headings that introduce a summary/objective block on a real résumé.
_INTRO_HEADING = re.compile(
    r"^\s*(professional\s+)?(summary|profile|objective|about(\s+me)?|overview)\s*:?\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def _drop_invented_intro(resume: MasterResume, source_text: str) -> None:
    """Clear a summary/headline the source résumé never had.

    The prompt forbids inventing one, but models compose a summary from the rest
    of the résumé anyway — and that block is expensive: a ~700-character summary
    is roughly nine rendered lines, enough to push a one-page résumé onto a
    second page, where the one-page fitter then trims the candidate's REAL
    bullets to make room for text the app made up. Checking the source is a
    mechanical guarantee where the instruction wasn't.
    """
    if _INTRO_HEADING.search(source_text or ""):
        return  # the résumé really does have one; keep what was transcribed
    dropped = []
    if resume.basics.summary:
        dropped.append("summary")
        resume.basics.summary = None
    if resume.basics.headline:
        dropped.append("headline")
        resume.basics.headline = None
    if dropped:
        logger.info("parsing.dropped_invented_intro", fields=",".join(dropped))


def structure_resume(
    text: str, *, client: LlmClient | None = None
) -> tuple[MasterResume, Usage]:
    """Turn extracted résumé text into a validated MasterResume plus usage."""
    client = client or get_client()
    # generate_raw, not generate_structured: the model may return dates like
    # "May 2024" that MasterResume rejects, so we repair the raw dict before
    # validating rather than letting strict validation fail the whole import.
    payload, usage, _ = client.generate_raw(
        prompt=(
            "Transcribe this résumé into the structured schema. Copy facts exactly; "
            "invent nothing.\n\n--- RÉSUMÉ TEXT ---\n" + text
        ),
        schema=MasterResume,
        system_instruction=STRUCTURE_SYSTEM,
        temperature=0.0,
    )

    payload = _repair(payload)
    resume = _coerce_valid(payload)
    _drop_invented_intro(resume, text)

    logger.info(
        "parsing.structured",
        experience=len(resume.experience),
        education=len(resume.education),
        cost_usd=usage.cost_usd,
    )
    return resume, usage
