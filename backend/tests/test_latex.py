"""LaTeX escaping, rendering, and compilation tests.

The compile tests are marked ``slow`` because Tectonic may need to fetch support
files on a cold cache. Run everything except those with ``-m 'not slow'``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.latex.compiler import (
    LatexCompilationError,
    compile_latex,
    tectonic_available,
)
from app.services.latex.escaping import TexSafe, display_url, escape_tex, escape_url
from app.services.latex.renderer import render_cover_letter, render_resume

# Resolved from this file rather than the working directory, so the suite does
# not depend on a symlink or on being invoked from backend/.
TEMPLATES_DIR = str(Path(__file__).resolve().parents[2] / "templates")


class TestEscaping:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("Procter & Gamble", r"Procter \& Gamble"),
            ("99% uptime", r"99\% uptime"),
            ("C#", r"C\#"),
            ("$1,000", r"\$1,000"),
            ("cache_layer", r"cache\_layer"),
            ("a{b}c", r"a\{b\}c"),
            ("~200", r"\textasciitilde{}200"),
            ("2^10", r"2\textasciicircum{}10"),
            ("a|b", r"a\textbar{}b"),
            ("<script>", r"\textless{}script\textgreater{}"),
        ],
    )
    def test_metacharacters(self, raw: str, expected: str):
        assert escape_tex(raw) == expected

    def test_backslash_replacement_is_not_re_escaped(self):
        """Regression: sequential replaces mangled \\textbackslash{} into
        \\textbackslash\\{\\}, silently defeating injection escaping."""
        assert escape_tex("\\") == r"\textbackslash{}"
        assert r"\textbackslash\{\}" not in escape_tex("\\")

    def test_neutralizes_latex_injection(self):
        escaped = escape_tex(r"\input{/etc/passwd} \write18{rm -rf /}")
        assert r"\input{" not in escaped
        assert r"\write18{" not in escaped
        assert escaped.startswith(r"\textbackslash{}input")

    def test_ellipsis_command_survives_escaping(self):
        """A replacement that is itself a LaTeX command must not be re-escaped."""
        assert escape_tex("wait…") == r"wait\ldots{}"

    def test_smart_typography(self):
        assert escape_tex("“q”") == "``q''"
        assert escape_tex("a—b") == "a---b"
        assert escape_tex("it’s") == "it's"

    def test_strips_control_characters(self):
        assert escape_tex("a\x00b\x07c") == "abc"

    def test_is_idempotent_via_marker(self):
        once = escape_tex("50% & rising")
        assert escape_tex(once) == once
        assert isinstance(once, TexSafe)

    def test_handles_none_and_numbers(self):
        assert escape_tex(None) == ""
        assert escape_tex(42) == "42"


class TestUrls:
    def test_rejects_dangerous_schemes(self):
        assert escape_url("javascript:alert(1)") == ""
        assert escape_url("file:///etc/passwd") == ""

    def test_allows_web_schemes(self):
        assert escape_url("https://example.com/a?b=1") == "https://example.com/a?b=1"

    def test_adds_scheme_when_missing(self):
        assert escape_url("example.com").startswith("https://")

    def test_escapes_latex_hostile_characters(self):
        assert escape_url("https://x.com/a%20b") == r"https://x.com/a\%20b"

    def test_display_strips_scheme_and_www(self):
        assert display_url("https://www.example.com/") == "example.com"


class TestRendering:
    def test_produces_complete_document(self, master):
        tex = render_resume(master, TEMPLATES_DIR)
        assert r"\begin{document}" in tex
        assert r"\end{document}" in tex

    def test_template_comments_do_not_leak_into_output(self, master):
        """Regression: a stray closing delimiter inside a comment dumped the
        comment prose into the document body."""
        tex = render_resume(master, TEMPLATES_DIR)
        body = tex.split(r"\begin{document}", 1)[1]
        assert "ATS notes" not in body
        assert "HireCraft base resume template" not in tex

    def test_escapes_content_from_the_resume(self, master):
        master.experience[0].company = "Procter & Gamble"
        tex = render_resume(master, TEMPLATES_DIR)
        assert r"Procter \& Gamble" in tex

    def test_url_filter_output_is_not_double_escaped(self, master):
        master.basics.github = "https://github.com/hasnainrazaa03"  # type: ignore[assignment]
        tex = render_resume(master, TEMPLATES_DIR)
        assert "github.com/hasnainrazaa03" in tex
        assert r"https:\textbackslash" not in tex

    def test_empty_sections_are_omitted(self, master):
        tex = render_resume(master, TEMPLATES_DIR)
        assert r"\section{Publications}" not in tex
        assert r"\section{Experience}" in tex

    def test_cover_letter_renders(self, master):
        tex = render_cover_letter(
            master,
            ["First paragraph.", "Second & final paragraph."],
            TEMPLATES_DIR,
            company="Globex & Co.",
            date_line="July 23, 2026",
        )
        assert r"Globex \& Co." in tex
        assert r"\end{document}" in tex


@pytest.mark.slow
@pytest.mark.skipif(not tectonic_available(), reason="tectonic not installed")
class TestCompilation:
    def test_compiles_resume_to_pdf(self, master):
        result = compile_latex(render_resume(master, TEMPLATES_DIR), job_name="resume")
        assert result.pdf_bytes.startswith(b"%PDF")
        assert result.page_count >= 1

    def test_compiles_resume_containing_every_metacharacter(self, master):
        master.experience[0].company = "Procter & Gamble"
        master.experience[0].highlights = [
            r"Cut cost 30% via cache_layer{} with ~200 keys & $5 budget",
            r"Neutralized \input{/etc/passwd} and \write18{rm -rf /}",
        ]
        result = compile_latex(render_resume(master, TEMPLATES_DIR), job_name="nasty")
        assert result.pdf_bytes.startswith(b"%PDF")

    def test_raises_with_useful_summary_on_broken_source(self):
        with pytest.raises(LatexCompilationError) as exc:
            compile_latex(r"\documentclass{article}\begin{document}\undefinedcmd")
        assert exc.value.summary()
