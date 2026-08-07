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


def test_score_from_report_uses_stored_signals():
    """The application-detail scorecard reads job fit off the guardrail report's
    verified vs. requested keywords — no requirements, no LLM."""
    from app.schemas.tailoring import GuardrailReport
    from app.services.resume_eval import score_from_report

    resume = MasterResume.model_validate(MASTER_RESUME_FIXTURE)
    report = GuardrailReport(
        keywords_requested=["Python", "SQL", "React", "AWS"],
        keywords_verified=["Python", "SQL", "React"],
        violations=[],
    )
    card = score_from_report(resume, report)
    assert card.get("ats") == 75  # 3 of 4 keywords verified
    assert card.get("grounding") == 100  # no error violations
    assert 0 <= card.overall <= 100


def test_compare_reports_overall_and_per_metric_delta():
    before = score_resume(MasterResume.model_validate(MASTER_RESUME_FIXTURE), _req())
    boosted = copy.deepcopy(MASTER_RESUME_FIXTURE)
    boosted["skills"] = [{"category": "Languages", "items": ["Python", "SQL", "React"]}]
    after = score_resume(MasterResume.model_validate(boosted), _req())
    deltas = compare(before, after)
    assert "overall" in deltas and "ats" in deltas
    assert deltas["ats"] >= 0  # added the missing ATS keyword (React)


def _report(requested, verified, *, errors=0):
    from app.schemas.tailoring import GuardrailReport, GuardrailViolation

    violations = [
        GuardrailViolation(severity="error", rule="unsupported", detail=f"claim {i}")
        for i in range(errors)
    ]
    return GuardrailReport(
        keywords_requested=requested, keywords_verified=verified, violations=violations
    )


def test_suggestions_name_the_real_missing_keywords():
    from app.services.resume_eval import suggestions_from_report

    resume = MasterResume.model_validate(MASTER_RESUME_FIXTURE)
    tips = suggestions_from_report(resume, _report(["Python", "Kafka", "Terraform"], ["Python"]))
    kw_tip = next(t for t in tips if t.metric_key == "ats")
    assert "Kafka" in kw_tip.keywords and "Terraform" in kw_tip.keywords
    assert "Kafka" in kw_tip.instruction  # instruction is actionable by the AI
    assert len(tips) <= 3  # capped, weakest-first


def test_suggestions_empty_when_everything_is_strong():
    from app.services.resume_eval import suggestions_from_report

    strong = copy.deepcopy(MASTER_RESUME_FIXTURE)
    strong["experience"][0]["highlights"] = ["Built a dashboard serving 200 daily users worldwide"]
    resume = MasterResume.model_validate(strong)
    tips = suggestions_from_report(resume, _report(["Python"], ["Python"]))
    assert tips == []


def test_inspect_flags_unquantified_and_weak_bullets():
    from app.services.resume_eval import inspect_resume

    fixture = copy.deepcopy(MASTER_RESUME_FIXTURE)
    fixture["experience"][0]["highlights"] = [
        "Responsible for the internal dashboard used by the team",  # weak + no metric
        "Cut build times by 40% across the pipeline",  # strong + metric
    ]
    resume = MasterResume.model_validate(fixture)
    data = inspect_resume(resume, _report(["Python", "Kafka"], ["Python"]))

    assert data["keywords"] == ["Kafka"]
    impact_texts = [b.text for b in data["impact"]]
    verb_texts = [b.text for b in data["verbs"]]
    assert any("Responsible for" in t for t in impact_texts)  # no number → impact
    assert any("Responsible for" in t for t in verb_texts)  # weak opener → verbs
    assert all("Cut build times" not in t for t in impact_texts)  # quantified → clean
    assert all(b.id and b.where for b in data["impact"])  # locatable


def test_company_name_is_not_treated_as_a_keyword():
    from app.services.resume_eval import filter_company_keywords

    assert filter_company_keywords(["Qualcomm"], "Qualcomm") == []
    assert filter_company_keywords(["Qualcomm", "Python", "gRPC"], "Qualcomm") == ["Python", "gRPC"]
    # token-based, so no false positives on real skills that share a substring
    assert filter_company_keywords(["metadata"], "Meta") == ["metadata"]


def test_ats_not_measured_when_only_keyword_was_the_company():
    """The Qualcomm case: the only extracted keyword is the employer name → keyword
    fit is 'not measured' and dropped from the overall, not a misleading 0."""
    from app.services.resume_eval import score_from_report

    resume = MasterResume.model_validate(MASTER_RESUME_FIXTURE)
    report = _report(["Qualcomm"], [])
    card = score_from_report(resume, report, company="Qualcomm")
    ats = next(m for m in card.metrics if m.key == "ats")
    assert ats.measured is False
    # overall must ignore the unmeasured metric (its 0 would otherwise tank it)
    scored = [m for m in card.metrics if m.measured]
    expected = round(sum(m.score * m.weight for m in scored) / sum(m.weight for m in scored))
    assert card.overall == expected
    assert card.overall > 0
