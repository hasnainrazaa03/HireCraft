"""Make a posting's location fit on a card.

Workday lets an employer attach one requisition to every site it could be
worked from, and hands the whole list over as one string. CVS Health's Data
Scientist posting arrives as 500 characters — "Chicago-525 West Monroe; Work At
Home-Arkansas; Work At Home-Idaho; …" for twenty more states — which rendered as
sixteen lines of text and pushed the rest of the card off the bottom.

The list is not useless, though, and truncating it at the first entry would
throw away the most important thing it says: that the role can be worked from
anywhere. So it is summarised rather than cut.
"""

from __future__ import annotations

import re

#: Workday writes a remote site as "Work At Home-Texas" or "Remote - Texas";
#: other boards say "Work from home". All of them mean the same thing.
_REMOTE = re.compile(r"\b(?:work\s*(?:at|from)\s*home|remote|virtual|telecommut)", re.I)

#: Workday prefixes an office with its building or site code — "Chicago-525
#: West Monroe", "USA-NY-New York-1 Penn". The street address is noise on a
#: card; the city is the part anybody reads.
_SITE_CODE = re.compile(r"^(?:[A-Z]{2,3}-)?(.+?)(?:-\d+\s+\w.*)?$")

_SPLIT = re.compile(r"\s*[;|]\s*|\s+\|\s+")


def _city(entry: str) -> str:
    entry = entry.strip(" -,")
    found = _SITE_CODE.match(entry)
    return (found.group(1) if found else entry).strip(" -,")


def summarise(location: str | None, *, limit: int = 60) -> str:
    """One readable line, however many places the posting lists.

    Short locations are returned untouched — the overwhelming majority of
    postings name one place and need no help. Only a list gets condensed, and
    the condensed form still says how many places there were, because "+18
    more" is information and a silent truncation is a lie.
    """
    text = (location or "").strip()
    if not text or len(text) <= limit:
        return text

    parts = [p for p in _SPLIT.split(text) if p.strip()]
    if len(parts) <= 1:
        # One very long entry rather than a list — a Workday site string with
        # the building, floor and suite in it. Strip the site code first; that
        # alone usually brings it under the limit, and cutting is a last resort.
        single = _city(text)
        if len(single) <= limit:
            return single
        return single[:limit].rsplit(" ", 1)[0].rstrip(" ,-") + "…"

    offices = [_city(p) for p in parts if not _REMOTE.search(p)]
    remotes = [p for p in parts if _REMOTE.search(p)]

    if offices and remotes:
        head = offices[0]
        rest = len(offices) - 1 + len(remotes)
        return f"{head} + remote ({rest} more)" if rest else head
    if remotes and not offices:
        # Every entry is a work-from-home site, so the list of states is just a
        # long way of saying the role is remote.
        return f"Remote ({len(remotes)} locations)" if len(remotes) > 1 else _city(remotes[0])

    head = offices[0]
    rest = len(offices) - 1
    return f"{head} +{rest} more" if rest else head
