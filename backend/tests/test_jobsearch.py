"""Job aggregation tests: normalisation, dedup/filter, GitHub parsing.

Network calls are stubbed; what's pinned is the logic we own — merging sources,
de-duplicating, query/remote filtering, the limit, and parsing a GitHub
listings.json + README table into the common shape.
"""

from __future__ import annotations

import app.services.jobsearch as js


def _r(**kw):
    return js._result(**kw)


def _stub_sources(monkeypatch, mapping):
    monkeypatch.setattr(js, "_SOURCES", mapping)


# --- helpers ----------------------------------------------------------------


def test_clean_cell_strips_markdown_and_emoji():
    assert js._clean_cell("**[Stripe](https://x)** 🔒🛂") == "Stripe"
    assert js._clean_cell("Senior Engineer</br>Remote") == "Senior Engineer, Remote"


def test_first_url_prefers_href_then_markdown():
    assert js._first_url('| A | <a href="https://apply/1">Apply</a> |') == "https://apply/1"
    assert js._first_url("| A | [Apply](https://apply/2) |") == "https://apply/2"
    assert js._first_url("| A | plain https://apply/3 text |") == "https://apply/3"


def test_to_unix_variants():
    assert js._to_unix(1700000000) == 1700000000
    assert isinstance(js._to_unix("2026-01-15"), int)
    assert js._to_unix("not a date") is None


# --- aggregation ------------------------------------------------------------


def test_merges_dedups_and_filters(monkeypatch):
    _stub_sources(monkeypatch, {
        "a": lambda: [
            _r(title="Python Engineer", company="Globex", url="https://x/1", remote=True, tags=["python"]),
            _r(title="Designer", company="Acme", url="https://x/2", remote=False),
        ],
        "b": lambda: [
            _r(title="Python Engineer", company="Globex", url="https://x/1"),  # dup url
            _r(title="ML Engineer", company="Initech", url="https://x/3", remote=True, tags=["ml", "python"]),
        ],
    })
    # query filters to python roles; dup url collapses to one.
    res = js.search_jobs("python", sources=["a", "b"])
    titles = [r.title for r in res]
    assert "Python Engineer" in titles and "ML Engineer" in titles
    assert "Designer" not in titles
    assert titles.count("Python Engineer") == 1  # deduped


def test_remote_only_and_limit(monkeypatch):
    _stub_sources(monkeypatch, {
        "a": lambda: [
            _r(title="A", company="X", url="u1", remote=True),
            _r(title="B", company="Y", url="u2", remote=False),
            _r(title="C", company="Z", url="u3", remote=True),
        ],
    })
    remote = js.search_jobs(None, remote_only=True, sources=["a"])
    assert all(r.remote for r in remote) and len(remote) == 2
    assert len(js.search_jobs(None, limit=1, sources=["a"])) == 1


def test_a_failing_source_is_skipped(monkeypatch):
    def boom():
        raise RuntimeError("down")
    _stub_sources(monkeypatch, {
        "good": lambda: [_r(title="Good Job", company="X", url="u1")],
        "bad": boom,
    })
    res = js.search_jobs(None, sources=["good", "bad"])
    assert [r.title for r in res] == ["Good Job"]


def test_unknown_source_ignored(monkeypatch):
    _stub_sources(monkeypatch, {"a": lambda: [_r(title="J", company="C", url="u")]})
    assert len(js.search_jobs(None, sources=["a", "nope"])) == 1


# --- GitHub parsing ---------------------------------------------------------


def test_github_listings_json_normalises(monkeypatch):
    sample = [
        {"company_name": "Google", "title": "SWE Intern", "url": "https://g/1",
         "locations": ["Remote", "NYC"], "date_posted": 1700000000, "active": True,
         "is_visible": True, "sponsorship": "Offers Sponsorship", "terms": ["Summer 2026"]},
        {"company_name": "Old", "title": "Closed", "url": "https://g/2",
         "locations": ["SF"], "active": False, "is_visible": True},  # dropped
    ]

    class Resp:
        status_code = 200
        def json(self): return sample
    monkeypatch.setattr(js.httpx, "get", lambda *a, **k: Resp())

    out = js._github_listings_json("Owner/Repo")
    assert len(out) == 1
    j = out[0]
    assert j["title"] == "SWE Intern" and j["company"] == "Google"
    assert j["remote"] is True and "Summer 2026" in j["tags"]
    assert j["source"].endswith("Repo")


def test_github_readme_table_parses(monkeypatch):
    md = """
# Internships
| Company | Role | Location | Application | Date |
| ------- | ---- | -------- | ----------- | ---- |
| **[Stripe](https://stripe.com)** | Backend Intern | Remote | <a href="https://apply/stripe">Apply</a> | Jan 1 |
| ↳ | Frontend Intern | NYC | [Apply](https://apply/stripe2) | Jan 2 |
| **Acme** | SWE | SF | https://apply/acme | Jan 3 |
"""
    class Resp:
        status_code = 200
        text = md
    monkeypatch.setattr(js.httpx, "get", lambda *a, **k: Resp())

    out = js._github_readme_table("Owner/Repo")
    titles = [r["title"] for r in out]
    assert "Backend Intern" in titles and "SWE" in titles
    # "↳" carries the previous company (Stripe).
    frontend = next(r for r in out if r["title"] == "Frontend Intern")
    assert frontend["company"] == "Stripe"
    assert any(r["url"] == "https://apply/stripe" for r in out)
