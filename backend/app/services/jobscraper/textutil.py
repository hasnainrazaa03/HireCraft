"""HTML -> text and small parsing helpers (stdlib only)."""
from __future__ import annotations

import html
import re
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser
from typing import Optional


class _Stripper(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(s: str | None) -> str:
    if not s:
        return ""
    # Greenhouse double-escapes (&lt;p&gt;), so unescape until stable (max 2x).
    for _ in range(2):
        u = html.unescape(s)
        if u == s:
            break
        s = u
    p = _Stripper()
    try:
        p.feed(s)
    except Exception:
        return re.sub(r"<[^>]+>", " ", s)
    text = "".join(p.parts)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def parse_dt(v) -> Optional[datetime]:
    """Accepts ISO strings, epoch seconds/millis, or 'Posted 3 Days Ago'."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        if v > 1e12:
            v = v / 1000.0
        return datetime.fromtimestamp(v, tz=timezone.utc)
    if isinstance(v, str):
        s = v.strip()
        m = re.search(r"(\d+)\+?\s*(day|hour|minute)s?\s*ago", s, re.I)
        if m:
            n, unit = int(m.group(1)), m.group(2).lower()
            delta = {"day": timedelta(days=n), "hour": timedelta(hours=n), "minute": timedelta(minutes=n)}[unit]
            return datetime.now(timezone.utc) - delta
        if re.search(r"posted\s+(today|yesterday)", s, re.I):
            return datetime.now(timezone.utc) - (timedelta(days=1) if "yesterday" in s.lower() else timedelta())
        try:
            s2 = s.replace("Z", "+00:00")
            dt = datetime.fromisoformat(s2)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def norm_company(name: str) -> str:
    name = (name or "").strip()
    name = re.sub(r"\s+(inc\.?|llc|ltd\.?|corp\.?|co\.)$", "", name, flags=re.I)
    return name


PRETTY = {"openai": "OpenAI", "xai": "xAI", "elevenlabs": "ElevenLabs", "scaleai": "Scale AI",
          "andurilindustries": "Anduril", "snorkelai": "Snorkel AI", "flyzipline": "Zipline",
          "physicalintelligence": "Physical Intelligence", "openevidence": "OpenEvidence", "shieldai": "Shield AI",
          "sofi": "SoFi", "gitlab": "GitLab", "mongodb": "MongoDB", "spacex": "SpaceX", "doordash": "DoorDash",
          "linkedin": "LinkedIn", "paypal": "PayPal", "nvidia": "NVIDIA", "amd": "AMD", "ibm": "IBM",
          "hashicorp": "HashiCorp", "datadog": "Datadog", "coinbase": "Coinbase", "wandb": "Weights & Biases",
          "midjourney": "Midjourney", "anysphere": "Cursor (Anysphere)", "character": "Character.AI",
          "abridge": "Abridge", "cognition": "Cognition", "mercor": "Mercor", "decagon": "Decagon"}


def pretty_company(token: str) -> str:
    t = (token or "").lower()
    return PRETTY.get(t, t.replace("-", " ").replace("_", " ").title())
