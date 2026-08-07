"""Résumé quality evaluation — a deterministic rubric.

You can't harden what you can't measure. This scores a tailored résumé against a
job on the dimensions recruiters and ATS systems actually reward, with no LLM, so
it's instant, free, and reproducible — usable in tests to guard against
regressions and as an A/B yardstick when we change a prompt or add a stage.

Each metric is 0–100; the overall is their weighted mean. The scorers reuse the
same skill-detection and provenance logic the matcher and guardrails use, so a
"relevant" or "grounded" score here means the same thing it does everywhere else.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.schemas.tailoring import GuardrailReport
from app.services.llm.guardrails import _numbers_in
from app.services.matching import _claims, _skill_index, match_resume_to_job

# Openers that signal a duty, not an accomplishment. A strong bullet leads with a
# real action verb instead.
_WEAK_OPENERS = frozenset({
    "responsible", "worked", "helped", "assisted", "involved", "tasked",
    "participated", "contributed", "handled", "supported", "duties", "was",
    "managed",  # weak when it's the opener of every bullet; fine mid-sentence
})

_WORD = re.compile(r"[A-Za-z][A-Za-z0-9+#.\-]*")


@dataclass
class EvalMetric:
    key: str
    label: str
    score: int  # 0–100
    weight: float
    detail: str


@dataclass
class ResumeScorecard:
    overall: int
    metrics: list[EvalMetric]

    def get(self, key: str) -> int:
        for m in self.metrics:
            if m.key == key:
                return m.score
        return 0


def _bullets(resume: MasterResume) -> list[str]:
    out: list[str] = []
    for e in resume.experience:
        out += [h for h in e.highlights if h.strip()]
    for p in resume.projects:
        out += [h for h in p.highlights if h.strip()]
    return out


def _pct(n: int, d: int) -> int:
    return round(100 * n / d) if d else 0


def _impact_density(bullets: list[str]) -> tuple[int, str]:
    with_metric = sum(1 for b in bullets if _numbers_in(b))
    return _pct(with_metric, len(bullets)), f"{with_metric}/{len(bullets)} bullets carry a metric"


def _verb_strength(bullets: list[str]) -> tuple[int, str]:
    weak = 0
    for b in bullets:
        m = _WORD.search(b)
        if m and m.group().lower() in _WEAK_OPENERS:
            weak += 1
    strong = len(bullets) - weak
    return _pct(strong, len(bullets)), f"{weak} bullet(s) open with a weak/duty verb"


def _conciseness(bullets: list[str]) -> tuple[int, str]:
    good = sum(1 for b in bullets if 6 <= len(b.split()) <= 34)
    return _pct(good, len(bullets)), f"{good}/{len(bullets)} bullets in the 6–34 word range"


def _ats_coverage(resume: MasterResume, requirements: JobRequirements) -> tuple[int, str]:
    keywords = requirements.ats_keywords
    if not keywords:
        return 100, "no ATS keywords extracted"
    corpus, vocab = _skill_index(resume)
    hit = [k for k in keywords if _claims(k, corpus, vocab)]
    return _pct(len(hit), len(keywords)), f"{len(hit)}/{len(keywords)} ATS keywords surfaced"


def _grounding(report: GuardrailReport | None) -> tuple[int, str]:
    if report is None:
        return 100, "not vetted"
    errors = sum(1 for v in report.violations if v.severity == "error")
    return max(0, 100 - 30 * errors), f"{errors} truthfulness error(s)"


def score_resume(
    tailored: MasterResume,
    requirements: JobRequirements,
    *,
    report: GuardrailReport | None = None,
) -> ResumeScorecard:
    """Score a tailored résumé against a job. Deterministic; no LLM."""
    bullets = _bullets(tailored)
    relevance = match_resume_to_job(tailored, requirements).overall_score
    impact, impact_d = _impact_density(bullets)
    verb, verb_d = _verb_strength(bullets)
    concise, concise_d = _conciseness(bullets)
    ats, ats_d = _ats_coverage(tailored, requirements)
    ground, ground_d = _grounding(report)

    metrics = [
        EvalMetric("relevance", "Job relevance", relevance, 0.30,
                   "importance-weighted skill/keyword/experience fit"),
        EvalMetric("ats", "ATS keyword coverage", ats, 0.20, ats_d),
        EvalMetric("impact", "Quantified impact", impact, 0.15, impact_d),
        EvalMetric("verbs", "Action-verb strength", verb, 0.10, verb_d),
        EvalMetric("conciseness", "Conciseness", concise, 0.10, concise_d),
        EvalMetric("grounding", "Truthfulness", ground, 0.15, ground_d),
    ]
    overall = round(sum(m.score * m.weight for m in metrics))
    return ResumeScorecard(overall=overall, metrics=metrics)


def score_from_report(
    tailored: MasterResume, report: GuardrailReport
) -> ResumeScorecard:
    """Scorecard for a completed tailoring, from data already stored on it.

    The application persists the tailored résumé and the guardrail report but not
    the extracted requirements, so job fit is read off the report's verified vs.
    requested keywords (already computed) — no re-extraction, no LLM. The other
    dimensions come straight off the tailored bullets.
    """
    bullets = _bullets(tailored)
    requested = list(report.keywords_requested)
    verified = list(report.keywords_verified)
    ats = _pct(len(verified), len(requested)) if requested else 100
    ats_d = (
        f"{len(verified)}/{len(requested)} job keywords surfaced"
        if requested else "no ATS keywords extracted"
    )
    impact, impact_d = _impact_density(bullets)
    verb, verb_d = _verb_strength(bullets)
    concise, concise_d = _conciseness(bullets)
    ground, ground_d = _grounding(report)

    metrics = [
        EvalMetric("ats", "Job-fit keywords", ats, 0.30, ats_d),
        EvalMetric("impact", "Quantified impact", impact, 0.20, impact_d),
        EvalMetric("verbs", "Action-verb strength", verb, 0.15, verb_d),
        EvalMetric("conciseness", "Conciseness", concise, 0.10, concise_d),
        EvalMetric("grounding", "Truthfulness", ground, 0.25, ground_d),
    ]
    overall = round(sum(m.score * m.weight for m in metrics))
    return ResumeScorecard(overall=overall, metrics=metrics)


@dataclass
class ImprovementTip:
    """A specific, data-backed way to raise the score for THIS résumé.

    `instruction` is written so the grounded AI assistant can act on it directly —
    the "Improve with AI" button hands it straight to the rewrite endpoint.
    """

    key: str
    title: str
    detail: str
    metric_key: str
    keywords: list[str]
    instruction: str


def suggestions_from_report(
    tailored: MasterResume, report: GuardrailReport, *, limit: int = 3
) -> list[ImprovementTip]:
    """The weakest, most fixable areas — named with real data from this résumé.

    Not generic advice: each tip cites the actual gap (the real missing keywords,
    the real count of un-quantified bullets) and carries an instruction the
    grounded assistant can run. Deterministic and free, like the scorecard itself.
    """
    bullets = _bullets(tailored)
    total = len(bullets)
    requested = list(report.keywords_requested)
    verified = {k.lower() for k in report.keywords_verified}
    missing = [k for k in requested if k.lower() not in verified]

    without_metric = sum(1 for b in bullets if not _numbers_in(b))
    weak = 0
    for b in bullets:
        m = _WORD.search(b)
        if m and m.group().lower() in _WEAK_OPENERS:
            weak += 1
    off_length = sum(1 for b in bullets if not 6 <= len(b.split()) <= 34)
    errors = sum(1 for v in report.violations if v.severity == "error")

    card = score_from_report(tailored, report)
    candidates: list[tuple[int, ImprovementTip]] = []

    ats = card.get("ats")
    if ats < 80 and missing:
        candidates.append((ats, ImprovementTip(
            key="keywords",
            title="Add missing keywords",
            detail="Weave in where you have real experience: " + ", ".join(missing[:6]) + ".",
            metric_key="ats",
            keywords=missing[:10],
            instruction=(
                "Weave these job keywords into my résumé wherever I have genuine "
                "supporting experience — never fabricate: " + ", ".join(missing[:10]) + "."
            ),
        )))

    impact = card.get("impact")
    if impact < 80 and without_metric:
        candidates.append((impact, ImprovementTip(
            key="impact",
            title="Quantify more impact",
            detail=f"{without_metric} of {total} bullets carry no number — add outcomes (%, $, time saved).",
            metric_key="impact",
            keywords=[],
            instruction=(
                "Add quantified outcomes (numbers, %, $, time saved) to my strongest "
                "bullets that currently lack a metric — only where it is truthful."
            ),
        )))

    verbs = card.get("verbs")
    if verbs < 90 and weak:
        candidates.append((verbs, ImprovementTip(
            key="verbs",
            title="Strengthen action verbs",
            detail=f"{weak} bullet(s) open with a duty verb like “Responsible for”.",
            metric_key="verbs",
            keywords=[],
            instruction=(
                "Rewrite any bullets that open with weak or duty verbs (e.g. "
                "'Responsible for', 'Worked on') to lead with a strong action verb, "
                "keeping every fact unchanged."
            ),
        )))

    concise = card.get("conciseness")
    if concise < 90 and off_length:
        candidates.append((concise, ImprovementTip(
            key="conciseness",
            title="Tighten content",
            detail=f"{off_length} bullet(s) fall outside the 6–34 word sweet spot.",
            metric_key="conciseness",
            keywords=[],
            instruction=(
                "Tighten overly long bullets to the 6–34 word range without dropping "
                "key facts; expand any too short to stand on their own."
            ),
        )))

    ground = card.get("grounding")
    if ground < 100 and errors:
        candidates.append((ground, ImprovementTip(
            key="grounding",
            title="Fix flagged claims",
            detail=f"{errors} claim(s) couldn't be verified — review the Guardrails tab.",
            metric_key="grounding",
            keywords=[],
            instruction=(
                "Review the claims guardrails flagged as unsupported and rewrite them "
                "so every statement is backed by my résumé or brag bank."
            ),
        )))

    candidates.sort(key=lambda c: c[0])
    return [tip for _, tip in candidates[:limit]]


@dataclass
class BulletRef:
    id: str      # "exp:{i}:{j}" / "prj:{i}:{j}" — stable within one résumé blob
    where: str   # "Company — Title" or project name, for context
    text: str
    note: str    # why it's flagged, e.g. "42 words" or "opens with “Worked”"


def _iter_bullets(resume: MasterResume):
    """Yield (id, where, text) for every experience/project highlight."""
    for ei, e in enumerate(resume.experience):
        where = " — ".join(x for x in (e.company, e.title) if x) or "Experience"
        for hi, h in enumerate(e.highlights):
            if h.strip():
                yield f"exp:{ei}:{hi}", where, h
    for pi, p in enumerate(resume.projects):
        where = p.name or "Project"
        for hi, h in enumerate(p.highlights):
            if h.strip():
                yield f"prj:{pi}:{hi}", where, h


def inspect_resume(
    tailored: MasterResume, report: GuardrailReport
) -> dict[str, list]:
    """Locate the exact items behind each metric — raw material for the per-metric
    "fix it" side panel. Deterministic; mirrors the scorers so the panel shows
    precisely what pulled the score down.
    """
    requested = list(report.keywords_requested)
    verified = {k.lower() for k in report.keywords_verified}
    missing = [k for k in requested if k.lower() not in verified]

    impact: list[BulletRef] = []
    verbs: list[BulletRef] = []
    conciseness: list[BulletRef] = []
    for bid, where, text in _iter_bullets(tailored):
        if not _numbers_in(text):
            impact.append(BulletRef(bid, where, text, "no metric"))
        m = _WORD.search(text)
        if m and m.group().lower() in _WEAK_OPENERS:
            verbs.append(BulletRef(bid, where, text, f"opens with “{m.group()}”"))
        words = len(text.split())
        if not 6 <= words <= 34:
            conciseness.append(BulletRef(bid, where, text, f"{words} words"))

    return {"keywords": missing, "impact": impact, "verbs": verbs, "conciseness": conciseness}


def compare(before: ResumeScorecard, after: ResumeScorecard) -> dict[str, int]:
    """Per-metric delta (after − before), plus 'overall'. For A/B on changes."""
    deltas = {m.key: m.score - before.get(m.key) for m in after.metrics}
    deltas["overall"] = after.overall - before.overall
    return deltas
