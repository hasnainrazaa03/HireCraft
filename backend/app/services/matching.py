"""Deterministic job-match scoring and skill-gap analysis.

No LLM: the fit score is derived from concrete overlaps between the résumé and a
job's extracted requirements, so it is reproducible and explainable. The same
skill-detection logic backs both the per-job match and the cross-job gap report.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
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

# Filler that carries no matching signal — English + the German that shows up on
# EU job boards + the (m/w/d) / (f/m/x) gender markers German postings append to
# every title. Stripped before any title/text comparison so they can't create
# spurious overlap or dilute cosine similarity.
_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "at",
    "as", "by", "is", "are", "be", "we", "you", "our", "your", "will", "who",
    "that", "this", "role", "job", "position", "team", "work", "working",
    "experience", "years", "skills", "including", "etc", "using", "used",
    "und", "oder", "der", "die", "das", "für", "mit", "im", "ein", "eine",
    "zur", "zum", "als", "von", "bei", "auf", "wir", "sie", "ihre",
    "m", "w", "d", "f", "x", "mwd", "fmx",
})

# Title words that denote seniority, not domain — handled by the seniority
# signal, so they must not count toward title/domain alignment.
_SENIORITY_WORDS = frozenset({
    "intern", "internship", "working", "student", "werkstudent", "praktikum",
    "graduate", "grad", "junior", "entry", "associate", "mid", "senior", "sr",
    "staff", "principal", "lead", "manager", "head", "director", "vp", "chief",
})


def _tokens(text: str) -> set[str]:
    return set(_TOKEN.findall(text.lower()))


def _content_tokens(text: str) -> list[str]:
    """Meaningful tokens: lower-cased, stopwords/1-char noise removed, order kept."""
    return [
        t for t in _TOKEN.findall(text.lower())
        if t not in _STOPWORDS and (len(t) > 1 or t in {"c", "r", "go"})
    ]


def _tf_cosine(a: list[str], b: list[str]) -> float:
    """Cosine similarity of two token lists by term frequency (0–1).

    No IDF: with only two documents there is no corpus to weight against, so
    plain TF cosine — shared terms normalised by length — is the honest measure.
    """
    if not a or not b:
        return 0.0
    ca, cb = Counter(a), Counter(b)
    shared = set(ca) & set(cb)
    if not shared:
        return 0.0
    dot = sum(ca[t] * cb[t] for t in shared)
    na = math.sqrt(sum(v * v for v in ca.values()))
    nb = math.sqrt(sum(v * v for v in cb.values()))
    return dot / (na * nb)


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


_ROLE_CONNECTIVES = re.compile(
    r"\b(specializing|specialising|focused|focusing|with|building|passionate|"
    r"experienced|driven|who)\b|[—,|/·-]",
    re.IGNORECASE,
)


def default_search_query(resume: MasterResume) -> str:
    """A job-search query that reflects who the candidate is, for the default
    (no query typed) feed — so it opens on relevant roles, not a generic list.

    Prefers the role phrase the candidate leads their headline with (what they
    position themselves as), then their most recent title, then top skills.
    """
    headline = resume.basics.headline or ""
    lead = " ".join(_content_tokens(_ROLE_CONNECTIVES.split(headline, maxsplit=1)[0]))
    if len(lead.split()) >= 2:
        return " ".join(lead.split()[:4])
    if resume.experience:
        title = " ".join(
            t for t in _content_tokens(resume.experience[0].title)
            if t not in _SENIORITY_WORDS
        )
        if title:
            return title
    skills = sorted(_resume_skills(resume), key=str.lower)
    return " ".join(skills[:2])


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
    # The unrounded score, kept so a caller (the LLM re-rank) can blend on top
    # without collapsing everything onto whole numbers.
    score_precise: float = 0.0
    # Per-signal breakdown (0–100 each), for explainability / future tuning.
    factors: dict[str, float] | None = None


def _term_present(job_lower: str, term: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(term.lower())}(?![a-z0-9])", job_lower) is not None


def _role_profile(resume: MasterResume) -> list[str]:
    """The candidate's domain vocabulary — the words that say what they *do*.

    Titles and headline count several times over so the role (e.g. "machine
    learning engineer") dominates the profile, with skills and field of study
    filling in the surrounding domain terms. This is what a job title is scored
    against, so an ML résumé aligns with "Data Scientist" and not "SEO Manager".
    """
    parts: list[str] = []
    for e in resume.experience:
        parts += _content_tokens(e.title) * 3
    parts += _content_tokens(resume.basics.headline or "") * 2
    for g in resume.skills:
        parts += _content_tokens(" ".join(g.items))
    for e in resume.experience:
        parts += [t for tech in e.technologies for t in _content_tokens(tech)]
    for ed in resume.education:
        parts += _content_tokens(ed.field_of_study or "")
    return parts


# Job-title level → the candidate level it best fits, on a 0..4 ladder.
_TITLE_LEVELS: tuple[tuple[frozenset[str], int], ...] = (
    (frozenset({"intern", "internship", "werkstudent", "praktikum"}), 0),
    (frozenset({"working", "student"}), 0),
    (frozenset({"graduate", "grad", "junior", "entry", "associate"}), 1),
    (frozenset({"staff", "principal", "lead", "head", "director", "vp", "chief"}), 4),
    (frozenset({"senior", "sr"}), 3),
    (frozenset({"manager"}), 3),
)


def _title_level(title: str) -> int | None:
    toks = set(_TOKEN.findall(title.lower()))
    for words, level in _TITLE_LEVELS:
        if toks & words:
            return level
    return None  # unmarked → treat as mid, no penalty


def _resume_level(resume: MasterResume) -> int:
    years = _estimate_years(resume)
    return 0 if years < 0.75 else 1 if years < 2.5 else 2 if years < 5 else 3


def analyze_job_fit(resume: MasterResume, job_text: str, *, title: str = "") -> JobFit:
    """Deterministic, LLM-free fit analysis for a job posting: a fit score,
    the requirements the candidate has vs. lacks, and a plain-language summary —
    so a job card can answer 'should I apply, and why?' with no API call.

    The score blends four signals — domain/title alignment, importance-shrunk
    skill coverage, full-text similarity, and seniority fit — then shrinks the
    result toward a neutral prior when the evidence is thin. That fixes the old
    failure where a job naming one skill you happen to have (the letter "R" in an
    SEO posting) scored 100% while a relevant "Data Scientist" role scored 12%.
    """
    corpus, vocab = _skill_index(resume)
    job = job_text.lower()

    present = [t for t in TECH_VOCAB if _term_present(job, t)]
    strengths = [t for t in present if _claims(t, corpus, vocab)]
    gaps = [t for t in present if not _claims(t, corpus, vocab)]

    # --- Signal 1: title / domain alignment (strongest discriminator).
    profile = _role_profile(resume)
    profile_set = set(profile)
    title_tokens = [t for t in _content_tokens(title) if t not in _SENIORITY_WORDS]
    if title_tokens:
        overlap = sum(1 for t in set(title_tokens) if t in profile_set) / len(set(title_tokens))
        cos = _tf_cosine(title_tokens, profile)
        title_align: float | None = max(overlap, cos) * 100
    else:
        title_align = None

    # --- Signal 2: skill coverage, shrunk toward a neutral prior so a lone hit
    # can't read as a perfect match ((1 hit)/(1 named) is pulled off 100%).
    if present:
        alpha, prior = 3.0, 0.4
        skill_cov: float | None = (len(strengths) + alpha * prior) / (len(present) + alpha) * 100
    else:
        skill_cov = None

    # --- Signal 3: full-text similarity over shared content vocabulary.
    text_sim = min(100.0, _tf_cosine(_content_tokens(job_text), profile) * 260)

    # --- Signal 4: seniority fit.
    jl = _title_level(title)
    seniority = 100.0 if jl is None else max(0.0, 100 - 30 * abs(jl - _resume_level(resume)))

    # --- Signal 5: skill breadth — how many distinct real skills the posting
    # actually hits, not just the ratio. A job that names five of your skills is a
    # better bet than one that names one, even if both are "fully covered". Scaled
    # so ~6 concrete hits saturates.
    breadth = min(100.0, len(strengths) * 16.0) if strengths else 0.0
    breadth_signal: float | None = breadth if present else None

    # Blend the available signals (title/skill may be absent), renormalising over
    # whatever is present so a missing signal doesn't silently drag the score.
    weighted = [
        (title_align, 0.32),
        (skill_cov, 0.24),
        (text_sim, 0.22),
        (breadth_signal, 0.12),
        (seniority, 0.10),
    ]
    num = sum(v * w for v, w in weighted if v is not None)
    den = sum(w for v, w in weighted if v is not None)
    raw = num / den if den else 42.0

    # Confidence: how much did we actually have to go on? Thin evidence (a short,
    # foreign, or title-less posting naming ≤1 skill) is pulled toward neutral so
    # it never masquerades as a strong match. Graduated, not a step, so the final
    # score varies smoothly rather than snapping between bands.
    jd_len = len(_content_tokens(job_text))
    evidence = min(
        1.0,
        0.4
        + (0.32 if title_tokens else 0.0)
        + min(0.18, 0.06 * len(present))
        + min(0.10, jd_len / 400),
    )
    neutral = 42.0
    precise = max(6.0, min(98.0, neutral + (raw - neutral) * evidence))
    score = round(precise)

    verdict = (
        "Excellent Match" if score >= 82
        else "Great Match" if score >= 68
        else "Good Match" if score >= 50
        else "Fair Match"
    )
    chance = "High" if score >= 70 else "Medium" if score >= 48 else "Low"
    return JobFit(
        score=score,
        verdict=verdict,
        strengths=strengths[:8],
        gaps=gaps[:6],
        interview_chance=chance,
        summary=_fit_summary(score, strengths, gaps),
        score_precise=precise,
        factors={
            "title_alignment": round(title_align, 1) if title_align is not None else -1.0,
            "skill_coverage": round(skill_cov, 1) if skill_cov is not None else -1.0,
            "text_similarity": round(text_sim, 1),
            "skill_breadth": round(breadth, 1),
            "seniority_fit": round(seniority, 1),
            "confidence": round(evidence, 2),
        },
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


# Semantic skill implications: the umbrella skill on the LEFT is demonstrated by
# any concrete evidence term on the RIGHT appearing in the résumé. So a résumé that
# shows MongoDB counts as NoSQL, REST work counts as "REST APIs", and real
# latency/throughput/quantization work counts as "performance optimization" — even
# when the exact umbrella keyword is never written. Evidence is matched as a
# substring (terms are specific), so "optimiz" covers optimize/optimized/optimization.
_SKILL_IMPLICATIONS: tuple[tuple[frozenset[str], tuple[str, ...]], ...] = (
    (frozenset({"nosql", "no-sql"}),
     ("mongodb", "mongo", "dynamodb", "cassandra", "redis", "couchbase", "couchdb", "firestore", "neo4j")),
    (frozenset({"sql", "relational database", "relational databases", "rdbms"}),
     ("postgres", "postgresql", "mysql", "sqlite", "mariadb", "sql server", "t-sql", "pl/sql", "bigquery", "redshift", "snowflake")),
    (frozenset({"rest api", "rest apis", "restful api", "restful apis", "rest services"}),
     ("rest api", "restful", "rest endpoint", "api orchestration")),
    (frozenset({"performance optimization", "performance optimisation", "performance tuning", "optimization", "optimisation"}),
     ("latency", "throughput", "quantiz", "quantis", "profiling", "sub-second", "speedup", "optimiz", "optimis")),
    (frozenset({"microservices", "microservice", "microservice architecture", "microservices architecture"}),
     ("microservice",)),
    (frozenset({"ci/cd", "cicd", "continuous integration", "continuous delivery", "continuous deployment"}),
     ("ci/cd", "continuous integration", "continuous delivery", "github actions", "gitlab ci", "jenkins", "circleci")),
    (frozenset({"kubernetes", "k8s", "container orchestration"}),
     ("kubernetes", "k8s")),
    (frozenset({"docker", "containerization", "containerisation"}),
     ("docker", "podman")),
    (frozenset({"event-driven", "event driven", "event-driven architecture", "messaging", "message queue", "message queues", "pub/sub", "pubsub"}),
     ("kafka", "rabbitmq", "sqs", "kinesis", "pubsub", "pub/sub", "nats")),
)


def _implied_terms(needle: str) -> tuple[str, ...]:
    """Concrete résumé evidence that would demonstrate the umbrella skill ``needle``."""
    for keys, evidence in _SKILL_IMPLICATIONS:
        if needle in keys:
            return evidence
    return ()


def _singular(word: str) -> str:
    """Rough English singular, enough to bridge plural job skills to a singular
    résumé mention ("REST APIs" ← "REST API", "pipelines" ← "pipeline")."""
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith("es") and word[-3] in "sxzo":
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _claims(term: str, corpus_lower: str, vocab: set[str]) -> bool:
    """Does the résumé support this skill/keyword? Whole-term phrase match, then
    token-subset (with plural/word-form tolerance), then a semantic implication —
    so a demonstrated capability counts even when the exact umbrella word is absent.

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
    if parts and parts.issubset(vocab):
        return True
    # Plural / word-form tolerance: "REST APIs" ← the résumé's "REST API".
    if parts and all((t in vocab) or (_singular(t) in vocab) for t in parts):
        return True
    # Semantic implication: MongoDB ⇒ NoSQL, latency/throughput work ⇒ perf-opt.
    return any(evidence in corpus_lower for evidence in _implied_terms(needle))


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
