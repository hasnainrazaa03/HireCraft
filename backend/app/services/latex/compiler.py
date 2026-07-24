"""PDF compilation via Tectonic.

Runs in an isolated temporary directory with ``--untrusted`` so shell-escape and
other known-insecure TeX features are disabled, and with a hard wall-clock
timeout so a pathological document cannot pin a worker forever.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Pull the meaningful line out of a LaTeX log, e.g.
# "! Undefined control sequence." / "! LaTeX Error: File `foo.sty' not found."
_ERROR_LINE = re.compile(r"^!.*$", re.MULTILINE)
_LINE_NUMBER = re.compile(r"^l\.(\d+)", re.MULTILINE)


class LatexCompilationError(Exception):
    """Raised when Tectonic fails to produce a PDF."""

    def __init__(self, message: str, *, log: str = "", tex_source: str = ""):
        super().__init__(message)
        self.log = log
        self.tex_source = tex_source

    def summary(self, max_errors: int = 5) -> str:
        """A short, user-presentable explanation of what went wrong."""
        errors = _ERROR_LINE.findall(self.log)[:max_errors]
        if not errors:
            return str(self)
        lines = [e.strip() for e in errors]
        if match := _LINE_NUMBER.search(self.log):
            lines.append(f"(near source line {match.group(1)})")
        return " | ".join(lines)


@dataclass(frozen=True)
class CompileResult:
    pdf_bytes: bytes
    log: str
    page_count: int


def _count_pages(pdf: bytes) -> int:
    """Cheap page count without pulling in a PDF library."""
    return max(pdf.count(b"/Type /Page") - pdf.count(b"/Type /Pages"), pdf.count(b"/Type/Page") - pdf.count(b"/Type/Pages"), 0) or 1


def tectonic_available() -> bool:
    return shutil.which(settings.tectonic_binary) is not None


def compile_latex(
    tex_source: str,
    *,
    timeout: int | None = None,
    job_name: str = "document",
) -> CompileResult:
    """Compile ``tex_source`` and return the resulting PDF bytes.

    Raises:
        LatexCompilationError: if Tectonic exits non-zero, times out, or produces
            no PDF.
    """
    if not tectonic_available():
        raise LatexCompilationError(
            f"Tectonic binary {settings.tectonic_binary!r} not found on PATH. "
            f"Install it with `brew install tectonic`, or run inside Docker."
        )

    timeout = timeout or settings.latex_timeout_seconds
    safe_name = re.sub(r"[^A-Za-z0-9_-]", "_", job_name)[:64] or "document"

    with tempfile.TemporaryDirectory(prefix="hirecraft-tex-") as tmpdir:
        workdir = Path(tmpdir)
        tex_path = workdir / f"{safe_name}.tex"
        tex_path.write_text(tex_source, encoding="utf-8")

        command = [
            settings.tectonic_binary,
            "--untrusted",       # disable shell-escape and other risky features
            "--keep-logs",
            "--chatter", "minimal",
            "--outdir", str(workdir),
            str(tex_path),
        ]

        try:
            process = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=workdir,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise LatexCompilationError(
                f"LaTeX compilation exceeded {timeout}s and was aborted.",
                tex_source=tex_source,
            ) from exc
        except OSError as exc:  # pragma: no cover - environment failure
            raise LatexCompilationError(
                f"Could not execute Tectonic: {exc}", tex_source=tex_source
            ) from exc

        log_path = workdir / f"{safe_name}.log"
        log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        combined_log = "\n".join(filter(None, [process.stdout, process.stderr, log_text]))

        pdf_path = workdir / f"{safe_name}.pdf"
        if process.returncode != 0 or not pdf_path.exists():
            error = LatexCompilationError(
                f"Tectonic exited with code {process.returncode} and produced no PDF.",
                log=combined_log,
                tex_source=tex_source,
            )
            logger.error(
                "latex.compile_failed",
                returncode=process.returncode,
                summary=error.summary(),
            )
            raise error

        pdf_bytes = pdf_path.read_bytes()
        if not pdf_bytes.startswith(b"%PDF"):
            raise LatexCompilationError(
                "Tectonic produced a file that is not a valid PDF.",
                log=combined_log,
                tex_source=tex_source,
            )

        pages = _count_pages(pdf_bytes)
        logger.info("latex.compiled", bytes=len(pdf_bytes), pages=pages, job=safe_name)
        return CompileResult(pdf_bytes=pdf_bytes, log=combined_log, page_count=pages)
