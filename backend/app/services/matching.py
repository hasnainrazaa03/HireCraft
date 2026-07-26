"""Deterministic job-match scoring and skill-gap analysis.

No LLM: the fit score is derived from concrete overlaps between the résumé and a
job's extracted requirements, so it is reproducible and explainable. The same
skill-detection logic backs both the per-job match and the cross-job gap report.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from app.schemas.job import JobRequirements, Skill
from app.schemas.matching import (
    JobMatch,
    SkillDemand,
    SkillGapReport,
    SkillHit,
    SubScore,
)
from app.schemas.resume import MasterResume

_TOKEN = re.compile(r"[a-z0-9+#.]+")


def _tokens(text: str) -> set[str]:
    return set(_TOKEN.findall(text.lower()))


def _resume_corpus(resume: MasterResume) -> str:
    parts: list[str] = [resume.basics.headline or "", resume.basics.summary or ""]
    for e in resume.experience:
        parts += [e.title, e.company, *e.highlights, *e.technologies]
    for p in resume.projects:
        parts += [p.name, p.description or "", *p.highlights, *p.technologies]
    for ed in resume.education:
        parts += [ed.degree, ed.field_of_study or "", *ed.coursework, *ed.highlights]
    for g in resume.skills:
        parts += [g.category, *g.items]
    return " ".join(parts)


def _skill_index(resume: MasterResume) -> tuple[str, set[str]]:
    corpus = _resume_corpus(resume).lower()
    return corpus, _tokens(corpus)


def _resume_skills(resume: MasterResume) -> set[str]:
    """The candidate's concrete skills + technologies — what a job can 'match'."""
    skills = {item for g in resume.skills for item in g.items}
    skills |= {t for e in resume.experience for t in e.technologies}
    skills |= {t for p in resume.projects for t in p.technologies}
    return {s for s in skills if s.strip()}


def quick_match_score(resume: MasterResume, job_text: str) -> tuple[int, list[str]]:
    """A lightweight, LLM-free fit signal for job-search results.

    The board gives us no structured requirements, so we approximate: how many of
    the candidate's real skills the posting mentions. Returns (0–100, matched
    skills). It's a rough relevance hint, not the full job-match analysis.
    """
    job = job_text.lower()
    job_vocab = _tokens(job)
    matched: list[str] = []
    for skill in _resume_skills(resume):
        needle = skill.strip().lower()
        parts = _tokens(needle)
        if _term_present(job, needle) or (parts and parts.issubset(job_vocab)):
            matched.append(skill)
    matched = sorted(set(matched), key=str.lower)
    # 0 hits reads as a weak fit, ~5+ as a strong one.
    score = min(100, max(12, len(matched) * 20))
    return score, matched[:8]


# A curated vocabulary of skills/tools a posting is likely to name. Detecting
# these in the job text lets us split the requirements the candidate *has*
# (strengths) from the ones they *lack* (gaps) — the heart of the fit summary.
TECH_VOCAB: tuple[str, ...] = (
    "Python", "Java", "JavaScript", "TypeScript", "Go", "Rust", "C++", "C#", "Ruby",
    "Scala", "Kotlin", "Swift", "PHP", "R", "MATLAB", "SQL", "Bash",
    "React", "Vue", "Angular", "Next.js", "Node.js", "Django", "Flask", "FastAPI",
    "Spring", "Rails", "Express", "GraphQL", "REST", "gRPC",
    "PostgreSQL", "MySQL", "MongoDB", "Redis", "Elasticsearch", "Cassandra",
    "Kafka", "RabbitMQ", "Snowflake", "Spark", "Hadoop", "Airflow", "dbt",
    "AWS", "GCP", "Azure", "Docker", "Kubernetes", "Terraform", "CI/CD", "Jenkins",
    "Linux", "Git", "Microservices", "System Design", "Distributed Systems",
    "Machine Learning", "Deep Learning", "NLP", "Computer Vision", "PyTorch",
    "TensorFlow", "Scikit-learn", "Pandas", "NumPy", "LLM", "Transformers",
    "Data Engineering", "ETL", "Data Pipelines", "Tableau", "Power BI",
    "Agile", "Scrum", "TDD", "Selenium", "Playwright",
)


@dataclass
class JobFit:
    score: int
    verdict: str
    strengths: list[str]
    gaps: list[str]
    interview_chance: str  # High | Medium | Low
    summary: str


def _term_present(job_lower: str, term: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(term.lower())}(?![a-z0-9])", job_lower) is not None


def analyze_job_fit(resume: MasterResume, job_text: str) -> JobFit:
    """Deterministic, LLM-free fit analysis for a job posting: a fit score,
    the requirements the candidate has vs. lacks, and a plain-language summary —
    so a job card can answer 'should I apply, and why?' with no API call."""
    corpus, vocab = _skill_index(resume)
    job = job_text.lower()

    present = [t for t in TECH_VOCAB if _term_present(job, t)]
    strengths = [t for t in present if _claims(t, corpus, vocab)]
    gaps = [t for t in present if not _claims(t, corpus, vocab)]

    if present:
        score = round(len(strengths) / len(present) * 100)
    else:
        # No recognised tech named — fall back to raw résumé-skill overlap.
        score = quick_match_score(resume, job_text)[0]
    score = max(12, min(100, score))

    verdict = (
        "Excellent Match" if score >= 85
        else "Great Match" if score >= 70
        else "Good Match" if score >= 50
        else "Fair Match"
    )
    chance = "High" if score >= 72 else "Medium" if score >= 50 else "Low"
    return JobFit(
        score=score,
        verdict=verdict,
        strengths=strengths[:8],
        gaps=gaps[:6],
        interview_chance=chance,
        summary=_fit_summary(score, strengths, gaps),
    )


def _fit_summary(score: int, strengths: list[str], gaps: list[str]) -> str:
    top = ", ".join(strengths[:2]) if strengths else "your background"
    miss = ", ".join(gaps[:2])
    if score >= 85:
        base = f"Excellent fit — your {top} lines up with what they're asking for."
    elif score >= 70:
        base = f"Strong match. Your {top} experience fits this role well."
    elif score >= 50:
        base = f"Decent fit — you bring {top}, with a few gaps to close."
    else:
        base = (
            f"Lighter fit — this role leans on {miss or 'skills'} your résumé doesn't emphasize yet."
            if gaps else "Lighter fit for your current résumé."
        )
    if gaps and score >= 50:
        base += f" Worth adding: {miss}."
    return base


def _claims(term: str, corpus_lower: str, vocab: set[str]) -> bool:
    """Does the résumé support this skill/keyword? Whole-term phrase match, or
    token-subset — the same rule the guardrails use for provenance.

    The phrase match is boundary-anchored, not a bare substring: "R" is inside
    "Resolved", "Go" inside "Google", and "REST" inside "interest", so plain
    containment scored every résumé as having them and inflated the fit score.
    """
    needle = term.strip().lower()
    if not needle:
        return False
    if _term_present(corpus_lower, needle):
        return True
    parts = _tokens(needle)
    return bool(parts) and parts.issubset(vocab)


def _estimate_years(resume: MasterResume) -> float:
    """Rough professional experience, in years, summed across dated roles.

    Non-overlapping is not assumed away — overlapping internships slightly inflate
    the figure, which is acceptable for a heuristic seniority check.
    """
    total_months = 0
    for e in resume.experience:
        start = _parse_month(e.start_date)
        if start is None:
            continue
        end = _parse_month(e.end_date) or date.today()
        months = (end.year - start.year) * 12 + (end.month - start.month)
        total_months += max(months, 0)
    return round(total_months / 12, 1)


def _parse_month(value: str | None) -> date | None:
    if not value or value == "Present":
        return None
    m = re.match(r"(\d{4})(?:-(\d{1,2}))?", value)
    if not m:
        return None
    year = int(m.group(1))
    month = int(m.group(2)) if m.group(2) else 1
    if not (1 <= month <= 12):
        month = 1
    return date(year, month, 1)


def _clamp(value: float) -> int:
    return max(0, min(100, round(value)))


def match_resume_to_job(resume: MasterResume, requirements: JobRequirements) -> JobMatch:
    corpus, vocab = _skill_index(resume)

    def hit(skill: Skill) -> SkillHit:
        return SkillHit(
            name=skill.name,
            importance=skill.importance,
            have=_claims(skill.name, corpus, vocab),
        )

    required = [hit(s) for s in requirements.required_skills]
    preferred = [hit(s) for s in requirements.preferred_skills]
    all_hits = required + preferred
    matched = [h for h in all_hits if h.have]
    missing = [h for h in all_hits if not h.have]

    # --- Skills sub-score: importance-weighted coverage, preferred counts half.
    def weighted(hits: list[SkillHit], factor: float) -> tuple[float, float]:
        got = sum(h.importance * factor for h in hits if h.have)
        total = sum(h.importance * factor for h in hits)
        return got, total
    rg, rt = weighted(required, 1.0)
    pg, pt = weighted(preferred, 0.5)
    skills_total = rt + pt
    skills_score = _clamp((rg + pg) / skills_total * 100) if skills_total else 100

    # --- Keyword sub-score.
    keywords = requirements.ats_keywords
    matched_kw = [k for k in keywords if _claims(k, corpus, vocab)]
    missing_kw = [k for k in keywords if k not in matched_kw]
    keyword_score = _clamp(len(matched_kw) / len(keywords) * 100) if keywords else 100

    # --- Experience sub-score.
    years = _estimate_years(resume)
    need_years = requirements.min_years_experience
    if need_years and need_years > 0:
        experience_score = _clamp(min(years / need_years, 1.0) * 100)
        exp_detail = f"~{years} yrs experience vs {need_years} asked"
    else:
        experience_score = 100
        exp_detail = f"~{years} yrs experience; no minimum stated"

    # --- Education sub-score (light heuristic).
    education_score, edu_detail = _education_score(resume, requirements)

    subscores = [
        SubScore(key="skills", label="Skills", score=skills_score, weight=0.5,
                 detail=f"{len(matched)}/{len(all_hits)} listed skills matched"
                 if all_hits else "No specific skills extracted"),
        SubScore(key="keywords", label="ATS keywords", score=keyword_score, weight=0.2,
                 detail=f"{len(matched_kw)}/{len(keywords)} keywords covered"
                 if keywords else "No keywords extracted"),
        SubScore(key="experience", label="Experience", score=experience_score,
                 weight=0.2, detail=exp_detail),
        SubScore(key="education", label="Education", score=education_score,
                 weight=0.1, detail=edu_detail),
    ]
    overall = _clamp(sum(s.score * s.weight for s in subscores))
    verdict = (
        "Strong match" if overall >= 80
        else "Good match" if overall >= 65
        else "Fair match" if overall >= 45
        else "Reach"
    )

    strengths, gaps = _explain(matched, missing, matched_kw, missing_kw, years, need_years)

    # Surface most-important items first.
    matched.sort(key=lambda h: -h.importance)
    missing.sort(key=lambda h: -h.importance)
    return JobMatch(
        overall_score=overall,
        verdict=verdict,
        subscores=subscores,
        matched_skills=matched,
        missing_skills=missing,
        matched_keywords=matched_kw,
        missing_keywords=missing_kw,
        strengths=strengths,
        gaps=gaps,
    )


def _education_score(resume: MasterResume, requirements: JobRequirements) -> tuple[int, str]:
    req = (requirements.education_requirement or "").lower()
    has_degree = bool(resume.education)
    if not req:
        return (100 if has_degree else 90, "No specific degree required")
    # If a degree is asked for and the candidate has any, treat it as met; the
    # extractor rarely distinguishes field, and penalising further guesses too much.
    if has_degree:
        return 100, "Degree on file meets the stated requirement"
    return 55, "A degree is requested; none is listed on your résumé"


def _explain(
    matched: list[SkillHit],
    missing: list[SkillHit],
    matched_kw: list[str],
    missing_kw: list[str],
    years: float,
    need_years: int | None,
) -> tuple[list[str], list[str]]:
    strengths: list[str] = []
    gaps: list[str] = []

    strong_matched = [h.name for h in sorted(matched, key=lambda h: -h.importance)]
    if strong_matched:
        strengths.append(
            f"You match {len(matched)} of the listed skills, including "
            f"{', '.join(strong_matched[:5])}."
        )
    key_missing = [h.name for h in sorted(missing, key=lambda h: -h.importance) if h.importance >= 4]
    if key_missing:
        gaps.append(f"Missing high-priority skills: {', '.join(key_missing[:5])}.")
    other_missing = [h.name for h in missing if h.importance < 4]
    if other_missing:
        gaps.append(f"Also not shown: {', '.join(other_missing[:5])}.")

    if matched_kw:
        strengths.append(f"Your résumé already surfaces {len(matched_kw)} of the job's ATS keywords.")
    if missing_kw:
        gaps.append(f"ATS keywords worth working in: {', '.join(missing_kw[:6])}.")

    if need_years and need_years > 0:
        if years >= need_years:
            strengths.append(f"Your ~{years} yrs of experience meets the {need_years}-yr bar.")
        else:
            gaps.append(f"The role asks for {need_years} yrs; your résumé shows ~{years}.")

    if not gaps:
        gaps.append("No significant gaps detected — a strong fit on paper.")
    return strengths, gaps


def skill_gaps(
    resume: MasterResume,
    requirement_sets: list[JobRequirements],
    *,
    top_n: int = 12,
) -> SkillGapReport:
    """Aggregate demand across many jobs → the most impactful skills to learn."""
    corpus, vocab = _skill_index(resume)
    demand: dict[str, int] = defaultdict(int)
    importance_sum: dict[str, float] = defaultdict(float)
    canonical: dict[str, str] = {}

    matches: list[int] = []
    for req in requirement_sets:
        for skill in [*req.required_skills, *req.preferred_skills]:
            key = skill.name.strip().lower()
            if not key:
                continue
            canonical.setdefault(key, skill.name.strip())
            demand[key] += 1
            importance_sum[key] += skill.importance
        matches.append(match_resume_to_job(resume, req).overall_score)

    def to_demand(key: str) -> SkillDemand:
        return SkillDemand(
            name=canonical[key],
            demand=demand[key],
            avg_importance=round(importance_sum[key] / demand[key], 1),
            have=_claims(canonical[key], corpus, vocab),
        )

    ranked = sorted(
        demand, key=lambda k: (demand[k], importance_sum[k] / demand[k]), reverse=True
    )
    all_demands = [to_demand(k) for k in ranked]
    average = round(sum(matches) / len(matches)) if matches else None

    return SkillGapReport(
        jobs_analyzed=len(requirement_sets),
        average_match=average,
        top_missing=[d for d in all_demands if not d.have][:top_n],
        high_demand=all_demands[:top_n],
        covered=[d for d in all_demands if d.have][:top_n],
    )
