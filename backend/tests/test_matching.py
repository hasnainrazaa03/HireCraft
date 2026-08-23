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


def test_quick_match_scores_by_skill_overlap(resume):
    from app.services.matching import quick_match_score
    # The résumé has Python + SQL; a job mentioning both scores higher than one
    # mentioning neither.
    hi, matched = quick_match_score(resume, "We need Python and SQL and React and more.")
    lo, _ = quick_match_score(resume, "We need a plumber with welding experience.")
    assert hi > lo
    assert "Python" in matched
    assert 0 <= lo <= 100 and 0 <= hi <= 100


def test_quick_match_no_overlap_is_low(resume):
    from app.services.matching import quick_match_score
    score, matched = quick_match_score(resume, "Bäckerei sucht Verkäufer in Berlin.")
    assert matched == []
    assert score <= 20


def test_analyze_job_fit_splits_strengths_and_gaps(resume):
    from app.services.matching import analyze_job_fit
    # Résumé has Python + SQL; the job also wants Kubernetes + AWS (which it lacks).
    fit = analyze_job_fit(resume, "Backend role needing Python, SQL, Kubernetes, AWS, Docker.")
    assert "Python" in fit.strengths
    assert "Kubernetes" in fit.gaps and "AWS" in fit.gaps
    assert 0 <= fit.score <= 100
    assert fit.verdict in {"Excellent Match", "Great Match", "Good Match", "Fair Match"}
    assert fit.interview_chance in {"High", "Medium", "Low"}
    assert fit.summary


def test_analyze_job_fit_no_tech_is_graceful(resume):
    from app.services.matching import analyze_job_fit
    fit = analyze_job_fit(resume, "A friendly bakery seeks a morning shift helper.")
    assert 0 <= fit.score <= 100
    assert fit.summary  # still writes a summary


def test_a_lone_matching_keyword_does_not_score_100(resume):
    """The old bug: a posting naming one skill you have (here the letter 'R',
    inside an unrelated SEO role) scored a perfect match. Shrinkage + title
    alignment must keep it well below a genuine fit."""
    from app.services.matching import analyze_job_fit
    seo = analyze_job_fit(
        resume,
        "Manager Search Content SEO GEO. Own the content strategy. R and planning.",
        title="Manager Search Content - SEO & GEO (m/w/d)",
    )
    assert seo.score < 50  # not the old 100%


def test_relevant_title_outscores_keyword_coincidence(resume):
    """A role in the candidate's domain must beat an off-domain role that merely
    happens to name a skill they have — the exact inversion we're fixing."""
    from app.services.matching import analyze_job_fit
    swe = analyze_job_fit(
        resume,
        "Software Engineer. Build backend services in Python and SQL on the web.",
        title="Software Engineer",
    )
    seo = analyze_job_fit(
        resume,
        "SEO content manager. Editorial calendar and keyword research. Uses R.",
        title="Manager Search Content - SEO & GEO",
    )
    assert swe.score > seo.score
    assert swe.score >= 50 and seo.score < 45


def test_default_search_query_from_recent_title(resume):
    """With no headline, the recommended feed keys off the most recent title,
    stripped of seniority words."""
    from app.services.matching import default_search_query
    q = default_search_query(resume)
    assert "software" in q and "engineering" in q
    assert "intern" not in q  # seniority word dropped


def test_default_search_query_prefers_headline_role():
    """A headline's leading role phrase wins over history."""
    from app.schemas.resume import MasterResume
    from app.services.matching import default_search_query
    data = {**MASTER_RESUME_FIXTURE}
    data["basics"] = {**data["basics"],
                      "headline": "Machine Learning Engineer specializing in NLP systems"}
    q = default_search_query(MasterResume.model_validate(data))
    assert q == "machine learning engineer"


def test_title_alignment_lifts_the_score(resume):
    """The same body scores higher under an on-domain title than an off-domain
    one — title/domain alignment is doing real work, not just the body text."""
    from app.services.matching import analyze_job_fit
    body = "You will write Python and SQL and collaborate across the team."
    on = analyze_job_fit(resume, f"Software Engineer. {body}", title="Software Engineer")
    off = analyze_job_fit(resume, f"Warehouse Associate. {body}", title="Warehouse Associate")
    assert on.score > off.score


def test_claims_resolves_semantic_and_plural_skills():
    """Demonstrated skills count even when the exact umbrella keyword is absent:
    REST work ⇒ 'REST APIs', MongoDB ⇒ 'NoSQL', latency/quantization ⇒
    'Performance optimization'. Genuine gaps stay gaps."""
    import copy

    from app.services.matching import _claims, _skill_index

    data = copy.deepcopy(MASTER_RESUME_FIXTURE)
    exp = data["experience"][0]
    exp["highlights"] = list(exp.get("highlights", [])) + [
        "Built a REST API orchestration layer across internal services",
        "Cut inference latency with INT8 quantization and lifted throughput",
    ]
    exp["technologies"] = list(exp.get("technologies", [])) + ["MongoDB"]
    resume = MasterResume.model_validate(data)
    corpus, vocab = _skill_index(resume)

    assert _claims("REST APIs", corpus, vocab)  # ← "REST API" (singular) in résumé
    assert _claims("NoSQL", corpus, vocab)  # ← MongoDB
    assert _claims("Performance optimization", corpus, vocab)  # ← latency/quantization
    # Genuine gaps must remain gaps — no over-crediting.
    assert not _claims("Kubernetes", corpus, vocab)
    assert not _claims("Kafka", corpus, vocab)
    assert not _claims("AWS", corpus, vocab)


def _ml_resume() -> MasterResume:
    """An ML engineer whose past job TITLES are generic ("Software Engineer
    Intern", "Technology Analyst") — the case that exposed the scoring bugs."""
    import copy

    data = copy.deepcopy(MASTER_RESUME_FIXTURE)
    data["basics"]["headline"] = None
    data["basics"]["summary"] = None
    data["experience"][0]["title"] = "AI Software Engineer Intern"
    data["skills"] = [
        {"category": "ML & Deep Learning", "items": ["PyTorch", "YOLO11", "DistilBERT"]},
        {"category": "CV & NLP", "items": ["Object Detection", "Slot Filling"]},
    ]
    return MasterResume.model_validate(data)


def test_a_description_less_posting_cannot_top_a_real_match():
    """Aggregator feeds carry title/company/location and no description. Scoring
    the bare title as if it were the body made a generic 'Junior Software
    Engineer' outrank every genuinely matching posting in the feed."""
    from app.services.matching import analyze_job_fit

    resume = _ml_resume()
    ml_jd = (
        "Machine Learning Engineer to build and deploy deep learning models with "
        "PyTorch, computer vision, model training and evaluation, served in "
        "production with Docker. Requires Python and strong ML fundamentals."
    )
    bare = analyze_job_fit(resume, "Junior Software Engineer", title="Junior Software Engineer")
    real = analyze_job_fit(resume, f"Machine Learning Engineer\n{ml_jd}", title="Machine Learning Engineer")
    assert real.score > bare.score
    # And the thin one is explicitly low-confidence.
    assert bare.factors["confidence"] < real.factors["confidence"]


def test_generic_role_words_are_not_a_perfect_title_match():
    """'Software Engineer' is two words nearly every engineering résumé contains,
    so matching them must not read as a perfect domain alignment."""
    from app.services.matching import analyze_job_fit

    resume = _ml_resume()
    generic = analyze_job_fit(resume, "Software Engineer", title="Software Engineer")
    assert generic.factors["title_alignment"] <= 65.0


def test_role_profile_knows_the_candidate_does_ml():
    """The domain lives in the skill GROUP names and the títle's non-noise words;
    without them an ML résumé held no trace of 'learning' at all."""
    from app.services.matching import _role_profile

    profile = _role_profile(_ml_resume())
    assert "learning" in profile  # from the "ML & Deep Learning" group
    assert "ai" in profile  # from the real part of the job title
    # Employment-shape words must not crowd out the domain.
    assert "intern" not in profile
