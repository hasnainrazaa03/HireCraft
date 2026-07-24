"""Structure extracted résumé text into a validated Master Resume.

Unlike tailoring, this is *import*: the goal is to faithfully transcribe what the
résumé already says into our schema — not to change it. So the prompt's whole
job is fidelity: copy every fact exactly, invent nothing, and leave unknown
fields empty. The result is validated against MasterResume before it is
returned, and light repairs (date normalization) are applied first.
"""

from __future__ import annotations

import re

from pydantic import ValidationError

from app.core.logging import get_logger
from app.schemas.resume import MasterResume
from app.services.llm.client import GeminiClient, Usage, get_client

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
    it changed anything (so the caller should retry)."""
    changed = False
    # Handle deepest paths first so list indices stay valid as we delete.
    for error in sorted(exc.errors(), key=lambda e: -len(e["loc"])):
        loc = error["loc"]
        if not loc:
            continue
        # ("experience", 0, "start_date")  -> null the field, or drop the entry.
        if len(loc) >= 3 and isinstance(loc[1], int):
            section, idx, field = loc[0], loc[1], loc[2]
            entries = payload.get(section)
            if isinstance(entries, list) and 0 <= idx < len(entries):
                entry = entries[idx]
                if isinstance(entry, dict) and field in _NULLABLE_ENTRY_FIELDS:
                    entry.pop(field, None)
                    changed = True
                else:
                    entries.pop(idx)  # required field bad -> drop whole entry
                    changed = True
        # ("experience", 0) -> whole entry is malformed.
        elif len(loc) == 2 and isinstance(loc[1], int):
            entries = payload.get(loc[0])
            if isinstance(entries, list) and 0 <= loc[1] < len(entries):
                entries.pop(loc[1])
                changed = True
        # ("basics", "github") -> null an optional basics field.
        elif len(loc) == 2 and loc[0] == "basics":
            basics = payload.get("basics")
            if isinstance(basics, dict) and loc[1] in _NULLABLE_ENTRY_FIELDS:
                basics.pop(loc[1], None)
                changed = True
    return changed


def structure_resume(
    text: str, *, client: GeminiClient | None = None
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

    logger.info(
        "parsing.structured",
        experience=len(resume.experience),
        education=len(resume.education),
        cost_usd=usage.cost_usd,
    )
    return resume, usage
