"""House-style enforcement for generated résumé and cover-letter text.

Two jobs, both deterministic and free:

1. **Anti-cliché.** Recruiters and ATS both discount tired filler ("passionate",
   "results-driven", "cutting-edge"). We detect it (to surface as a fixable
   suggestion) and instruct every generator to avoid it up front.
2. **Output hygiene.** Strip model self-talk that occasionally leaks into free
   text ("Here is the revised letter:", "As requested, …") so it never reaches
   the user. (Typography — smart quotes, em dashes — is already normalised by the
   LaTeX escaper, so it is intentionally NOT re-handled here.)

The lists and code are original to HireCraft; the *idea* of a house-style
blocklist is a common pattern across résumé tooling.
"""

from __future__ import annotations

import re

# Tired résumé/cover-letter filler. Phrase-level and conservative, so genuine
# content is never caught. Ordered roughly by how often each shows up.
CLICHES: tuple[str, ...] = (
    "passionate", "passion for", "results-driven", "results driven",
    "results-oriented", "results oriented", "detail-oriented", "detail oriented",
    "team player", "hard-working", "hard worker", "self-starter", "self starter",
    "go-getter", "go getter", "proven track record", "track record of success",
    "think outside the box", "outside the box", "hit the ground running",
    "wear many hats", "best-in-class", "best in class", "world-class",
    "world class", "cutting-edge", "cutting edge", "state-of-the-art",
    "state of the art", "bleeding edge", "synergy", "synergies", "synergize",
    "value-add", "move the needle", "low-hanging fruit", "seasoned professional",
    "dynamic professional", "highly motivated", "proactive", "go-to person",
    "rockstar", "ninja", "guru", "excellent communication skills",
    "strong communication skills", "excellent communicator", "fast learner",
    "quick learner", "growth mindset", "thought leader", "thought leadership",
    "game-changer", "game changer", "next-level",
)

# Cover-letter-specific filler openers/transitions on top of the résumé list.
COVER_LETTER_CLICHES: tuple[str, ...] = (
    "i am writing to", "please find attached", "to whom it may concern",
    "i believe i would be a great fit", "i am the perfect candidate",
    "i am confident that i", "as you can see from my resume", "furthermore",
    "moreover", "in conclusion", "i hope this email finds you well",
)

# Model self-talk that must never survive into user-facing output.
LLM_LEAK_PHRASES: tuple[str, ...] = (
    "here is the", "here's the", "here is your", "here's your", "here is a",
    "below is the", "below is your", "i have rewritten", "i have updated",
    "i have revised", "i have removed", "i've rewritten", "i've updated",
    "i've revised", "as requested", "as per your", "per your feedback",
    "based on your feedback", "i apologize", "i'm sorry", "let me know if",
    "hope this helps", "sure! here", "certainly! here", "note:", "disclaimer:",
)

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9+#.\-]*")


def _contains(haystack_lower: str, phrase: str) -> bool:
    """Word-boundary-ish membership so a single token can't match inside a
    longer word ("passion" must not fire on "compassionate")."""
    return re.search(r"(?<![a-z])" + re.escape(phrase) + r"(?![a-z])", haystack_lower) is not None


def cliches_in(text: str, *, cover_letter: bool = False) -> list[str]:
    """Distinct clichés present in ``text``, in list order (deduped)."""
    low = text.lower()
    pool = CLICHES + (COVER_LETTER_CLICHES if cover_letter else ())
    out: list[str] = []
    for c in pool:
        if c not in out and _contains(low, c):
            out.append(c)
    return out


def leaks_in(text: str) -> list[str]:
    """Model self-talk phrases present in ``text``."""
    low = text.lower()
    return [p for p in LLM_LEAK_PHRASES if p in low]


def strip_leak_lines(paragraphs: list[str]) -> list[str]:
    """Drop whole paragraphs that are obvious model self-talk.

    Conservative: only removes a paragraph whose opening clause is a known leak
    phrase (e.g. "Here is the revised cover letter:"), never mid-content text.
    """
    kept: list[str] = []
    for p in paragraphs:
        head = p.strip().lower()[:40]
        if any(head.startswith(phrase) for phrase in LLM_LEAK_PHRASES):
            continue
        kept.append(p)
    return kept


def repeated_opening_verbs(bullets: list[str]) -> dict[str, int]:
    """Opening word (lowercased) → count, for openers used more than once.

    A strong résumé leads each bullet with a *different* verb; reuse is a
    weakness the scorer penalises and the generator is told to avoid.
    """
    counts: dict[str, int] = {}
    for b in bullets:
        m = _WORD_RE.search(b)
        if m:
            w = m.group().lower()
            counts[w] = counts.get(w, 0) + 1
    return {w: n for w, n in counts.items() if n > 1}


def house_style_block(*, cover_letter: bool = False) -> str:
    """A prompt fragment the generators splice in so clichés never get written
    in the first place, plus the 6-point bullet aim and metric variety."""
    # Cap the résumé list for token economy, but always show the cover-letter
    # additions in full when they apply.
    pool = (CLICHES[:32] + COVER_LETTER_CLICHES) if cover_letter else CLICHES[:44]
    banned = ", ".join(f'"{p}"' for p in pool)
    craft = (
        "- Build each sentence toward as many of these as the REAL facts support "
        "(never invent to complete one): a strong action verb → what/where "
        "(context) → how (method) → a real result → its impact → the outcome.\n"
        if cover_letter
        else (
            "- Build each bullet toward as many of these as the REAL facts support "
            "(never invent to complete one): action verb → what/where (context) → "
            "how (method) → a real result → its impact → the business outcome.\n"
            "- Lead every bullet with a DIFFERENT verb; never reuse the same opener.\n"
            "- Vary the KIND of metric you surface (time saved, volume, frequency, "
            "scope, quality) — don't repeat one format across bullets.\n"
        )
    )
    return (
        "\n=== HOUSE STYLE (a checker enforces this) ===\n"
        "- BANNED PHRASES — do not use any of these tired fillers, even once:\n"
        f"  {banned}.\n"
        f"{craft}"
        "- Write plain, direct, specific prose. No buzzwords, no filler transitions, "
        "no self-referential preamble like \"Here is\".\n"
    )
