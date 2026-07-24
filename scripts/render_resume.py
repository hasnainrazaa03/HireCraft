#!/usr/bin/env python3
"""Render a Master Resume JSON file straight to PDF, with no LLM involved.

Useful for iterating on the LaTeX template, and for checking that your master
resume validates before uploading it.

    python scripts/render_resume.py templates/example_master_resume.json -o out.pdf
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from pydantic import ValidationError  # noqa: E402

from app.schemas.resume import MasterResume  # noqa: E402
from app.services.latex.compiler import (  # noqa: E402
    LatexCompilationError,
    compile_latex,
    tectonic_available,
)
from app.services.latex.renderer import render_resume  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("resume", type=Path, help="Path to a Master Resume JSON file")
    parser.add_argument(
        "-o", "--output", type=Path, default=Path("resume.pdf"), help="Output PDF path"
    )
    parser.add_argument(
        "--templates",
        type=Path,
        default=REPO_ROOT / "templates",
        help="Templates directory",
    )
    parser.add_argument(
        "--tex-only", action="store_true", help="Write the .tex source and stop"
    )
    args = parser.parse_args()

    if not args.resume.is_file():
        print(f"error: {args.resume} not found", file=sys.stderr)
        return 1

    try:
        payload = json.loads(args.resume.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"error: {args.resume} is not valid JSON -- {exc}", file=sys.stderr)
        return 1

    try:
        resume = MasterResume.model_validate(payload)
    except ValidationError as exc:
        print(f"error: resume failed validation ({exc.error_count()} problem(s)):", file=sys.stderr)
        for error in exc.errors()[:15]:
            location = ".".join(str(p) for p in error["loc"]) or "(root)"
            print(f"  {location}: {error['msg']}", file=sys.stderr)
        return 1

    print(f"Validated resume for {resume.basics.name}")
    tex = render_resume(resume, str(args.templates))

    if args.tex_only:
        tex_path = args.output.with_suffix(".tex")
        tex_path.write_text(tex, encoding="utf-8")
        print(f"Wrote {tex_path}")
        return 0

    if not tectonic_available():
        print(
            "error: tectonic not found on PATH. Install with `brew install tectonic`.",
            file=sys.stderr,
        )
        return 1

    try:
        result = compile_latex(tex, job_name=args.output.stem)
    except LatexCompilationError as exc:
        print(f"error: LaTeX compilation failed -- {exc.summary()}", file=sys.stderr)
        return 1

    args.output.write_bytes(result.pdf_bytes)
    print(f"Wrote {args.output} ({len(result.pdf_bytes):,} bytes, {result.page_count} page(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
