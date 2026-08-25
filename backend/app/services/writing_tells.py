"""Detect the phrases that make writing read as machine-generated.

The cover-letter prompt asks the model to avoid these. Asking is not enforcing:
the instruction competes with everything else in the prompt, and the tells are
exactly the phrasings the model reaches for under pressure. So the output is
checked, and what the check finds is reported rather than silently rewritten —
substituting words in a letter whose facts have already been vetted risks
changing a claim to fix a style problem.

The list is deliberately narrow. "Excited" is not banned English; "I am excited
to apply for" is a specific construction that appears in a large share of
generated letters and almost never in good ones. Flagging ordinary words would
train the reader to ignore the flag.
"""

from __future__ import annotations

import re

#: (pattern, what to write instead) — the suggestion matters as much as the
#: flag, because a writer told only what not to do writes around it badly.
_TELLS: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), advice)
    for pattern, advice in (
        (r"\bI am (?:writing|reaching out) to\b", "open on the work, not on the act of writing"),
        (r"\bI am (?:excited|thrilled|eager|delighted) to\b", "say what draws you to the work"),
        (r"\bpassionate about\b", "name what you have actually built in that area"),
        (r"\b(?:deeply )?resonates? with\b", "say plainly why it matters to you"),
        (r"\bleverag(?:e|ed|ing)\b", "use the plain verb — used, built, ran"),
        (r"\butilis?(?:e|ed|ing)\b", "\"use\""),
        (r"\bspearhead(?:ed|ing)?\b", "\"led\" or \"started\""),
        (r"\bdelv(?:e|ed|ing) into\b", "\"looked at\" or \"worked on\""),
        (r"\b(?:robust|seamless|cutting[- ]edge|state[- ]of[- ]the[- ]art|best[- ]in[- ]class|game[- ]chang\w+)\b",
         "describe the specific property instead"),
        (r"\bas a seasoned\b", "state the experience directly"),
        (r"\bproven track record\b", "give the record"),
        (r"\bunique blend of\b", "name the two things"),
        (r"\bin today'?s (?:fast[- ]paced|rapidly[- ]changing|ever[- ]evolving)\b", "cut the preamble"),
        (r"\bever[- ]evolving landscape\b", "cut it"),
        (r"\bnot just\b[^.]{0,60}\bbut\b", "make the point once"),
        (r"^(?:Furthermore|Moreover|Additionally)\b", "start the sentence with its subject"),
        (r"\bI believe (?:that )?my\b", "state it rather than believing it"),
        (r"\bmakes? me an ideal (?:candidate|fit)\b", "let the evidence do that"),
        (r"\btapestry\b", "no"),
        (r"\bat the intersection of\b", "say which two things and why"),
    )
)


def find_tells(text: str) -> list[dict[str, str]]:
    """Every machine-writing tell in ``text``, with a suggested repair."""
    found: list[dict[str, str]] = []
    for pattern, advice in _TELLS:
        for match in pattern.finditer(text or ""):
            found.append({"phrase": match.group(0), "instead": advice})
    return found


def tell_count(paragraphs: list[str]) -> int:
    """How many tells appear across a drafted letter."""
    return len(find_tells("\n\n".join(paragraphs or [])))


def uniformity(text: str) -> float:
    """How evenly sized the sentences are, from 0 (varied) to 1 (metronomic).

    The most reliable signal after vocabulary, and the one writers never notice.
    Generated prose settles into sentences of near-identical length; human prose
    swings between a long developing sentence and a short flat one. Returns 0
    when there is too little text to judge, so a two-sentence paragraph is never
    accused of monotony.
    """
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", (text or "").strip()) if len(s.split()) > 2]
    if len(sentences) < 4:
        return 0.0
    lengths = [len(s.split()) for s in sentences]
    mean = sum(lengths) / len(lengths)
    if mean <= 0:
        return 0.0
    spread = (sum((n - mean) ** 2 for n in lengths) / len(lengths)) ** 0.5
    # Coefficient of variation around 0.5 is normal human prose; near 0 is a
    # metronome. Inverted and clamped so higher always means worse.
    return max(0.0, min(1.0, 1.0 - (spread / mean) / 0.5))
