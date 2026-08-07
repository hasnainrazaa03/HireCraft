"""Deterministic job-posting intelligence — read the JD before you tailor.

A free, LLM-free screen that flags things worth knowing about a posting:

- **Red flags** — culture/comp language that correlates with bad roles.
- **Geo mismatch** — a "remote" posting whose body actually demands onsite/hybrid.
- **Injection** — text inside the JD aimed at manipulating an AI screener
  (prompt-injection); the JD is untrusted data, never instructions.
- **Thin** — too little text to tailor against (e.g. a JS-heavy board we could
  barely read), so the user knows the score/keywords are unreliable.

Inspired by career-ops's evaluation gates; original code and word lists.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# (phrase, human-readable label). Phrase matched case-insensitively, word-bounded.
_RED_FLAGS: tuple[tuple[str, str], ...] = (
    ("unpaid", "Unpaid position"),
    ("for exposure", "Offers 'exposure' instead of pay"),
    ("no compensation", "States no compensation"),
    ("equity only", "Equity-only pay"),
    ("equity-only", "Equity-only pay"),
    ("commission only", "Commission-only pay"),
    ("commission-only", "Commission-only pay"),
    ("unlimited pto", "'Unlimited PTO' (often means less)"),
    ("unlimited vacation", "'Unlimited vacation' (often means less)"),
    ("rockstar", "'Rockstar/ninja' culture language"),
    ("ninja", "'Rockstar/ninja' culture language"),
    ("wear many hats", "'Wear many hats' (scope creep)"),
    ("wear multiple hats", "'Wear many hats' (scope creep)"),
    ("we're a family", "'We're a family' framing"),
    ("we are a family", "'We're a family' framing"),
    ("like a family", "'We're a family' framing"),
    ("work hard, play hard", "'Work hard, play hard'"),
    ("work hard play hard", "'Work hard, play hard'"),
    ("thrive under pressure", "Expects thriving 'under pressure'"),
    ("work under pressure", "Expects working 'under pressure'"),
    ("whatever it takes", "'Whatever it takes' (long hours)"),
    ("hit the ground running", "Little onboarding ('hit the ground running')"),
    ("fast-paced environment", "'Fast-paced' (often understaffed)"),
    ("must be available 24/7", "On-call 24/7 expectation"),
)

# JD body language that binds you to an office, despite a "remote" label.
_ONSITE_MARKERS: tuple[str, ...] = (
    "on-site", "on site", "onsite", "in-office", "in office", "in the office",
    "hybrid", "days per week in", "days a week in", "days in office",
    "days in the office", "relocation required", "must relocate",
    "report to the office",
)

# Text aimed at an AI reviewer — a posting should never contain these.
_INJECTION_MARKERS: tuple[str, ...] = (
    "ignore previous", "ignore all previous", "ignore the above",
    "disregard the above", "disregard previous", "as an ai", "as a language model",
    "you are now", "new instructions", "system prompt", "forget your instructions",
    "do not reject", "hire this candidate", "give this candidate", "rate this candidate",
    "score this applicant", "recommend this applicant", "this candidate is a perfect",
)

_THIN_WORDS = 60  # below this the JD is too sparse to tailor/score reliably


@dataclass
class JobSignals:
    red_flags: list[str] = field(default_factory=list)
    geo_mismatch: str | None = None
    injection: list[str] = field(default_factory=list)
    thin: bool = False
    word_count: int = 0

    @property
    def any(self) -> bool:
        return bool(self.red_flags or self.geo_mismatch or self.injection or self.thin)


def _has(body: str, phrase: str) -> bool:
    return re.search(r"(?<![a-z0-9])" + re.escape(phrase) + r"(?![a-z0-9])", body) is not None


def _negated(body: str, phrase: str) -> bool:
    """True if the phrase is preceded by a negation ('no onsite requirement')."""
    idx = body.find(phrase)
    if idx == -1:
        return False
    window = body[max(0, idx - 14):idx]
    return any(neg in window for neg in (" no ", " not ", "without ", "n't "))


def analyze_job(title: str | None, location: str | None, raw_text: str | None) -> JobSignals:
    """Screen a posting from its stored fields. Deterministic; no LLM."""
    text = raw_text or ""
    body = (f"{title or ''} {text}").lower()
    words = len(text.split())

    seen: set[str] = set()
    red_flags: list[str] = []
    for phrase, label in _RED_FLAGS:
        if label not in seen and _has(body, phrase):
            red_flags.append(label)
            seen.add(label)

    geo = None
    if "remote" in (location or "").lower():
        for mk in _ONSITE_MARKERS:
            if mk in body and not _negated(body, mk):
                geo = mk
                break

    injection = [m for m in _INJECTION_MARKERS if m in body]

    return JobSignals(
        red_flags=red_flags,
        geo_mismatch=geo,
        injection=injection,
        thin=0 < words < _THIN_WORDS,
        word_count=words,
    )
