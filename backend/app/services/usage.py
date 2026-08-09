"""Per-application cost accounting: running totals + a per-workflow breakdown.

Every LLM call an application incurs — the initial tailoring, later revisions,
a cover letter, outreach — is folded into the application's totals and a
category breakdown so the app's Analytics tab can show where the spend went.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.models.application import Application
from app.services.llm.client import Usage


def category_for(purpose: str) -> str:
    """Map an LLM-usage purpose to a spend category shown in Analytics."""
    p = (purpose or "").lower()
    if "outreach" in p:
        return "outreach"
    # Match the cover-letter step precisely — a bare "cover" substring also hits
    # "plan_coverage" (coverage planning), which is a résumé step, not a letter.
    if "cover_letter" in p or "cover letter" in p:
        return "cover_letter"
    # Tailoring, coverage planning, optimizing, rewriting, revising, intros.
    return "resume"


# Human-readable names for each pipeline step, shown in the Analytics timeline.
PURPOSE_LABELS: dict[str, str] = {
    "extract_requirements": "Read the job",
    "plan_coverage": "Plan coverage",
    "optimize_resume": "Tailor résumé",
    "rewrite_resume": "Rewrite bullets",
    "revise_resume": "Apply your edits",
    "generate_profile_intro": "Draft intro",
    "cover_letter": "Cover letter",
    "outreach": "Outreach message",
}


def label_for(purpose: str) -> str:
    """A friendly label for an LLM-usage purpose (falls back to a prettified key)."""
    if purpose in PURPOSE_LABELS:
        return PURPOSE_LABELS[purpose]
    return (purpose or "").replace("_", " ").strip().capitalize() or "AI call"


def accrue_usage(
    application: Application,
    entries: Iterable[tuple[str, Usage]],
    *,
    reset: bool = False,
) -> None:
    """Fold a run's per-call usage into the application's totals and breakdown.

    ``reset=True`` starts the breakdown fresh — a re-tailor replaces everything.
    Otherwise the entries are added on top (a revise, cover letter, or outreach).
    Totals are always recomputed as the sum of the breakdown, so they stay
    consistent with it no matter the path.
    """
    breakdown: dict[str, dict[str, float]] = (
        {} if reset else {k: dict(v) for k, v in (application.cost_breakdown or {}).items()}
    )
    for purpose, usage in entries:
        slot = breakdown.setdefault(
            category_for(purpose), {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
        )
        slot["input_tokens"] += usage.input_tokens
        slot["output_tokens"] += usage.output_tokens
        slot["cost_usd"] = round(slot["cost_usd"] + usage.cost_usd, 6)

    application.cost_breakdown = breakdown
    application.total_input_tokens = sum(int(s["input_tokens"]) for s in breakdown.values())
    application.total_output_tokens = sum(int(s["output_tokens"]) for s in breakdown.values())
    application.total_cost_usd = round(sum(s["cost_usd"] for s in breakdown.values()), 6)
