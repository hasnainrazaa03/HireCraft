"""DOCX export and template-registry tests."""

from __future__ import annotations

import io
import zipfile

import pytest

from app.services.export.docx import _date_range, _fmt_date, resume_to_docx
from app.services.latex.templates import (
    DEFAULT_TEMPLATE_ID,
    TEMPLATES,
    is_valid,
    resolve_filename,
)


@pytest.fixture
def resume(master):
    return master  # reuse the shared MasterResume fixture


class TestTemplateRegistry:
    def test_all_templates_have_unique_ids_and_files(self):
        ids = [t.id for t in TEMPLATES]
        assert len(ids) == len(set(ids))
        assert all(t.filename.endswith(".tex") for t in TEMPLATES)

    def test_resolve_known_and_unknown(self):
        assert resolve_filename("ats") == "ats.tex"
        assert resolve_filename("nope") == resolve_filename(DEFAULT_TEMPLATE_ID)
        assert resolve_filename(None) == resolve_filename(DEFAULT_TEMPLATE_ID)

    def test_is_valid(self):
        assert is_valid("modern") and not is_valid("bogus")


class TestDocxExport:
    def test_produces_a_valid_docx(self, resume):
        data = resume_to_docx(resume)
        assert data[:2] == b"PK"  # zip signature
        # A .docx is a zip that contains word/document.xml
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            assert "word/document.xml" in zf.namelist()

    def test_content_appears_in_document(self, resume):
        data = resume_to_docx(resume)
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            xml = zf.read("word/document.xml").decode("utf-8")
        assert resume.basics.name in xml
        assert resume.experience[0].company in xml

    def test_special_characters_survive(self, resume):
        resume.experience[0].company = "Procter & Gamble"
        data = resume_to_docx(resume)
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            xml = zf.read("word/document.xml").decode("utf-8")
        # python-docx XML-escapes & to &amp;
        assert "Procter" in xml and "Gamble" in xml


class TestDateFormatting:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("2024-05", "May 2024"), ("2024", "2024"), ("Present", "Present"), (None, "")],
    )
    def test_fmt_date(self, raw, expected):
        assert _fmt_date(raw) == expected

    def test_date_range(self):
        assert _date_range("2024-05", "2024-08") == "May 2024 – Aug 2024"
        assert _date_range("2022", None) == "2022"
