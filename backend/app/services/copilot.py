"""Résumé Copilot: grounded question-answering over the user's own data.

The retrieval is deterministic — we gather the exact structured facts a question
might need (résumé score + findings, guardrail decisions on an application, job
match, skill gaps, the funnel) into a compact briefing. The model then answers
using ONLY that briefing, so the copilot explains real decisions HireCraft made
rather than inventing plausible-sounding ones.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.logging import get_logger
from app.models.application import Application
from app.models.resume import ResumeProfile
from app.schemas.copilot import CopilotRequest
from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.services.analysis import analyze_resume
from app.services.dashboard import build_overview
from app.services.evidence import evidence_lines
from app.services.llm.client import get_client
from app.services.llm.prompts import COPILOT_SYSTEM, build_copilot_prompt
from app.services.matching import match_resume_to_job, skill_gaps
from app.services.pipeline import UsageLedger

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from app.services.llm.factory import LlmClient

logger = get_logger(__name__)


def _pick_resume(
    db: Session, user_id: uuid.UUID, resume_id: uuid.UUID | None
) -> ResumeProfile | None:
    if resume_id is not None:
        profile = db.get(ResumeProfile, resume_id)
        return profile if profile and profile.user_id == user_id else None
    return db.scalar(
        select(ResumeProfile)
        .where(ResumeProfile.user_id == user_id)
        .order_by(ResumeProfile.is_default.desc(), ResumeProfile.updated_at.desc())
    )


def build_context(
    db: Session,
    user_id: uuid.UUID,
    *,
    resume_id: uuid.UUID | None = None,
    application_id: uuid.UUID | None = None,
) -> tuple[str, list[str]]:
    """Assemble the grounding briefing. Returns (context_text, section_labels)."""
    sections: list[str] = []
    labels: list[str] = []

    profile = _pick_resume(db, user_id, resume_id)
    resume: MasterResume | None = None
    if profile is not None:
        resume = MasterResume.model_validate(profile.content)
        analysis = analyze_resume(resume)
        weak = [f"{f.title}: {f.detail}" for f in analysis.findings if f.severity in ("warning", "critical")]
        sections.append(
            f"[RÉSUMÉ: {profile.name}]\n"
            f"Overall score {analysis.overall_score}/100 ({analysis.grade}); "
            f"ATS {analysis.ats_score}/100; {analysis.quantified_bullets}/"
            f"{analysis.bullet_count} bullets quantified; ~{analysis.estimated_pages} pages.\n"
            "Weak areas:\n" + ("\n".join(f"- {w}" for w in weak[:8]) or "- none flagged")
        )
        labels.append(f"Résumé score & findings ({profile.name})")

    evidence = evidence_lines(db, user_id)
    if evidence:
        sections.append(
            "[BRAG BANK — attested facts the candidate can speak to]\n"
            + "\n".join(f"- {e}" for e in evidence[:40])
        )
        labels.append(f"Brag bank ({len(evidence)} facts)")

    if application_id is not None:
        application = db.scalar(
            select(Application)
            .where(Application.id == application_id, Application.user_id == user_id)
            .options(selectinload(Application.job))
        )
        if application is not None:
            role = (application.job.title if application.job else None) or "this role"
            report = application.guardrail_report or {}
            blocked = [
                v.get("detail", "")
                for v in report.get("violations", [])
                if v.get("severity") == "error"
            ]
            verified = report.get("keywords_verified", []) or []
            requested = report.get("keywords_requested", []) or []
            missing_kw = [k for k in requested if k not in verified]
            confidence = report.get("bullet_confidence", []) or []
            conf_counts: dict[str, int] = {}
            for c in confidence:
                conf_counts[c.get("confidence", "?")] = conf_counts.get(c.get("confidence", "?"), 0) + 1

            gr_lines = [
                f"[APPLICATION: {role}"
                + (f" at {application.job.company}" if application.job and application.job.company else "")
                + "]",
                f"Tracker stage: {application.tracker_status.value}.",
            ]
            if blocked:
                gr_lines.append(
                    "Claims the guardrails REMOVED (unsupported by the résumé):\n"
                    + "\n".join(f"- {b}" for b in blocked[:6])
                )
            else:
                gr_lines.append("Guardrails removed nothing — every tailored line was supported.")
            if requested:
                gr_lines.append(
                    f"ATS keywords covered: {', '.join(verified) or 'none'}. "
                    f"Not backed by the résumé (so not claimed): {', '.join(missing_kw) or 'none'}."
                )
            if conf_counts:
                gr_lines.append(
                    "Per-bullet confidence: "
                    + ", ".join(f"{n} {lvl}" for lvl, n in sorted(conf_counts.items()))
                )
            sections.append("\n".join(gr_lines))
            labels.append(f"Guardrail decisions ({role})")

            # Fit score for this specific job.
            if resume is not None and application.job and application.job.requirements:
                try:
                    reqs = JobRequirements.model_validate(application.job.requirements)
                    match = match_resume_to_job(resume, reqs)
                    missing = [h.name for h in match.missing_skills][:8]
                    sections.append(
                        f"[JOB MATCH: {role}]\n"
                        f"Fit {match.overall_score}/100 ({match.verdict}). "
                        f"Missing skills: {', '.join(missing) or 'none'}.\n"
                        + "\n".join(f"- {g}" for g in match.gaps[:5])
                    )
                    labels.append(f"Job match ({role})")
                except Exception:  # noqa: BLE001 - malformed requirements shouldn't break chat
                    pass

    # Cross-job skill gaps (always useful for "what should I learn / add?").
    if resume is not None:
        apps = db.scalars(
            select(Application)
            .where(Application.user_id == user_id)
            .options(selectinload(Application.job))
        ).all()
        req_sets = []
        for a in apps:
            if a.job and a.job.requirements:
                try:
                    req_sets.append(JobRequirements.model_validate(a.job.requirements))
                except Exception:  # noqa: BLE001
                    continue
        if req_sets:
            report = skill_gaps(resume, req_sets)
            top = [f"{s.name} (wanted by {s.demand})" for s in report.top_missing[:8]]
            sections.append(
                f"[SKILL GAPS ACROSS {report.jobs_analyzed} SAVED JOBS]\n"
                f"Average match {report.average_match}/100. "
                f"Most in-demand skills you're missing: {', '.join(top) or 'none'}."
            )
            labels.append("Skill gaps across saved jobs")

    # A light funnel snapshot for questions about overall progress.
    overview = build_overview(db, user_id)
    f = overview.funnel
    if f.total > 0:
        sections.append(
            f"[JOB-SEARCH FUNNEL]\n{f.total} applications, {f.submitted} submitted, "
            f"{f.interviewing} interviewing, {f.offers} offer(s). "
            f"Response {round(f.response_rate * 100)}%, interview {round(f.interview_rate * 100)}%."
        )
        labels.append("Job-search funnel")

    return "\n\n".join(sections), labels


def answer(
    db: Session,
    user_id: uuid.UUID,
    request: CopilotRequest,
    *,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> tuple[str, list[str]]:
    client = client or get_client()
    context, labels = build_context(
        db,
        user_id,
        resume_id=request.resume_profile_id,
        application_id=request.application_id,
    )
    history = [(m.role, m.content) for m in request.history[-8:]]
    result = client.generate_text(
        prompt=build_copilot_prompt(context, history, request.message),
        system_instruction=COPILOT_SYSTEM,
        temperature=0.3,
    )
    if ledger is not None:
        ledger.record("copilot", result.usage)
    logger.info("copilot.answered", grounded=len(labels))
    return result.text, labels
