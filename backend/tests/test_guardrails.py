"""Guardrail tests.

These encode HireCraft's central promise: the tailored resume may be reworded,
but it may never assert something the master resume does not support. Each test
below corresponds to a way that promise could be broken.
"""

from __future__ import annotations

from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.schemas.tailoring import TailoringResult
from app.services.llm.guardrails import GuardrailEngine, build_diff


def _apply(
    master: MasterResume, payload: dict, requirements: JobRequirements | None = None
):
    result = TailoringResult.model_validate(payload)
    return GuardrailEngine(master, requirements).apply(result)


def _bullets(resume: MasterResume) -> str:
    return " ".join(h for e in resume.experience for h in e.highlights)


class TestNumericProvenance:
    def test_drops_bullet_with_invented_metric(self, master, experience_id):
        resume, report = _apply(
            master,
            {
                "experience": [
                    {
                        "id": experience_id,
                        "highlights": ["Scaled infrastructure to 5 million requests"],
                    }
                ]
            },
        )
        assert "5 million" not in _bullets(resume)
        assert any(v.kind == "fabricated_number" for v in report.violations)

    def test_month_digits_do_not_license_fake_metrics(self, master, experience_id):
        """Regression: start_date '2024-05' must not authorize a '5 million' claim.

        Date components previously leaked into the pool of allowed numbers, which
        was enough to launder an invented metric past the provenance check.
        """
        resume, _ = _apply(
            master,
            {
                "experience": [
                    {"id": experience_id, "highlights": ["Handled 5 million events"]}
                ]
            },
        )
        assert "5 million" not in _bullets(resume)

    def test_preserves_real_metric(self, master, experience_id):
        resume, report = _apply(
            master,
            {
                "experience": [
                    {
                        "id": experience_id,
                        "highlights": ["Shipped a React dashboard used by 200 users"],
                    }
                ]
            },
        )
        assert "200 users" in _bullets(resume)
        assert not report.has_errors

    def test_reverts_summary_with_invented_number(self, master):
        resume, report = _apply(
            master, {"summary": "Engineer with 7 years of experience."}
        )
        assert resume.basics.summary != "Engineer with 7 years of experience."
        assert report.has_errors


class TestKeywordInjection:
    def test_drops_bullet_claiming_unearned_job_keyword(
        self, master, experience_id, requirements
    ):
        resume, report = _apply(
            master,
            {
                "experience": [
                    {
                        "id": experience_id,
                        "highlights": ["Deployed services on Kubernetes"],
                    }
                ]
            },
            requirements,
        )
        assert "Kubernetes" not in _bullets(resume)
        assert any(v.kind == "unverified_keyword_claim" for v in report.violations)

    def test_keyword_coverage_reflects_reality_not_model_claim(
        self, master, experience_id, requirements
    ):
        _, report = _apply(
            master,
            {
                "experience": [
                    {"id": experience_id, "highlights": ["Wrote Python tooling"]}
                ],
                # The model asserts full coverage; only Python and SQL are real.
                "keywords_used": ["Python", "Kubernetes", "SQL"],
            },
            requirements,
        )
        assert "Kubernetes" not in report.keywords_verified
        assert report.keyword_coverage < 1.0

    def test_short_keyword_is_not_laundered_by_substring_match(
        self, master, experience_id
    ):
        """Regression: a one-letter skill must not count as claimed.

        Provenance used bare substring containment, so "R" matched the "r" in
        "report"/"React" and every résumé appeared to already claim it. The
        keyword-injection guard then had nothing to block, and coverage was
        reported as 100%. Short, ambiguous names are exactly the ones the guard
        exists for.
        """
        requirements = JobRequirements.model_validate(
            {"required_skills": [{"name": "R", "importance": 5}]}
        )
        resume, report = _apply(
            master,
            {
                "experience": [
                    {
                        "id": experience_id,
                        "highlights": ["Wrote R scripts to automate report generation"],
                    }
                ]
            },
            requirements,
        )
        assert "R scripts" not in _bullets(resume)
        assert any(v.kind == "unverified_keyword_claim" for v in report.violations)
        assert report.keywords_verified == []

    def test_genuinely_claimed_skills_still_pass(self, master, experience_id):
        """The boundary rule must not over-block: skills the résumé really lists
        (including punctuated ones like Node.js) stay allowed."""
        requirements = JobRequirements.model_validate(
            {"required_skills": [{"name": "Python"}, {"name": "React"}]}
        )
        engine = GuardrailEngine(master, requirements)
        assert engine.unearned_job_terms == []

        resume, report = _apply(
            master,
            {
                "experience": [
                    {
                        "id": experience_id,
                        "highlights": ["Wrote Python scripts to automate report generation"],
                    }
                ]
            },
            requirements,
        )
        assert "Python" in _bullets(resume)
        assert not any(v.kind == "unverified_keyword_claim" for v in report.violations)

    def test_will_not_add_skill_absent_from_master(self, master, requirements):
        resume, report = _apply(
            master,
            {"skills": [{"category": "Languages", "items": ["Python", "Kubernetes"]}]},
            requirements,
        )
        assert all("Kubernetes" not in g.items for g in resume.skills)
        assert report.has_errors


class TestImmutableFacts:
    def test_employer_title_and_dates_survive(self, master, experience_id):
        resume, _ = _apply(
            master,
            {"experience": [{"id": experience_id, "highlights": ["Rewrote a thing"]}]},
        )
        entry = resume.experience[0]
        assert entry.company == "Acme Corp"
        assert entry.title == "Software Engineering Intern"
        assert entry.start_date == "2024-05"
        assert entry.end_date == "2024-08"

    def test_contact_details_survive(self, master, experience_id):
        resume, _ = _apply(master, {"summary": "Student engineer."})
        assert str(resume.basics.email) == "razam@usc.edu"
        assert resume.basics.name == "Hasnain Raza"

    def test_unknown_entry_id_is_rejected(self, master):
        resume, report = _apply(
            master,
            {"experience": [{"id": "deadbeef1234", "highlights": ["Invented a job"]}]},
        )
        assert len(resume.experience) == 1
        assert any(v.kind == "unknown_entry_id" for v in report.violations)

    def test_education_facts_survive(self, master):
        resume, _ = _apply(master, {"summary": "Student."})
        edu = resume.education[0]
        assert edu.institution == "University of Southern California"
        assert edu.gpa == "3.8"


class TestBulletBudget:
    def test_cannot_inflate_bullet_count(self, master, experience_id):
        resume, report = _apply(
            master,
            {
                "experience": [
                    {
                        "id": experience_id,
                        "highlights": [
                            "Built an internal React dashboard",
                            "Wrote Python automation scripts",
                            "Improved developer workflows",
                            "Documented internal processes",
                        ],
                    }
                ]
            },
        )
        # The master entry has two bullets; tailoring may reword, not multiply.
        assert len(resume.experience[0].highlights) <= 2
        assert any(v.kind == "bullet_count_inflated" for v in report.violations)

    def test_reverts_to_master_when_everything_fails_verification(
        self, master, experience_id
    ):
        resume, report = _apply(
            master,
            {
                "experience": [
                    {
                        "id": experience_id,
                        "highlights": ["Served 900000 concurrent users"],
                    }
                ]
            },
        )
        assert resume.experience[0].highlights == master.experience[0].highlights
        assert any(v.action == "reverted_to_master" for v in report.violations)


class TestHonestTailoring:
    def test_clean_rewrite_produces_no_errors(self, master, experience_id, requirements):
        resume, report = _apply(
            master,
            {
                "summary": "Computer Science student with Python and React experience.",
                "experience": [
                    {
                        "id": experience_id,
                        "highlights": [
                            "Engineered a React dashboard adopted by 200 users",
                            "Automated report generation with Python",
                        ],
                    }
                ],
                "skills": [{"category": "Languages", "items": ["Python", "SQL"]}],
            },
            requirements,
        )
        assert not report.has_errors
        assert "Engineered a React dashboard" in _bullets(resume)

    def test_entry_can_be_hidden_without_deleting_master_data(
        self, master, experience_id
    ):
        resume, _ = _apply(
            master, {"experience": [{"id": experience_id, "include": False}]}
        )
        assert resume.experience == []
        assert len(master.experience) == 1


class TestConfidence:
    """Guardrails v2 — the per-bullet truthfulness verdict."""

    def test_verbatim_bullet_is_verified(self, master, experience_id):
        # Keep one master bullet exactly as-is.
        original = master.experience[0].highlights[0]
        _, report = _apply(
            master, {"experience": [{"id": experience_id, "highlights": [original]}]}
        )
        verdicts = {c.text: c.confidence for c in report.bullet_confidence}
        assert verdicts[original] == "verified"

    def test_clean_rewrite_is_likely(self, master, experience_id):
        _, report = _apply(
            master,
            {"experience": [{"id": experience_id, "highlights": ["Engineered a React dashboard used by 200 users"]}]},
        )
        assert any(c.confidence == "likely" for c in report.bullet_confidence)

    def test_fabricated_bullet_is_blocked(self, master, experience_id):
        _, report = _apply(
            master,
            {"experience": [{"id": experience_id, "highlights": ["Scaled to 9000000 requests per second"]}]},
        )
        blocked = [c for c in report.bullet_confidence if c.confidence == "blocked"]
        assert blocked and "9000000" in blocked[0].reason

    def test_injected_keyword_is_blocked(self, master, experience_id, requirements):
        _, report = _apply(
            master,
            {"experience": [{"id": experience_id, "highlights": ["Deployed services on Kubernetes"]}]},
            requirements,
        )
        assert any(
            c.confidence == "blocked" and "Kubernetes" in c.reason
            for c in report.bullet_confidence
        )

    def test_report_lists_locked_facts(self, master):
        _, report = _apply(master, {})
        assert report.locks  # employers, dates, schools, etc.
        assert any("Employers" in lock for lock in report.locks)

    def test_untouched_bullets_are_still_verified(self, master):
        """Regression: when the model rewrites nothing, the confidence report
        must still cover every bullet in the final résumé (as Verified), not be
        empty."""
        resume, report = _apply(master, {})  # model returned nothing
        final_bullets = [h for e in resume.experience for h in e.highlights]
        assert final_bullets  # the master's bullets survive
        assert len(report.bullet_confidence) == len(final_bullets)
        assert all(c.confidence == "verified" for c in report.bullet_confidence)

    def test_no_duplicate_verdicts_for_rewritten_bullet(self, master, experience_id):
        """A bullet vetted during rewrite must not also be backfilled."""
        _, report = _apply(
            master,
            {"experience": [{"id": experience_id, "highlights": ["Engineered a React dashboard used by 200 users"]}]},
        )
        texts = [c.text for c in report.bullet_confidence]
        assert len(texts) == len(set(texts))  # no dupes


class TestDiff:
    def test_detects_modified_highlights(self, master, experience_id):
        resume, _ = _apply(
            master,
            {
                "experience": [
                    {
                        "id": experience_id,
                        "highlights": ["Engineered a React dashboard for 200 users"],
                    }
                ]
            },
        )
        diff = build_diff(master, resume)
        assert any(d.field == "highlights" and d.change == "modified" for d in diff)

    def test_unchanged_resume_produces_empty_diff(self, master):
        resume, _ = _apply(master, {})
        assert build_diff(master, resume) == []


class TestEntryIdentity:
    """Entry ids are the merge key, so a collision silently cross-contaminates."""

    def _twins(self) -> MasterResume:
        # Same name, no dates: identical inputs to the id hash.
        return MasterResume.model_validate(
            {
                "basics": {"name": "Jane Doe", "email": "jane@example.com"},
                "projects": [
                    {"name": "Portfolio Site", "highlights": ["Built a site in React"]},
                    {"name": "Portfolio Site", "highlights": ["Wrote a Python CLI"]},
                ],
            }
        )

    def test_entries_sharing_factual_fields_get_distinct_ids(self):
        resume = self._twins()
        assert resume.projects[0].id != resume.projects[1].id

    def test_tailoring_one_entry_does_not_overwrite_its_twin(self):
        """Regression: colliding ids made the merge apply one entry's rewritten
        bullets to the other, so content from one project appeared under a
        different one - a fabrication the numeric checks cannot catch, because
        every number really does exist somewhere in the résumé."""
        resume = self._twins()
        merged, _ = _apply(
            resume,
            {
                "projects": [
                    {"id": resume.projects[0].id, "highlights": ["Built a site in React"]}
                ]
            },
        )
        assert merged.projects[0].highlights == ["Built a site in React"]
        assert merged.projects[1].highlights == ["Wrote a Python CLI"]


class TestExcludedEntries:
    def test_an_excluded_entry_reports_nothing(self, master, experience_id, requirements):
        """Regression: entries the model drops with include=False were still
        vetted, so violations and per-bullet verdicts were filed against a role
        the tailored résumé does not contain. The user was told a claim had been
        blocked on an entry they were never going to send, and the headline
        "claims blocked" count was inflated by it."""
        resume, report = _apply(
            master,
            {
                "experience": [
                    {
                        "id": experience_id,
                        "include": False,
                        "highlights": ["Deployed services on Kubernetes"],
                    }
                ]
            },
            requirements,
        )
        assert resume.experience == []
        assert report.violations == []
        assert report.bullet_confidence == []
