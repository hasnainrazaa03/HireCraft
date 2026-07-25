"""Job-search normalisation + filtering tests.

The upstream fetch is mocked, so these pin the parts we own: query/remote
filtering, HTML stripping, the limit, and graceful behaviour on an empty upstream.
"""

from __future__ import annotations

import app.services.jobsearch as js

_SAMPLE = [
    {"title": "Senior Python Engineer", "company_name": "Globex", "location": "Berlin",
     "url": "https://x/1", "remote": True, "tags": ["python", "django"],
     "description": "<p>Build <b>APIs</b> with Python.</p>"},
    {"title": "Frontend Developer", "company_name": "Initech", "location": "NYC",
     "url": "https://x/2", "remote": False, "tags": ["react", "typescript"],
     "description": "React role."},
    {"title": "Data Scientist", "company_name": "Acme", "location": "Remote",
     "url": "https://x/3", "remote": True, "tags": ["python", "ml"],
     "description": "ML with Python."},
]


def _stub(monkeypatch, data=_SAMPLE):
    monkeypatch.setattr(js, "_fetch_page", lambda page: data if page == 1 else [])


def test_query_filters_by_title_company_tags(monkeypatch):
    _stub(monkeypatch)
    results = js.search_jobs("python")
    titles = {r.title for r in results}
    assert "Senior Python Engineer" in titles
    assert "Data Scientist" in titles  # matched via the 'python' tag
    assert "Frontend Developer" not in titles


def test_remote_only_filter(monkeypatch):
    _stub(monkeypatch)
    results = js.search_jobs(None, remote_only=True)
    assert all(r.remote for r in results)
    assert len(results) == 2


def test_html_is_stripped_into_snippet(monkeypatch):
    _stub(monkeypatch)
    r = next(r for r in js.search_jobs("django") if r.company == "Globex")
    assert "<" not in r.snippet and ">" not in r.snippet
    assert "Build APIs with Python." in r.snippet


def test_limit_respected(monkeypatch):
    _stub(monkeypatch)
    assert len(js.search_jobs(None, limit=1)) == 1


def test_empty_upstream_is_graceful(monkeypatch):
    _stub(monkeypatch, data=[])
    assert js.search_jobs("anything") == []


def test_result_shape(monkeypatch):
    _stub(monkeypatch)
    r = js.search_jobs("react")[0]
    assert r.source == "Arbeitnow"
    assert r.url.startswith("https://")
    assert isinstance(r.tags, list)
