from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


@dataclass
class Job:
    source: str                 # greenhouse | lever | ashby | workday | simplify | hn
    company: str
    title: str
    url: str
    location: str = ""
    description: str = ""       # plain text; may be empty for aggregator sources
    posted_at: Optional[datetime] = None
    remote: Optional[bool] = None
    terms: list[str] = field(default_factory=list)   # e.g. ["Summer 2027"]
    sponsorship: str = ""       # free text from source if it says anything
    extra: dict = field(default_factory=dict)

    # ---- computed by filters / scorer -------------------------------------
    level: str = "unknown"      # intern | new_grad | early | senior | unknown
    bucket: str = ""            # human label: which of the user's target buckets this falls in
    min_years: Optional[int] = None
    flags: list[str] = field(default_factory=list)
    track_scores: dict = field(default_factory=dict)
    track: str = ""
    resume: str = ""
    score: int = 0
    reasons: list[str] = field(default_factory=list)
    dropped: str = ""           # non-empty => filtered out, with reason

    @property
    def id(self) -> str:
        key = f"{_norm(self.company)}|{_norm(self.title)}|{_norm(self.location)}"
        return hashlib.sha1(key.encode()).hexdigest()[:10]

    @property
    def dkey(self) -> str:
        """Cross-source identity: same company + same title (ignoring our own suffixes)."""
        t = re.sub(r"\((internship|new grad)\)", "", self.title.lower())
        return re.sub(r"\W+", "", self.company.lower())[:12] + "|" + re.sub(r"\W+", "", t)

    @property
    def text(self) -> str:
        return f"{self.title}\n{self.description}"

    def age_days(self, now: Optional[datetime] = None) -> Optional[int]:
        if not self.posted_at:
            return None
        now = now or datetime.now(timezone.utc)
        p = self.posted_at if self.posted_at.tzinfo else self.posted_at.replace(tzinfo=timezone.utc)
        return max(0, (now - p).days)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["id"] = self.id
        d["dkey"] = self.dkey
        d["posted_at"] = self.posted_at.isoformat() if self.posted_at else None
        d["description"] = (self.description or "")[:4000]
        return d
