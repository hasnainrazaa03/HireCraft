"""Résumé scoring tests.

Every score is a deterministic rule, so these assert concrete behavior: a
metric-free bullet lowers quantification and produces a finding, a weak opener
is flagged, a strong quantified bullet scores well, and the ATS checks reflect
what's actually present.
"""

from __future__ import annotations

from app.schemas.resume import MasterResume
from app.services.analysis import (
    _has_number,
    _is_action_verb,
    analyze_resume,
)


def _resume(**over) -> MasterResume:
    base = {
        "basics": {
            "name": "Jane Candidate",
            "email": "jane@usc.edu",
            "location": "Los Angeles, CA",
            "linkedin": "https://linkedin.com/in/jane",
            "summary": "CS student focused on backend systems.",
        },
        "experience": [
            {
                "company": "Acme",
                "title": "SWE Intern",
                "start_date": "2024-05",
                "end_date": "2024-08",
                "highlights": ["Built a dashboard adopted by 200 users"],
            }
        ],
        "education": [
            {"institution": "USC", "degree": "BS", "start_date": "2022", "end_date": "2026"}
        ],
        "skills": [{"category": "Languages", "items": ["Python", "SQL"]}],
    }
    base.update(over)
    return MasterResume.model_validate(base)


class TestHelpers:
    def test_has_number(self):
        assert _has_number("served 200 users")
        assert _has_number("cut cost by 40%")
        assert _has_number("$2M in savings")
        assert not _has_number("improved performance")

    def test_action_verb_detection(self):
        assert _is_action_verb("built")
        assert _is_action_verb("engineered")
        assert _is_action_verb("optimized")
        assert not _is_action_verb("responsible")
        assert not _is_action_verb("the")


class TestScoring:
    def test_quantified_strong_bullet_scores_well(self):
        a = analyze_resume(_resume())
        # One bullet: has a number and leads with "Built".
        quant = next(m for m in a.metrics if m.key == "quantification")
        verbs = next(m for m in a.metrics if m.key == "action_verbs")
        assert quant.score == 100
        assert verbs.score == 100
        assert a.quantified_bullets == 1

    def test_missing_metric_lowers_score_and_adds_finding(self):
        a = analyze_resume(
            _resume(
                experience=[
                    {
                        "company": "Acme",
                        "title": "Intern",
                        "start_date": "2024",
                        "highlights": ["Improved the codebase"],  # no metric
                    }
                ]
            )
        )
        quant = next(m for m in a.metrics if m.key == "quantification")
        assert quant.score == 0
        assert any(f.category == "missing_metric" for f in a.findings)

    def test_weak_opener_is_flagged(self):
        a = analyze_resume(
            _resume(
                experience=[
                    {
                        "company": "Acme",
                        "title": "Intern",
                        "start_date": "2024",
                        "highlights": ["Responsible for maintaining 3 services"],
                    }
                ]
            )
        )
        assert any(f.category == "weak_opener" for f in a.findings)

    def test_missing_sections_flagged_and_lower_completeness(self):
        bare = MasterResume.model_validate(
            {
                "basics": {"name": "X", "email": "x@y.co"},  # no summary, links, location
                "experience": [
                    {"company": "A", "title": "B", "start_date": "2024", "highlights": ["Built X for 5 teams"]}
                ],
                # no education, no skills
            }
        )
        a = analyze_resume(bare)
        comp = next(m for m in a.metrics if m.key == "completeness")
        assert comp.score < 100
        cats = {f.category for f in a.findings}
        assert "missing_section" in cats

    def test_repeated_verb_flagged(self):
        a = analyze_resume(
            _resume(
                experience=[
                    {
                        "company": "Acme",
                        "title": "Intern",
                        "start_date": "2024",
                        "highlights": [
                            "Built service A for 10 users",
                            "Built service B for 20 users",
                            "Built service C for 30 users",
                        ],
                    }
                ]
            )
        )
        assert any(f.category == "repeated_verb" for f in a.findings)

    def test_overall_grade_bands(self):
        good = analyze_resume(_resume())
        assert good.overall_score >= 50
        assert good.grade in ("Excellent", "Strong", "Fair", "Needs work")

    def test_ats_checks_reflect_content(self):
        a = analyze_resume(_resume())
        by_name = {c.name: c.passed for c in a.ats_checks}
        assert by_name["Contact email present"] is True
        assert by_name["Skills section for keyword matching"] is True
        assert 0 <= a.ats_score <= 100

    def test_long_resume_is_flagged_as_lengthy(self):
        many = [
            {
                "company": f"Co{i}",
                "title": "Engineer",
                "start_date": "2020",
                "end_date": "2024",
                "highlights": [f"Shipped feature {j} used by {j*10} people" for j in range(6)],
            }
            for i in range(8)  # 8 roles × 6 bullets = 48 bullets -> well over 2 pages
        ]
        a = analyze_resume(_resume(experience=many))
        assert a.estimated_pages > 2
        assert any(f.category == "length" for f in a.findings)
