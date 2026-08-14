"""craft — drive HireCraft's résumé pipeline with Claude Code as the LLM.

The normal app path calls a hosted LLM (Gemini/Anthropic) to (a) read the job into
structured requirements and (b) tailor the résumé. This CLI lets *Claude Code* do
those two reasoning steps instead — you author the requirements + tailoring JSON —
while HireCraft's own deterministic machinery (guardrail vetting, LaTeX rendering,
scoring, persistence) does the rest. Net result: a fully-populated application that
shows up on the dashboard, using zero hosted-LLM tokens.

Workflow
--------
1.  craft.py context --user you@x.com --profile MHR_ML --url <job-url>
      → prints the job text + your master résumé JSON + brag-bank evidence.
2.  (Claude Code authors) requirements.json + tailoring.json [+ cover.json]
      matching app.schemas.job.JobRequirements / app.schemas.tailoring.TailoringResult.
3.  craft.py build --user you@x.com --profile MHR_ML --url <job-url> \
        --requirements requirements.json --tailoring tailoring.json [--cover cover.json]
      → creates the Job + Application, vets everything against the master résumé
        (same guardrails as the live pipeline), renders the PDF (one-page fit),
        stores artifacts, and marks it COMPLETED. Prints the application id.
4.  Open it on the dashboard.  (craft.py rm --app <id> deletes a test run.)

Run inside the api container:
    docker compose exec -T api python scripts/craft.py <command> ...
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid

# Allow `python scripts/craft.py …` from the app root (adds /app to the path).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select

from app.core.config import settings
from app.models.application import (
    Application,
    ApplicationArtifact,
    ArtifactKind,
    PipelineStatus,
)
from app.models.job import Job
from app.models.resume import ResumeProfile
from app.models.user import User
from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.schemas.tailoring import TailoringResult
from app.services import storage
from app.services.activity import log_event
from app.services.evidence import evidence_lines
from app.services.latex.compiler import compile_latex
from app.services.latex.renderer import render_and_fit, render_cover_letter
from app.services.latex.templates import resolve_filename
from app.services.llm.guardrails import GuardrailEngine, build_diff
from app.services.scraper import ScrapeError, from_pasted_text, scrape_job
from app.db.session import SessionLocal


def _err(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def _get_user(db, email: str) -> User:
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        _err(f"no user with email {email!r}")
    return user


def _get_profile(db, user: User, ref: str) -> ResumeProfile:
    """Resolve a résumé profile by UUID or by (case-insensitive) name."""
    profiles = db.execute(
        select(ResumeProfile).where(ResumeProfile.user_id == user.id)
    ).scalars().all()
    try:
        pid = uuid.UUID(ref)
        for p in profiles:
            if p.id == pid:
                return p
    except ValueError:
        pass
    for p in profiles:
        if p.name.lower() == ref.lower():
            return p
    names = ", ".join(p.name for p in profiles)
    _err(f"no résumé profile {ref!r} for {user.email} (have: {names})")


def _scrape(url: str | None, text_file: str | None, title: str | None, company: str | None):
    if url:
        try:
            return scrape_job(url)
        except ScrapeError as exc:
            _err(f"couldn't read {url} — {exc}")
    if text_file:
        text = open(text_file, encoding="utf-8").read()
        return from_pasted_text(text, title=title, company=company)
    _err("provide --url or --text-file")


# --- commands ---------------------------------------------------------------


def cmd_context(args: argparse.Namespace) -> None:
    with SessionLocal() as db:
        user = _get_user(db, args.user)
        profile = _get_profile(db, user, args.profile)
        scrape = _scrape(args.url, args.text_file, args.title, args.company)
        bundle = {
            "profile": {"id": str(profile.id), "name": profile.name, "one_page": profile.one_page},
            "job": {
                "url": scrape.url,
                "source": scrape.source,
                "company": scrape.company,
                "title": scrape.title,
                "location": scrape.location,
                "raw_text": scrape.text,
            },
            "master_resume": profile.content,
            "evidence": evidence_lines(db, user.id),
        }
        print(json.dumps(bundle, indent=2, ensure_ascii=False))


def cmd_build(args: argparse.Namespace) -> None:
    requirements = JobRequirements.model_validate(json.load(open(args.requirements, encoding="utf-8")))
    tailoring = TailoringResult.model_validate(json.load(open(args.tailoring, encoding="utf-8")))
    cover_paragraphs: list[str] = []
    if args.cover:
        raw = json.load(open(args.cover, encoding="utf-8"))
        cover_paragraphs = raw["paragraphs"] if isinstance(raw, dict) else list(raw)

    with SessionLocal() as db:
        user = _get_user(db, args.user)
        profile = _get_profile(db, user, args.profile)
        master = MasterResume.model_validate(profile.content)
        evidence = evidence_lines(db, user.id)

        scrape = _scrape(args.url, args.text_file, args.title, args.company)
        job = Job(
            user_id=user.id,
            url=scrape.url,
            source=scrape.source,
            title=args.title or requirements.title or scrape.title,
            company=args.company or requirements.company or scrape.company,
            location=scrape.location,
            raw_text=scrape.text,
            requirements=requirements.model_dump(mode="json"),
        )
        db.add(job)
        db.flush()

        application = Application(
            user_id=user.id,
            job_id=job.id,
            resume_profile_id=profile.id,
            pipeline_status=PipelineStatus.PENDING,
            include_cover_letter=bool(cover_paragraphs),
            reach_mode=args.reach,
        )
        db.add(application)
        db.flush()

        # Same guardrail vetting the live pipeline runs — invented numbers/tools in
        # the authored tailoring are dropped exactly as they would be for an LLM.
        tailored, report = GuardrailEngine(
            master, requirements, evidence=evidence, reach=args.reach
        ).apply(tailoring)
        diff = build_diff(master, tailored)

        compiled, resume_tex = render_and_fit(
            tailored,
            settings.templates_dir,
            template_name=resolve_filename(profile.template),
            one_page=profile.one_page,
            job_name="resume",
        )

        artifacts: list[tuple[ArtifactKind, str, bytes, str]] = [
            (ArtifactKind.RESUME_PDF, "resume.pdf", compiled.pdf_bytes, "application/pdf"),
            (ArtifactKind.RESUME_TEX, "resume.tex", resume_tex.encode("utf-8"), "application/x-tex"),
        ]

        kept_cover: list[str] = []
        if cover_paragraphs:
            engine = GuardrailEngine(tailored, requirements, evidence=evidence)
            kept_cover = [p for p in cover_paragraphs if engine.vet_paragraph(p) is not None]
            if kept_cover:
                cover_tex = render_cover_letter(
                    tailored, kept_cover, settings.templates_dir,
                    company=requirements.company, role=requirements.title,
                )
                cover_pdf = compile_latex(cover_tex, job_name="cover_letter").pdf_bytes
                artifacts += [
                    (ArtifactKind.COVER_LETTER_PDF, "cover_letter.pdf", cover_pdf, "application/pdf"),
                    (ArtifactKind.COVER_LETTER_TEX, "cover_letter.tex", cover_tex.encode("utf-8"), "application/x-tex"),
                ]

        for kind, filename, data, content_type in artifacts:
            relative = storage.build_relative_path(user.id, application.id, filename)
            size = storage.save_bytes(relative, data)
            db.add(ApplicationArtifact(
                application_id=application.id, kind=kind,
                storage_path=relative, size_bytes=size, content_type=content_type,
            ))

        application.tailored_resume = tailored.model_dump(mode="json")
        application.diff = [d.model_dump(mode="json") for d in diff]
        application.guardrail_report = report.model_dump(mode="json")
        if kept_cover:
            application.cover_letter = kept_cover
        application.pipeline_status = PipelineStatus.COMPLETED
        application.error_message = None
        log_event(application, "tailored", "Résumé tailored (via Claude Code)")
        db.commit()

        flags = len(report.violations)
        cov = getattr(report, "keyword_coverage", None)
        print(json.dumps({
            "application_id": str(application.id),
            "company": job.company,
            "title": job.title,
            "pages": compiled.page_count,
            "keyword_coverage": cov,
            "guardrail_flags": flags,
            "cover_letter_paragraphs": len(kept_cover),
            "dashboard": f"/applications/{application.id}",
        }, indent=2, ensure_ascii=False))


def cmd_eval(args: argparse.Namespace) -> None:
    """Benchmark two (or more) tailored applications head-to-head using HireCraft's
    own deterministic scorer, job-match, and real page counts — no LLM."""
    import io

    from pypdf import PdfReader
    from sqlalchemy import func

    from app.models.llm_usage import LlmUsage
    from app.schemas.job import JobRequirements
    from app.schemas.tailoring import GuardrailReport
    from app.services.matching import match_resume_to_job
    from app.services.resume_eval import score_from_report

    with SessionLocal() as db:
        cols = []
        for aid in args.app:
            app = db.get(Application, uuid.UUID(aid))
            if app is None or app.tailored_resume is None:
                _err(f"application {aid} not found or not tailored")
            resume = MasterResume.model_validate(app.tailored_resume)
            report = GuardrailReport.model_validate(app.guardrail_report or {})
            company = app.job.company if app.job else None
            card = score_from_report(resume, report, company=company)
            reqs = (
                JobRequirements.model_validate(app.job.requirements)
                if app.job and app.job.requirements else None
            )
            match = match_resume_to_job(resume, reqs) if reqs else None
            pdf = next((a for a in app.artifacts if a.kind.value == "resume_pdf"), None)
            pages = None
            if pdf is not None:
                try:
                    data = open(storage.resolve_path(pdf.storage_path), "rb").read()
                    pages = len(PdfReader(io.BytesIO(data)).pages)
                except Exception:  # noqa: BLE001
                    pages = None
            n_calls = db.scalar(select(func.count(LlmUsage.id)).where(LlmUsage.application_id == app.id)) or 0
            cols.append({
                "id": str(app.id)[:8],
                "engine": "CLI (Claude Code)" if n_calls == 0 else "In-app (hosted LLM)",
                "overall": card.overall,
                "metrics": {m.key: (m.score, m.measured) for m in card.metrics},
                "match": match.overall_score if match else None,
                "verdict": match.verdict if match else None,
                "pages": pages,
                "errors": sum(1 for v in report.violations if v.severity == "error"),
                "warnings": sum(1 for v in report.violations if v.severity == "warning"),
                "cost": app.total_cost_usd,
                "calls": n_calls,
            })

        metric_keys = list(cols[0]["metrics"].keys())
        w = 22
        def row(label, vals):
            print(f"  {label:<26}" + "".join(f"{str(v):<{w}}" for v in vals))
        print("\n=== BENCHMARK ===")
        row("", [c["engine"] for c in cols])
        row("application", [c["id"] for c in cols])
        row("Overall /100", [c["overall"] for c in cols])
        for k in metric_keys:
            row(f"  · {k}", [f"{c['metrics'][k][0]}{'' if c['metrics'][k][1] else ' (n/m)'}" for c in cols])
        row("Job match /100", [c["match"] for c in cols])
        row("  verdict", [c["verdict"] for c in cols])
        row("Pages", [c["pages"] for c in cols])
        row("Guardrail errors", [c["errors"] for c in cols])
        row("Guardrail warnings", [c["warnings"] for c in cols])
        row("Hosted-LLM cost", [f"${c['cost']:.5f}" for c in cols])
        row("Hosted-LLM calls", [c["calls"] for c in cols])

        # Verdict: quality (overall, then match), truthfulness (errors), then cost.
        best_q = max(cols, key=lambda c: (c["overall"], c["match"] or 0, -c["errors"]))
        cheapest = min(cols, key=lambda c: c["cost"])
        print("\n=== VERDICT ===")
        print(f"  Best quality:  {best_q['engine']} ({best_q['id']}) — overall {best_q['overall']}, match {best_q['match']}, {best_q['errors']} blocked claims")
        print(f"  Cheapest:      {cheapest['engine']} ({cheapest['id']}) — ${cheapest['cost']:.5f}")
        allsame = len({c["overall"] for c in cols}) == 1
        if allsame:
            print("  Quality is effectively tied → the cheaper engine wins on value.")


def cmd_rm(args: argparse.Namespace) -> None:
    with SessionLocal() as db:
        app = db.get(Application, uuid.UUID(args.app))
        if app is None:
            _err(f"no application {args.app}")
        db.delete(app)
        db.commit()
        print(f"deleted application {args.app}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="craft", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_ctx = sub.add_parser("context", help="dump job + master résumé + evidence to author a tailoring")
    p_ctx.add_argument("--user", required=True)
    p_ctx.add_argument("--profile", required=True)
    p_ctx.add_argument("--url")
    p_ctx.add_argument("--text-file")
    p_ctx.add_argument("--title")
    p_ctx.add_argument("--company")
    p_ctx.set_defaults(func=cmd_context)

    p_build = sub.add_parser("build", help="create the application from authored requirements + tailoring")
    p_build.add_argument("--user", required=True)
    p_build.add_argument("--profile", required=True)
    p_build.add_argument("--url")
    p_build.add_argument("--text-file")
    p_build.add_argument("--requirements", required=True)
    p_build.add_argument("--tailoring", required=True)
    p_build.add_argument("--cover")
    p_build.add_argument("--reach", action="store_true")
    p_build.add_argument("--title")
    p_build.add_argument("--company")
    p_build.set_defaults(func=cmd_build)

    p_eval = sub.add_parser("eval", help="benchmark two tailored applications head-to-head")
    p_eval.add_argument("--app", required=True, action="append", help="application id (pass twice)")
    p_eval.set_defaults(func=cmd_eval)

    p_rm = sub.add_parser("rm", help="delete an application (cleanup a test run)")
    p_rm.add_argument("--app", required=True)
    p_rm.set_defaults(func=cmd_rm)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
