"""Job-match and skill-gap tests.

The match score carries a headline number the user will trust, so its pieces are
pinned: skills coverage is importance-weighted, a covered keyword counts, missing
high-priority skills show up as gaps, and the aggregate gap report ranks by
real demand across jobs.
"""

from __future__ import annotations

import pytest

from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.services.matching import match_resume_to_job, skill_gaps
from tests.conftest import MASTER_RESUME_FIXTURE


@pytest.fixture
def resume() -> MasterResume:
    # Has: React, Python (experience), Python/JavaScript/SQL (skills), 3 months exp.
    return MasterResume.model_validate(MASTER_RESUME_FIXTURE)


def _req(**kw) -> JobRequirements:
    return JobRequirements.model_validate(kw)


def test_perfect_skill_match_scores_high(resume):
    req = _req(
        required_skills=[{"name": "Python", "importance": 5}, {"name": "SQL", "importance": 4}],
        ats_keywords=["Python", "SQL"],
    )
    match = match_resume_to_job(resume, req)
    assert match.overall_score >= 80
    assert match.verdict == "Strong match"
    assert {h.name for h in match.matched_skills} == {"Python", "SQL"}
    assert match.missing_skills == []


def test_missing_high_priority_skill_becomes_a_gap(resume):
    req = _req(
        required_skills=[
            {"name": "Python", "importance": 5},
            {"name": "Kubernetes", "importance": 5},
        ],
        ats_keywords=["Python", "Kubernetes"],
    )
    match = match_resume_to_job(resume, req)
    assert any(h.name == "Kubernetes" for h in match.missing_skills)
    assert "Kubernetes" in match.missing_keywords
    assert any("Kubernetes" in g for g in match.gaps)
    assert match.overall_score < 80  # a key miss pulls it down


def test_importance_weighting(resume):
    # Missing a low-importance skill should hurt less than missing a critical one.
    minor = match_resume_to_job(
        resume,
        _req(required_skills=[{"name": "Python", "importance": 5}, {"name": "Rust", "importance": 1}]),
    )
    major = match_resume_to_job(
        resume,
        _req(required_skills=[{"name": "Python", "importance": 1}, {"name": "Rust", "importance": 5}]),
    )
    assert minor.subscores[0].score > major.subscores[0].score


def test_experience_shortfall_is_flagged(resume):
    req = _req(
        required_skills=[{"name": "Python", "importance": 3}],
        min_years_experience=5,
    )
    match = match_resume_to_job(resume, req)
    exp = next(s for s in match.subscores if s.key == "experience")
    assert exp.score < 100
    assert any("yrs" in g or "experience" in g.lower() for g in match.gaps)


def test_no_requirements_does_not_crash(resume):
    match = match_resume_to_job(resume, _req())
    assert 0 <= match.overall_score <= 100
    assert match.matched_skills == [] and match.missing_skills == []


def test_subscore_weights_sum_to_one(resume):
    match = match_resume_to_job(resume, _req(required_skills=[{"name": "Python", "importance": 3}]))
    assert round(sum(s.weight for s in match.subscores), 3) == 1.0


def test_skill_gaps_ranks_by_demand(resume):
    jobs = [
        _req(required_skills=[{"name": "Kubernetes", "importance": 5}, {"name": "Python", "importance": 3}]),
        _req(required_skills=[{"name": "Kubernetes", "importance": 4}]),
        _req(required_skills=[{"name": "Go", "importance": 3}]),
    ]
    report = skill_gaps(resume, jobs)
    assert report.jobs_analyzed == 3
    # Kubernetes is demanded by 2 jobs and the résumé lacks it → top missing.
    assert report.top_missing[0].name == "Kubernetes"
    assert report.top_missing[0].demand == 2
    # Python is demanded and present → covered, not missing.
    assert any(d.name == "Python" for d in report.covered)
    assert all(d.name != "Python" for d in report.top_missing)
    assert report.average_match is not None


def test_skill_gaps_empty_is_safe(resume):
    report = skill_gaps(resume, [])
    assert report.jobs_analyzed == 0
    assert report.average_match is None
    assert report.top_missing == []
