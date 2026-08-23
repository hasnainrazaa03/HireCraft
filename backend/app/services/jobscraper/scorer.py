"""Score each job against every resume track; pick the best track/resume."""
from __future__ import annotations

import re
from typing import Iterable

from .models import Job


def _kw(words: Iterable[str]) -> list[tuple[str, re.Pattern]]:
    out = []
    for w in words:
        w = str(w)
        if w.startswith(" ") or w.endswith(" "):
            out.append((w.strip(), re.compile(re.escape(w), re.I)))
        elif w.endswith("*"):
            out.append((w[:-1], re.compile(r"(?<![a-z0-9+#])" + re.escape(w[:-1]), re.I)))
        else:
            out.append((w, re.compile(r"(?<![a-z0-9+#])" + re.escape(w) + r"(?![a-z0-9])", re.I)))
    return out


class Scorer:
    def __init__(self, profile: dict):
        self.tracks = {}
        for name, tr in profile.get("tracks", {}).items():
            self.tracks[name] = {
                "label": tr.get("label", name),
                "resume": tr.get("resume", ""),
                "title": _kw(tr.get("title_keywords", [])),
                "skills": _kw(tr.get("skills", [])),
            }
        self.levels = profile.get("levels", [])

    def score(self, job: Job) -> Job:
        title = f" {job.title} "
        text = job.text
        has_desc = bool(job.description and len(job.description) > 200)
        best, best_s, best_r = "", -1, []
        for name, tr in self.tracks.items():
            reasons = []
            th = [k for k, r in tr["title"] if r.search(title)]
            s = 25 * min(len(th), 2)
            if th:
                reasons.append("title:" + ",".join(th[:3]))
            if has_desc:
                sh = [k for k, r in tr["skills"] if r.search(text)]
                s += 4 * min(len(sh), 10)
                if sh:
                    reasons.append("skills:" + ",".join(sh[:8]))
            ts = [k for k, r in tr["skills"] if r.search(title)]
            s += 5 * min(len(ts), 2)
            s = min(s, 100)
            job.track_scores[name] = s
            if s > best_s:
                best, best_s, best_r = name, s, reasons
        job.track, job.reasons = best, best_r
        job.resume = self.tracks[best]["resume"] if best else ""

        # global adjustments
        adj = 0
        if job.level in ("intern", "new_grad"):
            adj += 10
        if "loc+" in job.flags:
            adj += 5
        age = job.age_days()
        if age is not None and age <= 7:
            adj += 5
        if "no-sponsorship" in job.flags:
            adj -= 15
        if any(f.startswith("exp:") for f in job.flags):
            adj -= 15
        if "phd" in job.flags:
            adj -= 20
        if not has_desc:
            # title-only evidence: keep it in the mix but don't let it outrank rich matches
            best_s = min(best_s, 70)
        job.score = max(0, min(100, best_s + adj))
        return job
