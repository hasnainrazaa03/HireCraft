"""LaTeX escaping.

Resume content is arbitrary user text. Without escaping, an employer named
"Procter & Gamble", a bullet mentioning "99% uptime", or a C# skill entry will
break the compile - and a stray ``\\input`` would be an injection vector. Every
value interpolated into a template passes through :func:`escape_tex`, which the
renderer wires up as Jinja's ``finalize`` hook so it cannot be forgotten.
"""

from __future__ import annotations

import re
from urllib.parse import quote, urlsplit

# Every substitution is applied in ONE regex pass. Doing this with sequential
# str.replace calls is subtly wrong: "\" -> "\textbackslash{}" would then have
# its own braces rewritten by the later "{" and "}" rules, producing the broken
# "\textbackslash\{\}" - which silently defeats injection escaping. A single
# pass never re-examines what it just emitted.
_ESCAPES: dict[str, str] = {
    # --- LaTeX metacharacters ---
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
    "<": r"\textless{}",
    ">": r"\textgreater{}",
    "|": r"\textbar{}",
    # --- Typography that would otherwise render as a missing glyph ---
    "‘": "`",
    "’": "'",
    "“": "``",
    "”": "''",
    "–": "--",
    "—": "---",
    "…": r"\ldots{}",
    " ": "~",
    "•": r"\textbullet{}",
    "﻿": "",
    "​": "",
}

# Longest keys first so no multi-character key can be shadowed by a prefix.
_ESCAPE_RE = re.compile(
    "|".join(re.escape(key) for key in sorted(_ESCAPES, key=len, reverse=True))
)

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

_ALLOWED_URL_SCHEMES = frozenset({"http", "https", "mailto"})


class TexSafe(str):
    """A string that has already been escaped.

    The renderer escapes every interpolated value through a Jinja ``finalize``
    hook. Without this marker, a value a template deliberately passed through
    ``| url`` would be escaped a second time and corrupted. Escaping helpers
    return ``TexSafe`` so the hook knows to leave their output alone.
    """

    __slots__ = ()


def escape_tex(value: object) -> TexSafe:
    """Escape ``value`` for safe interpolation into a LaTeX document body."""
    if value is None:
        return TexSafe("")
    if isinstance(value, TexSafe):
        return value
    if isinstance(value, bool):
        return TexSafe("true" if value else "false")
    if not isinstance(value, str):
        value = str(value)

    text = _CONTROL_CHARS.sub("", value)
    return TexSafe(_ESCAPE_RE.sub(lambda m: _ESCAPES[m.group()], text))


def escape_url(value: object) -> TexSafe:
    """Sanitize and escape a URL for use inside ``\\href{...}``.

    Rejects non-web schemes outright - ``javascript:`` and ``file:`` have no
    place in a generated document - then percent-encodes the characters that
    would otherwise terminate the LaTeX argument.
    """
    if value is None:
        return TexSafe("")
    raw = str(value).strip()
    if not raw:
        return TexSafe("")

    parts = urlsplit(raw)
    if parts.scheme and parts.scheme.lower() not in _ALLOWED_URL_SCHEMES:
        return TexSafe("")
    if not parts.scheme and not raw.startswith("//"):
        raw = f"https://{raw}"

    # Keep URL structure intact while encoding LaTeX-hostile characters. "%" is
    # in the safe set so an already-encoded URL is not double-encoded: without
    # it, "%20" becomes "%2520" and the link breaks.
    safe = quote(raw, safe=":/?#[]@!$&'()*+,;=-._~%")
    for source, target in (("%", r"\%"), ("#", r"\#"), ("&", r"\&"), ("_", r"\_")):
        safe = safe.replace(source, target)
    return TexSafe(safe)


def display_url(value: object) -> TexSafe:
    """Human-friendly URL text: strips the scheme and any trailing slash."""
    if value is None:
        return TexSafe("")
    raw = str(value).strip()
    for prefix in ("https://", "http://"):
        if raw.startswith(prefix):
            raw = raw[len(prefix) :]
            break
    if raw.startswith("www."):
        raw = raw[4:]
    return escape_tex(raw.rstrip("/"))
