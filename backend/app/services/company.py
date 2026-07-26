"""Company intelligence service.

Generates an AI research brief (optionally grounded in a public page the user
supplies) and compliant guidance for finding the right human to contact.

On the contact side we deliberately do **not** scrape or store anyone's personal
data. The guidance is generated in code (never by the model, so no individual is
ever named) and points the user at legitimate first-party channels. The
``ContactProvider`` seam below is where an *official, opt-out-respecting* B2B
data API (Hunter.io, Apollo, RocketReach, …) could later be plugged in behind a
feature flag — with the DPA, privacy-policy update, and deletion handling that
processing personal data requires. Until then there is no provider, by design.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.core.logging import get_logger
from app.schemas.company import CompanyBrief, ContactGuidance
from app.services.llm.client import LlmResult, get_client
from app.services.llm.prompts import COMPANY_BRIEF_SYSTEM, build_company_brief_prompt
from app.services.pipeline import UsageLedger

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from app.services.llm.factory import LlmClient

logger = get_logger(__name__)


def generate_company_brief(
    company: str,
    *,
    role: str | None = None,
    page_text: str | None = None,
    client: LlmClient | None = None,
    ledger: UsageLedger | None = None,
) -> CompanyBrief:
    """One LLM call → a cautious, honesty-first company brief.

    The prompt forbids invented precision and personal data; the model is told to
    stay sparse and mark low confidence for companies it does not recognise.
    """
    client = client or get_client()
    result: LlmResult[CompanyBrief] = client.generate_structured(
        prompt=build_company_brief_prompt(company, role, page_text),
        schema=CompanyBrief,
        system_instruction=COMPANY_BRIEF_SYSTEM,
        temperature=0.3,
    )
    if ledger is not None:
        ledger.record("company_brief", result.usage)
    logger.info(
        "company.brief_generated",
        company=company,
        confidence=result.data.confidence,
        grounded=bool(page_text),
    )
    return result.data


def build_contact_guidance(company: str, role: str | None = None) -> ContactGuidance:
    """Compliant, PII-free guidance for finding the right person to reach out to.

    Generated deterministically — it never names an individual or exposes contact
    details — so there is no personal data to store or leak. Pairs with the
    outreach drafter (Phase 8) once the user has found a real, appropriate contact.
    """
    role_bit = f" for the {role} role" if role else ""
    steps = [
        f"Check {company}'s careers or team page — many list the hiring team or a "
        "recruiting contact directly.",
        "Search LinkedIn (in LinkedIn's own interface) for "
        f"\"recruiter {company}\" or \"{(role or 'talent')} hiring {company}\" to "
        "find who is likely involved in hiring.",
        "Look for a warm intro first: filter LinkedIn to 2nd-degree connections, "
        "or check your school's alumni network for people at the company.",
        "If the posting names a hiring manager or team, note that — a specific, "
        "relevant recipient beats a generic inbox.",
        "Only use contact details the person has published for this purpose (e.g. "
        "an email on their own site or bio). Don't guess or scrape private addresses.",
        f"Once you've found the right person{role_bit}, draft a short, specific "
        "message in the Writing Studio and send it yourself.",
    ]
    return ContactGuidance(
        steps=steps,
        note=(
            "HireCraft doesn't scrape or store anyone's personal contact data. This "
            "is guidance for finding the right person through legitimate channels; "
            "reach out respectfully and only where contact is invited."
        ),
    )
