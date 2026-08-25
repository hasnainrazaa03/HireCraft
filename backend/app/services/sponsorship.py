"""Whether a posting will consider someone who needs visa sponsorship.

Deterministic, no LLM. For a candidate on a student visa this is the single most
consequential fact about a posting after the role itself: applying to something
that requires citizenship or an active clearance is time spent on an application
that cannot succeed, and the posting almost always says so plainly.

Two asymmetries shape this module.

Silence is not a "no". Most postings say nothing about sponsorship, and treating
that as a refusal would hide the majority of the market. Unstated is its own
answer and is reported as such.

A blocker outranks an offer. A posting that welcomes sponsorship in its benefits
boilerplate *and* requires a security clearance in its qualifications is closed
to a visa holder, and the clearance is the operative fact. Checks therefore run
hardest-first, and the first match wins.
"""

from __future__ import annotations

import enum
import re


class Sponsorship(str, enum.Enum):
    """What a posting says about sponsoring a work visa."""

    UNSTATED = "unstated"
    #: Explicitly offers or is open to sponsorship.
    SPONSORS = "sponsors"
    #: Explicitly will not sponsor.
    NO_SPONSORSHIP = "no_sponsorship"
    #: Requires citizenship, permanent residency, or export-control eligibility.
    CITIZENSHIP_REQUIRED = "citizenship_required"
    #: Requires an active government security clearance.
    CLEARANCE_REQUIRED = "clearance_required"


#: A clearance can only be held by someone already cleared, which in practice
#: means a citizen with an existing investigation. Checked first because it is
#: the most absolute.
_CLEARANCE = re.compile(
    r"\b(?:"
    r"(?:active|current|existing|must\s+(?:possess|hold|have))[^.\n]{0,40}\bclearance\b"
    r"|\bsecurity\s+clearance\b"
    r"|\bTS\s*/\s*SCI\b"
    r"|\btop\s+secret\b"
    r"|\bsecret\s+clearance\b"
    r"|\bpolygraph\b"
    r"|\bDoD\s+8570\b"
    r")",
    re.IGNORECASE,
)

#: Citizenship, permanent residency, or "US person" status under export control.
#: ITAR and EAR are the common statutory hooks and are decisive on their own.
_CITIZENSHIP = re.compile(
    r"\b(?:"
    r"(?:U\.?\s?S\.?|United\s+States)\s+(?:citizen(?:ship)?|person)s?\s*(?:only|required|is\s+required)?"
    r"|must\s+be\s+a\s+(?:U\.?\s?S\.?|United\s+States)\s+citizen"
    r"|\bITAR\b|\bEAR\b\s+(?:controlled|regulations)|export[- ]control(?:led|s)?\s+(?:laws?|regulations?|requirements?)"
    r"|(?:green\s+card|permanent\s+resident)\s*(?:holder)?s?\s*(?:only|required)"
    r"|lawful\s+permanent\s+resident"
    r")",
    re.IGNORECASE,
)

#: Explicit refusals. Written to match the several ways employers say it while
#: avoiding the far more common inverse ("we will sponsor"), which is why each
#: alternative carries its own negation rather than relying on a nearby "not".
_NO_SPONSORSHIP = re.compile(
    r"(?:"
    r"(?:will\s+not|won'?t|cannot|can\s?not|unable\s+to|does\s+not|do\s+not"
    r"|(?:may|are|is|were|was)\s+not\s+(?:\w+\s+)?(?:be\s+)?able\s+to"
    r"|not\s+in\s+a\s+position\s+to)"
    # The gap is wide because refusals are written as long hedged sentences:
    # Roblox's runs ninety characters from "may not be able to" to "sponsorship".
    # Newlines are allowed inside the gap, and periods are only a boundary when
    # they end a sentence. Both were learned from real postings: Roblox's
    # refusal runs through the periods in "U.S.", and HPR's arrives from the
    # scraper as "does not\ncurrently\n\nprovide employment sponsorship" —
    # HTML extraction drops line breaks mid-sentence constantly. Excluding
    # either character made a refusal read as an offer.
    r"(?:[^.]|\.(?=\s*[a-z0-9]))"
    r"{0,200}\bsponsor"
    r"|\bno\s+(?:visa\s+)?sponsorship\b"
    r"|without\s+(?:visa\s+)?sponsorship"
    r"|sponsorship\s+is\s+not\s+(?:available|offered|provided)"
    r"|not\s+(?:currently\s+)?(?:offer(?:ing)?|provid(?:e|ing))\s+(?:visa\s+)?sponsorship"
    r"|candidates?\s+must\s+(?:not\s+require|be\s+authorized[^.\n]{0,30}without)"
    # Postings often carry this as a labelled field rather than a sentence:
    # "Employment Sponsorship Offered: No". The negation sits after the words
    # that otherwise read as an offer.
    r"|sponsorship[^.\n:]{0,24}[:\-=]\s*(?:no|none)\b"
    r")",
    re.IGNORECASE,
)

#: Explicit offers.
#:
#: "Sponsor" has an ordinary meaning that has nothing to do with immigration —
#: "you will sponsor internal initiatives across teams" is a description of the
#: job, not an offer of a visa. So the bare verb never matches on its own: it
#: must sit near visa, employment, immigration or H-1B wording, or appear in a
#: phrase like "take over sponsorship" that has no other reading.
_SPONSORS = re.compile(
    r"(?:"
    r"(?:will|do|does|can|are\s+able\s+to|happy\s+to|glad\s+to)\s+sponsor\b"
    r"[^.\n]{0,45}\b(?:visas?|employment|work\s+authoriz|immigration|H-?1B|green\s+card)"
    r"|sponsor\s+(?:employment\s+|work\s+)?visas?"
    r"|(?:visa|employment|immigration)\s+sponsorship\s+(?:is\s+)?(?:available|offered|provided|supported)"
    r"|sponsorship\s+(?:is\s+)?(?:available|offered|provided|supported)\s*(?:for\s+this\s+(?:role|position))?"
    r"|(?:offer|provide)s?\s+(?:visa\s+|employment\s+)?sponsorship"
    r"|take\s+over\s+sponsorship"
    r"|\bH-?1B\s+(?:sponsorship|transfer)s?"
    r")",
    re.IGNORECASE,
)

# Hardest-first. A posting can contain several of these; the most restrictive is
# the one that decides whether applying is worth the candidate's time.
_CHECKS: tuple[tuple[re.Pattern[str], Sponsorship], ...] = (
    (_CLEARANCE, Sponsorship.CLEARANCE_REQUIRED),
    (_CITIZENSHIP, Sponsorship.CITIZENSHIP_REQUIRED),
    (_NO_SPONSORSHIP, Sponsorship.NO_SPONSORSHIP),
    (_SPONSORS, Sponsorship.SPONSORS),
)


#: Negations that flip an apparent offer. Checked within the sentence *before*
#: the match, because a refusal is usually a long hedged clause: Roblox writes
#: "the Company may not be able to employ candidates … or support future H-1B
#: sponsorship at this time", where the negation is ninety characters upstream of
#: the words that look like an offer.
_NEGATED = re.compile(
    r"\b(?:not|cannot|can\s?not|won'?t|unable|neither|nor|without|no)\b", re.IGNORECASE
)

#: The answer to a labelled field sits to the *right* of the words that look
#: like an offer, so it has to be read forward rather than backward.
#:
#: Two cases. "Sponsorship Offered: No" is an explicit refusal. And a template
#: whose field was never filled in — "Sponsorship Available: ## Institution
#: Name:" — says nothing at all, but reads as an offer if only the label is
#: matched.
_FIELD_NO = re.compile(
    r"\s*[:\-=]\s*(?:no|none)\b"           # answered "no"
    r"|\s*[:\-=]\s*(?:#|\n|$)",             # label with no answer
    re.IGNORECASE,
)

#: A clearance line that explicitly says none is needed. Several federal
#: postings carry "Security Clearance Type: None/Not Required" as boilerplate,
#: and reading that as a clearance requirement would report the wrong reason.
_CLEARANCE_NOT_NEEDED = re.compile(
    r"clearance[^.\n]{0,30}(?:none|not\s+required|n/a)", re.IGNORECASE
)


#: A real sentence end: terminal punctuation, whitespace, then a capital. The
#: period in "U.S. visa categories" fails this because "visa" is lowercase,
#: which is exactly the case that broke the first version of this module.
#:
#: A bare newline is deliberately not a boundary. Descriptions are extracted
#: from HTML, so line breaks land mid-sentence — treating one as a full stop
#: separated a negation from the clause it negates.
_SENTENCE_END = re.compile(r"[.!?]\s+(?=[A-Z])")


#: How far back a negation can sit and still be about the offer. Bounded
#: because sentence detection is unreliable here: a benefits bullet list carries
#: no terminal punctuation, so Verkada's "we do sponsor" had eight hundred
#: characters of unpunctuated perks behind it, and a "not" among them read as a
#: refusal. Roblox's genuine refusal sits ninety characters upstream, so the
#: window has to clear that and little more.
_NEGATION_WINDOW = 140


def _sentence_before(text: str, index: int) -> str:
    """The text just before ``index``, within the current sentence."""
    starts = [m.end() for m in _SENTENCE_END.finditer(text, 0, index)]
    start = max(starts[-1] if starts else 0, index - _NEGATION_WINDOW)
    return text[start:index]


def classify(text: str) -> Sponsorship:
    """What this posting says about sponsoring a work visa."""
    if not text:
        return Sponsorship.UNSTATED
    for pattern, verdict in _CHECKS:
        for match in pattern.finditer(text):
            if verdict is Sponsorship.SPONSORS and (
                _NEGATED.search(_sentence_before(text, match.start()))
                or _FIELD_NO.match(text[match.end() : match.end() + 26])
            ):
                # An apparent offer that is actually a refusal — either negated
                # earlier in the sentence, or answered "No" as a labelled field
                # right after it. Keep looking: a later, unnegated match in the
                # same posting is still a real offer.
                continue
            if verdict is Sponsorship.CLEARANCE_REQUIRED and _CLEARANCE_NOT_NEEDED.search(
                _sentence_before(text, match.end()) + text[match.end() : match.end() + 40]
            ):
                continue
            return verdict
    return Sponsorship.UNSTATED


def evidence(text: str) -> str:
    """The sentence that decided the verdict, for showing the reader.

    A verdict the user cannot check is one they have to take on trust, and this
    one is consequential enough to be worth showing rather than asserting.
    """
    if not text:
        return ""
    for pattern, _ in _CHECKS:
        match = pattern.search(text)
        if match:
            start = max(0, match.start() - 90)
            end = min(len(text), match.end() + 110)
            return re.sub(r"\s+", " ", text[start:end]).strip()
    return ""


#: Verdicts that close the door on a candidate who needs sponsorship. "Unstated"
#: is deliberately absent: most postings say nothing, and treating silence as a
#: refusal would hide most of the market.
BLOCKS_VISA_HOLDER: frozenset[str] = frozenset({
    Sponsorship.NO_SPONSORSHIP.value,
    Sponsorship.CITIZENSHIP_REQUIRED.value,
    Sponsorship.CLEARANCE_REQUIRED.value,
})
