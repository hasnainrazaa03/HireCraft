"""Résumé eval rubric: the deterministic scorers behave and rank sensibly."""

from __future__ import annotations

import copy

from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.services.resume_eval import compare, score_resume
from tests.conftest import MASTER_RESUME_FIXTURE


def _req() -> JobRequirements:
    return JobRequirements(
        title="Backend Engineer",
        required_skills=[{"name": "Python", "importance": 5}],
        ats_keywords=["Python", "SQL", "React"],
    )


def test_scorecard_has_all_metrics_and_bounded_overall():
    card = score_resume(MasterResume.model_validate(MASTER_RESUME_FIXTURE), _req())
    keys = {m.key for m in card.metrics}
    assert keys == {"relevance", "ats", "impact", "verbs", "conciseness", "grounding"}
    assert 0 <= card.overall <= 100
    assert all(0 <= m.score <= 100 for m in card.metrics)


def test_weak_openers_lower_verb_strength():
    strong = MASTER_RESUME_FIXTURE
    weak = copy.deepcopy(MASTER_RESUME_FIXTURE)
    weak["experience"][0]["highlights"] = [
        "Responsible for the dashboard",
        "Worked on Python scripts",
    ]
    s = score_resume(MasterResume.model_validate(strong), _req())
    w = score_resume(MasterResume.model_validate(weak), _req())
    assert w.get("verbs") < s.get("verbs")


def test_metric_bullet_raises_impact_score():
    no_metric = copy.deepcopy(MASTER_RESUME_FIXTURE)
    no_metric["experience"][0]["highlights"] = ["Built an internal dashboard for the team"]
    with_metric = copy.deepcopy(MASTER_RESUME_FIXTURE)
    with_metric["experience"][0]["highlights"] = ["Built a dashboard serving 200 daily users"]
    lo = score_resume(MasterResume.model_validate(no_metric), _req())
    hi = score_resume(MasterResume.model_validate(with_metric), _req())
    assert hi.get("impact") > lo.get("impact")


def test_compare_reports_overall_and_per_metric_delta():
    before = score_resume(MasterResume.model_validate(MASTER_RESUME_FIXTURE), _req())
    boosted = copy.deepcopy(MASTER_RESUME_FIXTURE)
    boosted["skills"] = [{"category": "Languages", "items": ["Python", "SQL", "React"]}]
    after = score_resume(MasterResume.model_validate(boosted), _req())
    deltas = compare(before, after)
    assert "overall" in deltas and "ats" in deltas
    assert deltas["ats"] >= 0  # added the missing ATS keyword (React)
