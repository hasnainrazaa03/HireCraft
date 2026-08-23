"""Latest 'Ask HN: Who is hiring?' thread via the Algolia API."""
from __future__ import annotations

import re
from ..http import get_json
from ..models import Job
from ..textutil import html_to_text, parse_dt

SEARCH = ("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring"
          "&query=%22Who%20is%20hiring%22&hitsPerPage=5")


def fetch() -> list[Job]:
    hits = (get_json(SEARCH) or {}).get("hits") or []
    hits = [h for h in hits if "who is hiring" in h.get("title", "").lower()]
    if not hits:
        return []
    thread = get_json(f"https://hn.algolia.com/api/v1/items/{hits[0]['objectID']}") or {}
    month = re.sub(r".*\((.*)\).*", r"\1", hits[0]["title"])
    jobs = []
    for c in thread.get("children") or []:
        text = html_to_text(c.get("text"))
        if not text:
            continue
        first = text.split("\n", 1)[0]
        parts = [p.strip() for p in first.split("|")]
        company = parts[0][:60] if parts else "HN"
        title = " | ".join(parts[1:4]) if len(parts) > 1 else first[:120]
        loc = " | ".join(parts[1:])[:160]      # whole header line; the location filter reads it
        jobs.append(Job(source="hn", company=company, title=title[:160],
                        url=f"https://news.ycombinator.com/item?id={c.get('id')}",
                        location=loc, description=text, posted_at=parse_dt(c.get("created_at")),
                        remote=True if re.search(r"\bremote\b", first, re.I) else None,
                        extra={"thread": month}))
    return jobs
