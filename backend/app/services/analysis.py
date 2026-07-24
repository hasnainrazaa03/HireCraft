"""Deterministic résumé scoring and suggestions.

Every metric is a concrete rule over the résumé's structure and text — no LLM,
no randomness. The point is transparency: a low "quantification" score means a
countable fraction of bullets lack a number, and the findings name those exact
bullets. Consumed by the /resumes/{id}/analysis endpoint and, later, shown
before/after tailoring so the user can see a résumé improve.
"""

from __future__ import annotations

import re

from app.schemas.analysis import (
    AtsCheck,
    Finding,
    ResumeAnalysis,
    ScoreMetric,
)
from app.schemas.resume import MasterResume

# Strong action verbs recruiters look for at the start of a bullet. Lower-cased,
# base form; we also accept the -ed past tense.
ACTION_VERBS = frozenset(
    ["architected", "automated", "built", "created", "delivered", "designed", "developed", "drove", "engineered", "established", "generated", "implemented", "improved", "increased", "introduced", "launched", "led", "managed", "mentored", "migrated", "optimized", "orchestrated", "overhauled", "owned", "pioneered", "prototyped", "reduced", "refactored", "resolved", "scaled", "shipped", "spearheaded", "streamlined", "transformed", "accelerated", "achieved", "analyzed", "authored", "boosted", "championed", "coached", "collaborated", "consolidated", "coordinated", "cut", "decreased", "deployed", "devised", "directed", "doubled", "eliminated", "enabled", "enhanced", "executed", "expanded", "facilitated", "founded", "grew", "guided", "hardened", "initiated", "instrumented", "integrated", "maintained", "modernized", "negotiated", "presented", "produced", "programmed", "published", "quantified", "ranked", "rearchitected", "rebuilt", "redesigned", "researched", "restructured", "revamped", "saved", "secured", "simplified", "slashed", "solved", "standardized", "supported", "tested", "trained", "tripled", "unified", "upgraded", "validated", "won", "wrote"]
)

# Weak openers that signal a passive or duty-listing bullet.
WEAK_OPENERS = frozenset(
    {"responsible", "worked", "helped", "assisted", "participated", "involved",
     "tasked", "duties", "handled", "various", "assorted"}
)

PASSIVE_RE = re.compile(
    r"\b(was|were|been|being|is|are)\b\s+\w+(ed|en)\b|\bresponsible for\b",
    re.IGNORECASE,
)
NUMBER_RE = re.compile(r"\d[\d,]*\.?\d*\s*(%|percent|x|k|m|b|\+)?|\$\d", re.IGNORECASE)
WORD_RE = re.compile(r"[A-Za-z']+")
FIRST_WORD_RE = re.compile(r"^\s*([A-Za-z]+)")


def _all_bullets(resume: MasterResume) -> list[tuple[str, str]]:
    """Every bullet paired with a human label for its entry."""
    out: list[tuple[str, str]] = []
    for e in resume.experience:
        for h in e.highlights:
            out.append((f"{e.company} — {e.title}", h))
    for p in resume.projects:
        for h in p.highlights:
            out.append((p.name, h))
    for ed in resume.education:
        for h in ed.highlights:
            out.append((ed.institution, h))
    return out


def _has_number(text: str) -> bool:
    return bool(NUMBER_RE.search(text))


def _first_word(text: str) -> str:
    m = FIRST_WORD_RE.match(text)
    return m.group(1).lower() if m else ""


def _is_action_verb(word: str) -> bool:
    if word in ACTION_VERBS:
        return True
    # accept a past-tense form whose stem is a known verb
    if word.endswith("ed") and (word[:-2] in ACTION_VERBS or word[:-1] in ACTION_VERBS):
        return True
    return bool(word.endswith("d") and word[:-1] in ACTION_VERBS)


def _flesch_reading_ease(text: str) -> float:
    """Approximate Flesch reading ease (0-100+). Higher = easier to read."""
    words = WORD_RE.findall(text)
    sentences = max(text.count(".") + text.count("!") + text.count("?"), 1)
    if not words:
        return 0.0
    syllables = sum(_count_syllables(w) for w in words)
    words_per_sentence = len(words) / sentences
    syllables_per_word = syllables / len(words)
    return 206.835 - 1.015 * words_per_sentence - 84.6 * syllables_per_word


def _count_syllables(word: str) -> int:
    word = word.lower()
    vowels = "aeiouy"
    count = 0
    prev_vowel = False
    for ch in word:
        is_vowel = ch in vowels
        if is_vowel and not prev_vowel:
            count += 1
        prev_vowel = is_vowel
    if word.endswith("e") and count > 1:
        count -= 1
    return max(count, 1)


def _clamp(value: float) -> int:
    return max(0, min(100, round(value)))


def _grade(score: int) -> str:
    if score >= 85:
        return "Excellent"
    if score >= 70:
        return "Strong"
    if score >= 50:
        return "Fair"
    return "Needs work"


def analyze_resume(resume: MasterResume) -> ResumeAnalysis:
    bullets = _all_bullets(resume)
    total = len(bullets)
    findings: list[Finding] = []

    # --- Quantification -----------------------------------------------------
    quantified = [b for b in bullets if _has_number(b[1])]
    n_quant = len(quantified)
    quant_score = _clamp(100 * n_quant / total) if total else 0
    for label, text in bullets:
        if not _has_number(text):
            findings.append(
                Finding(
                    category="missing_metric",
                    severity="warning",
                    title="Bullet has no measurable result",
                    detail=f"Add a number, %, or scale to quantify impact: {_snippet(text)}",
                    location=label,
                )
            )

    # --- Action verbs -------------------------------------------------------
    strong_start = 0
    verb_usage: dict[str, int] = {}
    for label, text in bullets:
        first = _first_word(text)
        if _is_action_verb(first):
            strong_start += 1
            verb_usage[first] = verb_usage.get(first, 0) + 1
        elif first in WEAK_OPENERS:
            findings.append(
                Finding(
                    category="weak_opener",
                    severity="warning",
                    title="Weak bullet opener",
                    detail=f"Lead with a strong action verb instead of '{first}': {_snippet(text)}",
                    location=label,
                )
            )
    verb_score = _clamp(100 * strong_start / total) if total else 0
    for verb, count in verb_usage.items():
        if count >= 3:
            findings.append(
                Finding(
                    category="repeated_verb",
                    severity="info",
                    title=f"'{verb.title()}' repeated {count} times",
                    detail="Vary your opening verbs so bullets don't read the same.",
                )
            )

    # --- Passive voice ------------------------------------------------------
    for label, text in bullets:
        if PASSIVE_RE.search(text):
            findings.append(
                Finding(
                    category="passive_voice",
                    severity="info",
                    title="Passive or duty-listing phrasing",
                    detail=f"Rewrite in active voice: {_snippet(text)}",
                    location=label,
                )
            )

    # --- Impact (verb AND metric) ------------------------------------------
    impactful = sum(
        1 for _, t in bullets if _has_number(t) and _is_action_verb(_first_word(t))
    )
    impact_score = _clamp(100 * impactful / total) if total else 0

    # --- Brevity ------------------------------------------------------------
    brevity_penalties = 0
    for label, text in bullets:
        wc = len(WORD_RE.findall(text))
        if wc > 34:
            brevity_penalties += 1
            findings.append(
                Finding(
                    category="long_bullet",
                    severity="info",
                    title=f"Bullet is long ({wc} words)",
                    detail=f"Tighten to one line, ideally under 30 words: {_snippet(text)}",
                    location=label,
                )
            )
        elif 0 < wc < 5:
            brevity_penalties += 1
            findings.append(
                Finding(
                    category="short_bullet",
                    severity="info",
                    title="Bullet is very short",
                    detail=f"Expand with the how and the result: {_snippet(text)}",
                    location=label,
                )
            )
    brevity_score = _clamp(100 - (100 * brevity_penalties / total if total else 0))

    # --- Readability --------------------------------------------------------
    combined = " ".join(f"{t}." for _, t in bullets)
    ease = _flesch_reading_ease(combined) if combined else 60.0
    # Résumé bullets are dense; 40-70 ease is the sweet spot. Map to a score:
    # gently penalize overly-simple prose above 70; treat very hard text (low
    # ease) as a lower score.
    readability = (
        _clamp(100 - max(0, ease - 70)) if ease >= 50 else _clamp(60 + ease)
    )

    # --- Completeness -------------------------------------------------------
    completeness, comp_findings = _completeness(resume)
    findings.extend(comp_findings)

    # --- Recruiter friendliness (composite of the above signals) -----------
    est_pages = _estimate_pages(resume)
    recruiter = _recruiter_score(resume, total, quant_score, est_pages, findings)

    metrics = [
        ScoreMetric(key="quantification", label="Quantified impact", score=quant_score,
                    detail=f"{n_quant}/{total} bullets include a metric" if total else "No bullets yet"),
        ScoreMetric(key="action_verbs", label="Strong action verbs", score=verb_score,
                    detail=f"{strong_start}/{total} bullets lead with a strong verb" if total else "No bullets yet"),
        ScoreMetric(key="impact", label="Impact statements", score=impact_score,
                    detail=f"{impactful}/{total} bullets pair a verb with a result" if total else "No bullets yet"),
        ScoreMetric(key="brevity", label="Concise bullets", score=brevity_score,
                    detail="Most bullets are a good length" if brevity_penalties == 0 else f"{brevity_penalties} bullet(s) too long or too short"),
        ScoreMetric(key="readability", label="Readability", score=readability,
                    detail="Clear and easy to scan"),
        ScoreMetric(key="completeness", label="Completeness", score=completeness,
                    detail="All key sections present" if completeness >= 90 else "Some sections are missing"),
        ScoreMetric(key="recruiter_friendly", label="Recruiter-friendly", score=recruiter,
                    detail=f"~{est_pages:.1f} page(s)"),
    ]

    # Overall: weighted toward the signals recruiters weigh most.
    weights = {
        "quantification": 0.22, "action_verbs": 0.18, "impact": 0.18,
        "completeness": 0.15, "brevity": 0.1, "readability": 0.08,
        "recruiter_friendly": 0.09,
    }
    overall = _clamp(sum(m.score * weights[m.key] for m in metrics))

    ats_checks, ats_score = _ats_checks(resume, est_pages)

    # Order findings by severity so the UI leads with what matters.
    order = {"critical": 0, "warning": 1, "info": 2, "good": 3}
    findings.sort(key=lambda f: order.get(f.severity, 4))

    return ResumeAnalysis(
        overall_score=overall,
        grade=_grade(overall),  # type: ignore[arg-type]
        metrics=metrics,
        findings=findings[:40],
        ats_checks=ats_checks,
        ats_score=ats_score,
        bullet_count=total,
        quantified_bullets=n_quant,
        estimated_pages=round(est_pages, 1),
    )


def _snippet(text: str, n: int = 80) -> str:
    text = text.strip()
    return f'"{text[:n]}…"' if len(text) > n else f'"{text}"'


def _completeness(resume: MasterResume) -> tuple[int, list[Finding]]:
    findings: list[Finding] = []
    b = resume.basics
    checks = {
        "summary": bool(b.summary),
        "experience": bool(resume.experience),
        "education": bool(resume.education),
        "skills": bool(resume.skills),
        "links": bool(b.linkedin or b.github or b.website),
        "location": bool(b.location),
    }
    missing = [k for k, ok in checks.items() if not ok]
    for key in missing:
        sev = "critical" if key in ("experience",) else "warning"
        findings.append(
            Finding(
                category="missing_section",
                severity=sev,  # type: ignore[arg-type]
                title=f"Missing: {key}",
                detail=_completeness_hint(key),
            )
        )
    score = _clamp(100 * sum(checks.values()) / len(checks))
    return score, findings


def _completeness_hint(key: str) -> str:
    return {
        "summary": "Add a 2–3 sentence summary positioning you for your target roles.",
        "experience": "Add at least one work experience entry.",
        "education": "Add your education.",
        "skills": "Add a skills section — it's where ATS keyword matching happens.",
        "links": "Add a LinkedIn or GitHub link so recruiters can learn more.",
        "location": "Add your location; many roles filter on it.",
    }.get(key, f"Add your {key}.")


# Tuned so a typical one-page résumé (~5 roles, ~20 bullets) lands near 1.0 and
# a dense 40-bullet résumé lands near 2.0. A bullet counts as 1.4 lines to
# approximate average wrap; each entry carries heading + spacing overhead.
_LINES_PER_PAGE = 45.0
_BULLET_LINES = 1.4
_ENTRY_OVERHEAD = 3.0


def _estimate_pages(resume: MasterResume) -> float:
    """Rough page estimate from content volume (a US-letter résumé line budget)."""
    lines = 6.0  # header + contact
    if resume.basics.summary:
        lines += 3
    for e in resume.experience:
        lines += _ENTRY_OVERHEAD + _BULLET_LINES * len(e.highlights) + (1 if e.technologies else 0)
    for p in resume.projects:
        lines += _ENTRY_OVERHEAD + _BULLET_LINES * len(p.highlights)
    for ed in resume.education:
        lines += _ENTRY_OVERHEAD + _BULLET_LINES * len(ed.highlights) + (1 if ed.coursework else 0)
    lines += len(resume.skills) + 2
    lines += len(resume.certifications) + len(resume.awards) + len(resume.publications)
    return max(0.4, lines / _LINES_PER_PAGE)


def _recruiter_score(
    resume: MasterResume,
    total_bullets: int,
    quant_score: int,
    est_pages: float,
    findings: list[Finding],
) -> int:
    score = 100
    if est_pages > 2.2:
        score -= 25
        findings.append(
            Finding(
                category="length",
                severity="warning",
                title=f"Résumé is long (~{est_pages:.1f} pages)",
                detail="Aim for 1 page early-career, 2 pages max. Trim older or weaker bullets.",
            )
        )
    elif est_pages < 0.6:
        score -= 15
    if not resume.basics.summary:
        score -= 10
    if total_bullets and quant_score < 40:
        score -= 15
    if total_bullets > 28:
        score -= 10
    return _clamp(score)


def _ats_checks(resume: MasterResume, est_pages: float) -> tuple[list[AtsCheck], int]:
    """Structural ATS checks. A résumé built from our schema is single-column,
    text-based, and uses standard headings by construction — these verify the
    content-level things that still trip parsers."""
    b = resume.basics
    checks = [
        AtsCheck(name="Contact email present", passed=bool(b.email),
                 detail="An ATS keys everything off a parseable email." ),
        AtsCheck(name="Phone or location present", passed=bool(b.phone or b.location),
                 detail="Recruiters filter on location; include at least one." ),
        AtsCheck(name="Standard sections", passed=bool(resume.experience or resume.projects) and bool(resume.education),
                 detail="Experience/Projects and Education are the sections parsers expect." ),
        AtsCheck(name="Skills section for keyword matching", passed=bool(resume.skills),
                 detail="ATS keyword matching leans on an explicit skills list." ),
        AtsCheck(name="Single column, text-based", passed=True,
                 detail="HireCraft templates are single-column with selectable text — ATS-safe by design." ),
        AtsCheck(name="Reasonable length", passed=est_pages <= 2.2,
                 detail=f"~{est_pages:.1f} page(s). Keep it to 1–2." ),
        AtsCheck(name="Dates on every role", passed=all(x.start_date for x in resume.experience),
                 detail="Every experience should carry a start date parsers can read." ),
    ]
    passed = sum(1 for c in checks if c.passed)
    return checks, _clamp(100 * passed / len(checks))
