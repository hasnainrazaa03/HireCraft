"""Which degree levels a posting will actually consider.

Deterministic, no LLM: postings state their degree requirement in a handful of
recognisable phrasings, and getting this wrong in either direction is costly —
hiding a role the candidate is eligible for, or showing one that will filter
them out on the first screen.

The subtlety worth naming: "Bachelor's degree or higher" accepts a master's, so
mentioning a bachelor's is not the same as excluding everything above it. Only a
posting that names a bachelor's *and nothing above it, without an open-ended
qualifier* is treated as bachelor's-only.
"""

from __future__ import annotations

import enum
import re

# Degree families, written to match how postings actually phrase them.
#
# Single-letter abbreviations are the whole difficulty. Matching bare letter
# pairs is a trap — an earlier version accepted "b.?e.?", which matches the word
# "be", and classified nearly every posting in the feed as requiring a
# bachelor's. So a bare "BS"/"MS" counts only where it is doing a degree's job
# in the sentence: dotted ("B.S."), spelled out ("BSc"), or immediately followed
# by a slash, a comma, or the words "in", "or", "degree" — which is how
# "BS/MS in CS" and "MS or PhD" are written and how "systems" never is.
_ABBREV_CONTEXT = r"(?=\s*[/,;)]|\s+(?:or|in|degree)\b)"

_BACHELOR = re.compile(
    r"\b(?:bachelor'?s?(?:\s+degree)?"
    r"|bsc\b|b\.?tech\b"
    r"|b\.\s?[sae]\.?"
    rf"|b\.?[sa]\.?{_ABBREV_CONTEXT}"
    r"|undergraduate\s+degree|four[- ]year\s+degree)",
    re.IGNORECASE,
)
_MASTER = re.compile(
    r"\b(?:master'?s?(?:\s+degree)?"
    r"|msc\b|m\.?eng\b|m\.?tech\b|m\.?b\.?a\b"
    r"|m\.\s?[sa]\.?"
    rf"|m\.?s\.?{_ABBREV_CONTEXT}"
    r"|graduate\s+degree|postgraduate)",
    re.IGNORECASE,
)
_PHD = re.compile(r"\b(?:ph\.?\s?d\.?|doctoral|doctorate|d\.?phil)\b", re.IGNORECASE)

# Restricted to people who do not yet have more than a bachelor's. This — not a
# stated bachelor's requirement — is what actually rules a master's candidate
# out. "Bachelor's degree required" is a floor a master's clears; "must be
# pursuing a bachelor's" is a ceiling it breaches.
_UNDERGRAD_ONLY = re.compile(
    r"(?:(?:currently\s+)?(?:pursuing|enrolled\s+in|working\s+toward(?:s)?|completing)"
    r"\s+(?:an?\s+)?(?:undergraduate|bachelor'?s?|b\.?s\.?|b\.?a\.?)\b"
    r"|undergraduate(?:\s+students?)?\s+only"
    r"|rising\s+(?:junior|senior)"
    r"|must\s+be\s+an?\s+undergraduate"
    r"|open\s+(?:only\s+)?to\s+undergraduate)",
    re.IGNORECASE,
)

# "Bachelor's or higher", "minimum of a Bachelor's", "BS+" — open-ended, so a
# higher degree qualifies. Checked in a window around the bachelor's mention so
# an "or higher" belonging to a sentence about years of experience can't leak in.
_OPEN_ENDED = re.compile(
    r"(?:or\s+(?:higher|above|greater|more|equivalent|better)|or\s+an?\s+advanced"
    r"|minimum|at\s+least|\+\s*(?:degree)?)",
    re.IGNORECASE,
)
_WINDOW = 60


class DegreeLevel(str, enum.Enum):
    """What a posting will consider. Stored on the row; filtered on in the feed."""

    UNSPECIFIED = "unspecified"
    #: Restricted to undergraduates — a master's candidate is not eligible.
    UNDERGRAD_ONLY = "undergrad_only"
    #: States a bachelor's as the requirement. A master's clears that floor, so
    #: this is eligible; it is kept separate so it can still be filtered on.
    BACHELORS = "bachelors"
    BACHELORS_OR_HIGHER = "bachelors_or_higher"
    MASTERS = "masters"
    #: Requires a doctorate — a master's does not satisfy it.
    PHD = "phd"


def classify(text: str) -> DegreeLevel:
    """The degree requirement a posting states, from its text."""
    if not text:
        return DegreeLevel.UNSPECIFIED

    # Checked first: a posting can name a bachelor's *and* restrict itself to
    # undergraduates, and the restriction is the operative fact.
    if _UNDERGRAD_ONLY.search(text) and not _MASTER.search(text):
        return DegreeLevel.UNDERGRAD_ONLY

    has_phd = bool(_PHD.search(text))
    has_master = bool(_MASTER.search(text))
    bachelor_hits = list(_BACHELOR.finditer(text))

    if has_master and bachelor_hits:
        # "BS/MS", "Bachelor's required, Master's preferred" — both welcome.
        return DegreeLevel.BACHELORS_OR_HIGHER
    if has_master:
        return DegreeLevel.MASTERS
    if has_phd and not bachelor_hits:
        return DegreeLevel.PHD
    if bachelor_hits:
        for match in bachelor_hits:
            around = text[max(0, match.start() - _WINDOW) : match.end() + _WINDOW]
            if _OPEN_ENDED.search(around):
                return DegreeLevel.BACHELORS_OR_HIGHER
        if has_phd:
            return DegreeLevel.BACHELORS_OR_HIGHER
        return DegreeLevel.BACHELORS
    return DegreeLevel.UNSPECIFIED


#: Levels a master's candidate can apply to.
#:
#: Two inclusions are deliberate. A posting that says nothing is in: silence is
#: not a rejection, and most postings never state a degree — excluding them
#: would hide most of the feed on a technicality. And a stated bachelor's
#: requirement is in: it is a minimum a master's exceeds, so treating it as an
#: exclusion would hide hundreds of roles the candidate can apply to.
#:
#: What is out is what genuinely rules them out: postings restricted to
#: undergraduates, and postings requiring a doctorate.
MASTERS_ELIGIBLE: frozenset[str] = frozenset({
    DegreeLevel.UNSPECIFIED.value,
    DegreeLevel.BACHELORS.value,
    DegreeLevel.BACHELORS_OR_HIGHER.value,
    DegreeLevel.MASTERS.value,
})

#: The stricter reading: only postings that explicitly welcome a graduate
#: degree. Offered as a filter choice, never as the default — it hides every
#: posting that simply doesn't mention a degree.
GRADUATE_STATED: frozenset[str] = frozenset({
    DegreeLevel.BACHELORS_OR_HIGHER.value,
    DegreeLevel.MASTERS.value,
})
