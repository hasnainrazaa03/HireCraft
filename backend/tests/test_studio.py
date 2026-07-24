"""Writing studio tests: cover letters + outreach.

The studio shares the résumé's truthfulness guarantee — a letter or message may
be written in any tone or voice, but it must not out-claim the résumé. These
tests pin the prompt wiring (tone + voice reach the model), the guardrail
behaviour (invented metrics are caught), and that a cover letter exports to a
real .docx.
"""

from __future__ import annotations

from typing import get_args

from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume
from app.schemas.studio import CoverLetterTone, OutreachKind
from app.schemas.writing import VoiceProfile
from app.services.export.docx import cover_letter_to_docx
from app.services.llm.client import LlmResult, Usage
from app.services.llm.prompts import (
    COVER_LETTER_TONES,
    OUTREACH_KINDS,
    build_cover_letter_prompt,
    build_outreach_prompt,
)
from app.services.pipeline import (
    CoverLetterDraft,
    OutreachDraft,
    compose_cover_letter,
    generate_outreach,
)


class StubClient:
    def __init__(self, data) -> None:
        self._data = data
        self.calls = 0
        self.last_prompt = ""

    def generate_structured(self, *, prompt, **kwargs):  # noqa: ANN001, ANN003
        self.calls += 1
        self.last_prompt = prompt
        return LlmResult(
            data=self._data,
            usage=Usage(input_tokens=80, output_tokens=40, model="stub", latency_ms=4),
            raw_text="{}",
        )


# --- Prompt wiring ----------------------------------------------------------


def test_tone_and_kind_keys_match_schema_literals():
    # The API's Literal types must line up with the prompt dictionaries, or a
    # valid request could reference a tone/kind the builder doesn't know.
    assert set(get_args(CoverLetterTone)) == set(COVER_LETTER_TONES)
    assert set(get_args(OutreachKind)) == set(OUTREACH_KINDS)


def test_cover_letter_prompt_injects_tone_and_voice(master: MasterResume):
    voice = VoiceProfile(summary="Warm, plainspoken, allergic to buzzwords.", tone="warm")
    prompt = build_cover_letter_prompt(
        master,
        JobRequirements(title="Backend Engineer", company="Globex"),
        "We need a Python engineer.",
        tone="startup",
        voice=voice,
    )
    assert COVER_LETTER_TONES["startup"] in prompt
    assert "OWN VOICE" in prompt
    assert "buzzwords" in prompt
    assert "Globex" in prompt


def test_cover_letter_prompt_without_voice_has_no_voice_block(master: MasterResume):
    prompt = build_cover_letter_prompt(
        master, JobRequirements(), "job text", tone="modern"
    )
    assert "OWN VOICE" not in prompt


def test_outreach_prompt_uses_kind_guidance_and_context(master: MasterResume):
    prompt = build_outreach_prompt(
        "linkedin_connection",
        master,
        company="Globex",
        role="SWE Intern",
        recipient="Sam",
        context="We both went to USC.",
    )
    assert OUTREACH_KINDS["linkedin_connection"] in prompt
    assert "Sam" in prompt
    assert "USC" in prompt


# --- Generation + guardrails -----------------------------------------------


def test_compose_cover_letter_drops_invented_metric(master: MasterResume):
    client = StubClient(
        CoverLetterDraft(
            paragraphs=[
                "I built a React dashboard used by 200 users at Acme Corp.",  # true
                "I personally scaled it to 5 million daily users.",  # invented
            ]
        )
    )
    paragraphs, report = compose_cover_letter(master, "job", client=client)
    joined = " ".join(paragraphs)
    assert "200 users" in joined
    assert "5 million" not in joined
    assert any(v.kind == "fabricated_number" for v in report.violations)


def test_compose_cover_letter_clean_letter_has_no_violations(master: MasterResume):
    client = StubClient(
        CoverLetterDraft(
            paragraphs=["I automated report generation with Python at Acme Corp."]
        )
    )
    paragraphs, report = compose_cover_letter(master, "job", client=client)
    assert paragraphs
    assert not report.violations


def test_outreach_advisory_flags_unbacked_numbers(master: MasterResume):
    client = StubClient(
        OutreachDraft(
            subject="Quick hello",
            body="I led a team of 40 engineers on a rewrite.",  # 40 not in résumé
        )
    )
    draft, warnings = generate_outreach(master, "recruiter_email", client=client)
    assert draft.body  # never edited
    assert warnings and "40" in warnings[0]


def test_outreach_number_from_context_is_not_flagged(master: MasterResume):
    client = StubClient(
        OutreachDraft(subject="Hi", body="Great to reconnect since the 2019 hackathon.")
    )
    _, warnings = generate_outreach(
        master, "referral_request", context="We met at the 2019 hackathon.", client=client
    )
    assert warnings == []  # 2019 came from the user's own context


# --- Export -----------------------------------------------------------------


def test_cover_letter_docx_is_a_valid_document(master: MasterResume):
    data = cover_letter_to_docx(
        master,
        ["First paragraph.", "Second paragraph."],
        company="Globex",
        role="Backend Engineer",
        hiring_manager="Sam Rivera",
        date_line="July 24, 2026",
    )
    assert data[:2] == b"PK"  # .docx is a zip
    assert len(data) > 1000
