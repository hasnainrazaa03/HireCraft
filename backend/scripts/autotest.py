"""autotest — drive HireCraft's API the way the frontend does, and report.

A regression sweep against a *running* stack, complementing the unit tests: it
exercises real HTTP endpoints, real Postgres rows and real rendering, which is
where every bug found by hand so far actually lived (a query-key crash, an
invented summary, a stale score, a scorer that ranked the wrong roles).

Checks are grouped:
  free  — deterministic paths: auth, résumés, job feed + filters, analytics,
          restore points, notes, triage. No LLM, no cost.
  paid  — tailoring, cover letters, interview questions/answers, Copilot. These
          call the configured model and bill the user's key, so they only run
          with --paid.

Usage (inside the api container):
    python scripts/autotest.py --email you@x.com [--paid] [--keep]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx

BASE = "http://localhost:8000/api/v1"


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, str]] = []
        self.t0 = time.time()

    def add(self, group: str, name: str, ok: bool | None, detail: str = "") -> None:
        status = "PASS" if ok else ("SKIP" if ok is None else "FAIL")
        self.rows.append((group, name, status, detail))
        mark = {"PASS": "✓", "FAIL": "✗", "SKIP": "–"}[status]
        print(f"  {mark} [{group}] {name}" + (f" — {detail}" if detail else ""), flush=True)

    def summary(self) -> int:
        p = sum(1 for r in self.rows if r[2] == "PASS")
        f = sum(1 for r in self.rows if r[2] == "FAIL")
        s = sum(1 for r in self.rows if r[2] == "SKIP")
        print(f"\n{'=' * 62}")
        print(f"  {p} passed · {f} failed · {s} skipped   ({time.time() - self.t0:.1f}s)")
        if f:
            print("\n  FAILURES:")
            for g, n, st, d in self.rows:
                if st == "FAIL":
                    print(f"    ✗ [{g}] {n} — {d}")
        print("=" * 62)
        return 1 if f else 0


def _throttled(res: "httpx.Response") -> bool:
    """A 429 is the app protecting the user's quota, not a defect. Reported as a
    skip: a sweep that flags its own rate limiting as a bug teaches you to ignore
    the sweep."""
    return res.status_code == 429


def _why(res: "httpx.Response", ok_detail: str) -> str:
    """On failure show what the server actually said, so a red line is
    actionable instead of just restating the check's name."""
    if res.status_code == 200:
        return ok_detail
    try:
        return f"HTTP {res.status_code}: {str(res.json().get('detail'))[:110]}"
    except Exception:  # noqa: BLE001
        return f"HTTP {res.status_code}"


def token_for(email: str) -> str:
    from app.core.security import create_token
    from app.db.session import SessionLocal
    from app.models.user import User

    db = SessionLocal()
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        sys.exit(f"no user {email!r}")
    return create_token(user.id, "access")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--paid", action="store_true", help="also run LLM-billing checks")
    ap.add_argument("--keep", action="store_true", help="don't delete what the run created")
    args = ap.parse_args()

    r = Report()
    c = httpx.Client(
        base_url=BASE,
        headers={"Authorization": f"Bearer {token_for(args.email)}"},
        timeout=180,
    )
    created: list[tuple[str, str]] = []  # (path, id) to clean up

    def check(group: str, name: str, fn) -> object:
        try:
            ok, detail, value = fn()
            r.add(group, name, ok, detail)
            return value
        except Exception as exc:  # noqa: BLE001 - a failing check must not stop the sweep
            r.add(group, name, False, f"{type(exc).__name__}: {str(exc)[:110]}")
            return None

    print("\n=== FREE: deterministic paths (no LLM, no cost) ===\n")

    def _resumes():
        res = c.get("/resumes")
        rs = res.json()
        return res.status_code == 200 and len(rs) > 0, f"{len(rs)} résumé(s)", rs

    resumes = check("resumes", "list résumés", _resumes) or []

    def _original():
        withsrc = [x for x in resumes if x.get("source_filename")]
        if not withsrc:
            return None, "no imported résumé", None
        got = c.get(f"/resumes/{withsrc[0]['id']}/original")
        return (
            got.status_code == 200 and len(got.content) > 1000,
            f"{withsrc[0]['source_filename']} · {len(got.content)}B",
            None,
        )

    check("resumes", "download original upload", _original)

    def _render():
        got = c.get(f"/resumes/{resumes[0]['id']}/render.pdf")
        return got.status_code == 200 and got.content[:4] == b"%PDF", f"{len(got.content)}B PDF", None

    check("resumes", "render résumé PDF", _render)

    def _analysis():
        got = c.get(f"/resumes/{resumes[0]['id']}/analysis")
        d = got.json()
        return got.status_code == 200 and "overall_score" in d, f"score {d.get('overall_score')}/100, ATS {d.get('ats_score')}", None

    check("resumes", "résumé analysis", _analysis)

    def _evidence():
        got = c.get("/evidence")
        d = got.json()
        return got.status_code == 200 and len(d) > 0, f"{len(d)} brag-bank items", None

    check("evidence", "brag bank populated", _evidence)

    def _profile():
        got = c.get("/profile")
        d = got.json()
        return got.status_code == 200 and bool(d.get("headline")), "career profile set", None

    check("profile", "career profile", _profile)

    def _stats():
        got = c.get("/jobs/feed/stats")
        d = got.json()
        return got.status_code == 200 and d.get("active", 0) > 0, f"{d.get('active')} active postings", d

    stats = check("jobs", "feed stats", _stats) or {}

    def _feed():
        got = c.get("/jobs/feed", params={"limit": 20})
        d = got.json()
        scored = [x for x in d if x.get("match_score") is not None]
        return got.status_code == 200 and len(scored) == len(d) and len(d) > 0, f"{len(d)} cards, all scored", d

    feed = check("jobs", "feed defaults to a résumé and scores", _feed) or []

    def _rescore():
        if len(resumes) < 2:
            return None, "need 2+ résumés", None
        a = c.get("/jobs/feed", params={"resume_id": resumes[0]["id"], "limit": 8}).json()
        b = c.get("/jobs/feed", params={"resume_id": resumes[1]["id"], "limit": 8}).json()
        sa = [x["match_score"] for x in a]
        sb = [x["match_score"] for x in b]
        return sa != sb, f"{resumes[0]['name']} {sa[:3]} vs {resumes[1]['name']} {sb[:3]}", None

    check("jobs", "different résumé → different ranking", _rescore)

    def _filters():
        checks = []
        lv = next(iter((stats.get("by_level") or {})), None)
        if lv:
            d = c.get("/jobs/feed", params={"level": lv, "limit": 30}).json()
            checks.append(all(x.get("level") == lv for x in d))
        d = c.get("/jobs/feed", params={"remote_only": True, "limit": 30}).json()
        checks.append(all(x.get("remote") for x in d))
        d = c.get("/jobs/feed", params={"min_score": 60, "limit": 30}).json()
        checks.append(all((x.get("match_score") or 0) >= 60 for x in d))
        d = c.get("/jobs/feed", params={"q": "engineer", "limit": 30}).json()
        checks.append(all("engineer" in (x["title"] + x["company"] + x["location"]).lower() for x in d))
        return all(checks), f"level/remote/min_score/q all honoured ({sum(checks)}/{len(checks)})", None

    check("jobs", "filters actually filter", _filters)

    def _fetch_desc():
        thin = [x for x in feed if len(x.get("snippet") or "") < 200 and x.get("id")]
        if not thin:
            return None, "no description-less card in page", None
        got = c.post(f"/jobs/feed/{thin[0]['id']}/fetch")
        d = got.json()
        return got.status_code == 200, f"snippet {len(thin[0].get('snippet') or '')}→{len(d.get('snippet') or '')}ch", None

    check("jobs", "fetch a missing description on demand", _fetch_desc)

    def _triage():
        if not feed:
            return None, "empty feed", None
        jid = feed[0]["id"]
        got = c.patch(f"/jobs/feed/{jid}", json={"status": "saved"})
        back = c.patch(f"/jobs/feed/{jid}", json={"status": "new"})
        return got.status_code == 200 and back.status_code == 200, "saved → new round-trip", None

    check("jobs", "triage a feed posting", _triage)

    def _apps():
        got = c.get("/applications")
        return got.status_code == 200, f"{len(got.json())} application(s)", got.json()

    apps = check("applications", "list applications", _apps) or []

    def _analytics():
        a = c.get("/analytics/overview")
        b = c.get("/analytics/usage")
        return a.status_code == 200 and b.status_code == 200, "overview + usage", None

    check("analytics", "dashboards load", _analytics)

    def _interview_saved():
        got = c.get("/interview/saved")
        return got.status_code == 200, f"{len(got.json())} saved question(s)", None

    check("interview", "saved questions endpoint", _interview_saved)

    def _saved_letters():
        got = c.get("/studio/cover-letters/saved")
        return got.status_code == 200, f"{len(got.json())} saved letter(s)", None

    check("studio", "saved cover letters", _saved_letters)

    def _gaps():
        got = c.get("/insights/skill-gaps", params={"resume_id": resumes[0]["id"]})
        d = got.json()
        return got.status_code == 200, f"{d.get('jobs_analyzed')} jobs analysed", None

    check("insights", "skill gaps", _gaps)

    if args.paid:
        print("\n=== PAID: LLM paths (bills the configured key) ===\n")

        def _tailor():
            job = next((x for x in feed if len(x.get("snippet") or "") > 300), None)
            if not job:
                return None, "no described posting to tailor against", None
            got = c.post(
                "/applications",
                json={
                    "resume_profile_id": resumes[0]["id"],
                    "job": {"text": job["snippet"] * 3, "title": job["title"], "company": job["company"]},
                    "include_cover_letter": True,
                },
            )
            if _throttled(got):
                return None, "generation rate limit reached", None
            if got.status_code != 202:
                return False, _why(got, ""), None
            app_id = got.json()["id"]
            created.append(("/applications", app_id))
            for _ in range(60):
                st = c.get(f"/applications/{app_id}/status").json()
                if st["pipeline_status"] in ("completed", "failed"):
                    break
                time.sleep(4)
            detail = c.get(f"/applications/{app_id}").json()
            ok = detail["pipeline_status"] == "completed"
            return ok, f"status={detail['pipeline_status']} cost=${detail.get('total_cost_usd', 0):.4f}", app_id

        app_id = check("tailoring", "tailor a résumé end to end", _tailor)

        if app_id:
            def _cover():
                d = c.get(f"/applications/{app_id}").json()
                paras = d.get("cover_letter") or []
                arts = {a["kind"] for a in d.get("artifacts", [])}
                return bool(paras) and "cover_letter_pdf" in arts, f"{len(paras)} paragraphs + PDF", None

            check("tailoring", "cover letter stored (paragraphs + PDF)", _cover)

            def _restore():
                got = c.get(f"/applications/{app_id}/restore-points")
                return got.status_code == 200, f"{len(got.json())} restore point(s)", None

            check("tailoring", "restore points endpoint", _restore)

            def _pkg():
                got = c.get(f"/applications/{app_id}/download/package")
                return got.status_code == 200 and got.content[:2] == b"PK", f"{len(got.content)}B zip", None

            check("tailoring", "download package", _pkg)

        def _questions():
            got = c.post(
                "/interview/questions",
                json={"resume_profile_id": resumes[0]["id"], "count": 4, "categories": []},
            )
            if _throttled(got):
                return None, "generation rate limit reached", []
            d = got.json()
            saved = d.get("saved") or []
            for q in saved:
                created.append(("/interview/saved", q["id"]))
            return len(saved) > 0, _why(got, f"{len(saved)} question(s) saved"), saved

        saved_qs = check("interview", "generate + persist questions", _questions) or []

        if saved_qs:
            def _answer():
                got = c.post(f"/interview/saved/{saved_qs[0]['id']}/answer", json={"use_voice": False})
                if _throttled(got):
                    return None, "generation rate limit reached", None
                d = got.json()
                star = d.get("answer") or {}
                ok = got.status_code == 200 and bool(star.get("situation"))
                return ok, _why(got, "STAR answer stored"), None

            check("interview", "draft + persist a STAR answer", _answer)

        def _copilot():
            got = c.post("/copilot/chat", json={"message": "In one sentence, what should I fix first?", "history": []})
            if _throttled(got):
                return None, "generation rate limit reached", None
            d = got.json()
            ok = got.status_code == 200 and len(d.get("reply", "")) > 20
            return ok, _why(got, f"{len(d.get('reply',''))} chars"), None

        check("copilot", "grounded answer", _copilot)

    if created and not args.keep:
        print("\ncleaning up…")
        for path, ident in reversed(created):
            try:
                c.delete(f"{path}/{ident}")
            except Exception:  # noqa: BLE001
                pass
        print(f"  removed {len(created)} created record(s)")

    return r.summary()


if __name__ == "__main__":
    raise SystemExit(main())
