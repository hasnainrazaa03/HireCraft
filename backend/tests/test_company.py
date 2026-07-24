"""Company intelligence tests.

The brief is AI-synthesised, so the guarantees we can pin are structural: the
prompt forbids fake precision and personal data, grounding text reaches the
model, and the contact guidance is generated without ever naming or exposing an
individual's details.
"""

from __future__ import annotations

from app.schemas.company import CompanyBrief
from app.services.company import build_contact_guidance, generate_company_brief
from app.services.llm.client import LlmResult, Usage
from app.services.llm.prompts import build_company_brief_prompt


class StubClient:
    def __init__(self, data: CompanyBrief) -> None:
        self._data = data
        self.last_prompt = ""

    def generate_structured(self, *, prompt, **kwargs):  # noqa: ANN001, ANN003
        self.last_prompt = prompt
        return LlmResult(
            data=self._data,
            usage=Usage(input_tokens=120, output_tokens=90, model="stub", latency_ms=7),
            raw_text="{}",
        )


def test_prompt_forbids_precision_and_pii_and_includes_role():
    prompt = build_company_brief_prompt("Globex", role="Backend Engineer")
    assert "Globex" in prompt
    assert "Backend Engineer" in prompt
    # System prompt carries the hard rules; the builder reiterates the key ones.
    assert "invented exact figures" in prompt or "bands" in prompt
    assert "contact details" in prompt


def test_prompt_includes_grounding_when_page_text_given():
    prompt = build_company_brief_prompt(
        "Globex", page_text="Globex builds industrial widgets since 1998."
    )
    assert "industrial widgets" in prompt
    assert "PUBLIC PAGE EXCERPT" in prompt


def test_generate_records_usage_and_returns_brief():
    from app.services.pipeline import UsageLedger

    brief = CompanyBrief(overview="A widgets company.", confidence="medium")
    client = StubClient(brief)
    ledger = UsageLedger()
    out = generate_company_brief("Globex", client=client, ledger=ledger)
    assert out.overview == "A widgets company."
    assert ledger.entries and ledger.entries[0][0] == "company_brief"


def test_grounding_text_reaches_the_model():
    client = StubClient(CompanyBrief())
    generate_company_brief(
        "Globex", page_text="We are a Series B fintech.", client=client
    )
    assert "Series B fintech" in client.last_prompt


def test_contact_guidance_is_pii_free_and_mentions_company():
    guidance = build_contact_guidance("Globex", role="Backend Engineer")
    assert guidance.steps
    joined = " ".join(guidance.steps) + " " + guidance.note
    assert "Globex" in joined
    # It must never fabricate a specific person or contact detail.
    assert "@" not in joined  # no email addresses
    assert "scrape" in guidance.note.lower()  # states the no-scraping stance


def test_contact_guidance_without_role_still_valid():
    guidance = build_contact_guidance("Initech")
    assert len(guidance.steps) >= 4
    assert "Initech" in " ".join(guidance.steps)
