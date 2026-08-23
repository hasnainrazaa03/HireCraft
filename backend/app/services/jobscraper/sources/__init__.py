"""Run every configured source concurrently and return (jobs, stats)."""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable

from ..models import Job
from . import greenhouse, lever, ashby, workday, simplify, hackernews

log = logging.getLogger("jobscraper.sources")
ATS = {"greenhouse": greenhouse, "lever": lever, "ashby": ashby}


def build_tasks(companies: dict, only: set[str] | None, want_title: Callable[[str], bool]):
    tasks: list[tuple[str, str, Callable[[], list[Job]]]] = []
    for ats, mod in ATS.items():
        if only and ats not in only:
            continue
        for tok in companies.get(ats) or []:
            tasks.append((ats, tok, (lambda m=mod, t=tok: m.fetch(t))))
    if not only or "workday" in only:
        for cfg in companies.get("workday") or []:
            tasks.append(("workday", cfg["tenant"], (lambda c=cfg: workday.fetch(c, want_title))))
    if (not only or "simplify" in only) and companies.get("simplify_internships", True):
        tasks.append(("simplify", "internships", simplify.fetch_internships))
    if (not only or "simplify" in only) and companies.get("simplify_new_grad", True):
        tasks.append(("simplify", "new-grad", simplify.fetch_new_grad))
    if (not only or "hn" in only) and companies.get("hackernews_who_is_hiring", True):
        tasks.append(("hn", "who-is-hiring", hackernews.fetch))
    return tasks


def collect(companies: dict, only: set[str] | None, want_title: Callable[[str], bool],
            workers: int = 8, progress: Callable[[str], None] | None = None):
    tasks = build_tasks(companies, only, want_title)
    jobs: list[Job] = []
    stats = {"sources": len(tasks), "ok": 0, "failed": [], "per_source": {}}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fn): (ats, name) for ats, name, fn in tasks}
        for f in as_completed(futs):
            ats, name = futs[f]
            try:
                got = f.result()
                jobs.extend(got)
                stats["ok"] += 1
                stats["per_source"][f"{ats}:{name}"] = len(got)
                if progress:
                    progress(f"  {ats:10} {name:28} {len(got):5d} postings")
            except Exception as e:  # one bad board must not kill the run
                log.warning("%s:%s failed: %s", ats, name, e)
                stats["failed"].append(f"{ats}:{name}")
                if progress:
                    progress(f"  {ats:10} {name:28} FAILED ({e.__class__.__name__})")
    stats["seconds"] = round(time.time() - t0, 1)
    stats["fetched"] = len(jobs)
    return jobs, stats


def dedupe(jobs: list[Job]) -> list[Job]:
    """Same job can arrive from an ATS board and from Simplify; keep the richer one."""
    def key(j: Job):
        return j.dkey

    best: dict = {}
    for j in jobs:
        k = key(j)
        cur = best.get(k)
        if cur is None or (len(j.description) > len(cur.description)):
            if cur is not None and not j.terms and cur.terms:
                j.terms = cur.terms
            if cur is not None and not j.sponsorship and cur.sponsorship:
                j.sponsorship = cur.sponsorship
            best[k] = j
        else:
            if not cur.terms and j.terms:
                cur.terms = j.terms
            if not cur.sponsorship and j.sponsorship:
                cur.sponsorship = j.sponsorship
    return list(best.values())
