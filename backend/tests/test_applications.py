"""Application report generation tests.

The downloadable package includes a plain-text report so the bundle is
self-documenting. It must faithfully reflect the guardrail record — keyword
coverage, blocked claims, and locked facts — rather than gloss over them.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.api.routes.applications import _build_report
from app.models.application import TrackerStatus


def _application(guardrail_report=None, title="Backend Engineer", company="Globex"):
    return SimpleNamespace(
        job=SimpleNamespace(title=title, company=company),
        tracker_status=TrackerStatus.INTERVIEWING,
        guardrail_report=guardrail_report,
    )


def test_report_includes_role_company_and_stage():
    text = _build_report(_application())
    assert "Backend Engineer" in text
    assert "Globex" in text
    assert "interviewing" in text


def test_report_summarizes_keyword_coverage():
    text = _build_report(
        _application(
            guardrail_report={
                "keywords_requested": ["Python", "Kubernetes", "SQL"],
                "keywords_verified": ["Python", "SQL"],
            }
        )
    )
    assert "2/3" in text
    assert "Kubernetes" in text  # listed as not backed by the résumé


def test_report_lists_blocked_claims():
    text = _build_report(
        _application(
            guardrail_report={
                "violations": [
                    {"severity": "error", "detail": "Dropped invented metric '5M users'"},
                    {"severity": "warning", "detail": "verify this"},
                ]
            }
        )
    )
    assert "blocked" in text.lower()
    assert "5M users" in text


def test_report_handles_missing_job_and_empty_guardrails():
    app = SimpleNamespace(
        job=None, tracker_status=TrackerStatus.WISHLIST, guardrail_report=None
    )
    text = _build_report(app)
    assert "Untitled role" in text
    assert "wishlist" in text
