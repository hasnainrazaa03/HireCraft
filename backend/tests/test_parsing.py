"""Résumé text-extraction and date-repair tests (no LLM).

Generates real PDF and DOCX bytes in-test so the extractors are exercised
end to end, then checks the format router and the date-repair pass that lets
"May 2024"-style dates survive import.
"""

from __future__ import annotations

import pytest

from app.services.parsing.extract import ExtractionError, extract, extract_latex
from app.services.parsing.structure import _repair, _repair_date, _repair_dates, _repair_url

SAMPLE = (
    "Jane Candidate\nSoftware Engineer\njane@example.com\n\n"
    "EXPERIENCE\nAcme Corp — SWE Intern (May 2024 - Aug 2024)\n"
    "- Built an internal dashboard used by 200 people\n"
)


class TestExtraction:
    def test_plaintext(self):
        text = extract("resume.txt", SAMPLE.encode())
        assert "Jane Candidate" in text and "Acme Corp" in text

    def test_latex_strips_commands_keeps_content(self):
        tex = (
            r"\documentclass{article}\begin{document}"
            r"\section{Experience} Built \textbf{systems} at Procter \& Gamble in 2023."
            r"\end{document}"
        )
        text = extract_latex(tex.encode())
        assert "Procter & Gamble" in text  # escaped & restored
        assert "\\section" not in text and "\\textbf" not in text

    def test_pdf_roundtrip(self):
        pytest.importorskip("reportlab")
        from io import BytesIO

        from reportlab.pdfgen import canvas

        buf = BytesIO()
        pdf = canvas.Canvas(buf)
        text_obj = pdf.beginText(40, 800)
        for line in SAMPLE.splitlines():
            text_obj.textLine(line)
        pdf.drawText(text_obj)
        pdf.save()

        text = extract("resume.pdf", buf.getvalue())
        assert "Jane Candidate" in text

    def test_docx_roundtrip(self):
        from io import BytesIO

        import docx

        document = docx.Document()
        for line in SAMPLE.splitlines():
            document.add_paragraph(line)
        buf = BytesIO()
        document.save(buf)

        text = extract("resume.docx", buf.getvalue())
        assert "Acme Corp" in text

    def test_unsupported_extension(self):
        with pytest.raises(ExtractionError, match="Unsupported"):
            extract("resume.exe", b"whatever")

    def test_too_short(self):
        with pytest.raises(ExtractionError):
            extract("resume.txt", b"hi")


class TestDateRepair:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("May 2024", "2024-05"),
            ("Jan. 2023", "2023-01"),
            ("September 2022", "2022-09"),
            ("Present", "Present"),
            ("current", "Present"),
            ("2024", "2024"),
            ("2024-05", "2024-05"),
            ("garbled", "garbled"),
        ],
    )
    def test_repair_date(self, raw: str, expected: str):
        assert _repair_date(raw) == expected

    def test_repair_dates_walks_entries(self):
        payload = {
            "experience": [{"start_date": "May 2024", "end_date": "Present"}],
            "education": [{"start_date": "2020", "end_date": "Jun 2024"}],
        }
        fixed = _repair_dates(payload)
        assert fixed["experience"][0]["start_date"] == "2024-05"
        assert fixed["education"][0]["end_date"] == "2024-06"


class TestUrlAndSchemaRepair:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("github.com/jane", "https://github.com/jane"),
            ("https://x.com/a", "https://x.com/a"),
            ("linkedin.com/in/jane", "https://linkedin.com/in/jane"),
            ("not a url", None),
            ("plaintext", None),
            ("", None),
        ],
    )
    def test_repair_url(self, raw, expected):
        assert _repair_url(raw) == expected

    def test_repair_fixes_scheme_and_version_and_dates(self):
        """Regression: a faithfully-parsed résumé with a bare github URL, a
        '1.0.0' schema version, and a 'May 2024' date must validate."""
        from app.schemas.resume import MasterResume

        payload = {
            "schema_version": "1.0.0",
            "basics": {
                "name": "Jane",
                "email": "jane@example.com",
                "github": "github.com/jane",
            },
            "experience": [
                {
                    "company": "Acme",
                    "title": "Intern",
                    "start_date": "May 2024",
                    "end_date": "Present",
                    "highlights": ["Did a thing"],
                }
            ],
        }
        MasterResume.model_validate(_repair(payload))  # must not raise

    def test_repair_drops_unusable_link(self):
        payload = {"basics": {"name": "X", "email": "x@y.co", "links": [{"label": "site", "url": "not a url"}]}}
        assert _repair(payload)["basics"]["links"] == []


class TestSalvage:
    """Import is best-effort: one bad field shouldn't reject the whole résumé."""

    def test_nulls_a_bad_optional_field_and_keeps_the_entry(self):
        from app.services.parsing.structure import _coerce_valid

        payload = {
            "basics": {"name": "Jane", "email": "jane@x.co", "github": "not a url"},
            "experience": [
                {"company": "Good", "title": "Eng", "start_date": "2024", "highlights": ["Built X for 5 teams"]},
                {"company": "Bad", "title": "Eng", "start_date": "sometime last year", "highlights": ["did stuff"]},
            ],
        }
        resume = _coerce_valid(payload)
        assert len(resume.experience) == 2  # bad date nulled, entry kept
        assert resume.basics.github is None

    def test_drops_entry_when_a_required_field_is_bad(self):
        from app.services.parsing.structure import _coerce_valid

        payload = {
            "basics": {"name": "Jane", "email": "jane@x.co"},
            "experience": [
                {"company": "Good", "title": "Eng", "start_date": "2024", "highlights": ["Built X for 5 teams"]},
                {"title": "Eng", "start_date": "2024", "highlights": ["orphan, no company"]},  # missing required company
            ],
        }
        resume = _coerce_valid(payload)
        assert len(resume.experience) == 1
        assert resume.experience[0].company == "Good"

    def test_unsalvageable_raises_parsing_error(self):
        from app.services.parsing.structure import ParsingError, _coerce_valid

        with pytest.raises(ParsingError):
            _coerce_valid({"basics": {"name": "X"}})  # no email, no content
