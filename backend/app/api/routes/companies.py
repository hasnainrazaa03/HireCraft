"""Company intelligence endpoints.

Stateless and opt-in: the user asks about a specific company, we return an
AI-generated brief plus compliant contact guidance, and nothing is stored. No
personal data is fetched or retained.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.api.deps import DbSession, GenerationUser
from app.core.crypto import decrypt
from app.core.logging import get_logger
from app.models.llm_usage import LlmUsage
from app.schemas.company import CompanyBriefRequest, CompanyBriefResponse
from app.services.company import build_contact_guidance, generate_company_brief
from app.services.llm.client import GeminiClient, LlmError, LlmResponseError
from app.services.pipeline import UsageLedger
from app.services.scraper import ScrapeError, scrape_job, validate_url

router = APIRouter(prefix="/companies", tags=["companies"])
logger = get_logger(__name__)


def _client_for(user) -> GeminiClient | None:  # noqa: ANN001
    if not user.encrypted_gemini_key:
        return None
    try:
        return GeminiClient(api_key=decrypt(user.encrypted_gemini_key))
    except Exception:  # noqa: BLE001 - fall back to the shared key
        return None


@router.post("/brief", response_model=CompanyBriefResponse)
def company_brief(
    payload: CompanyBriefRequest, user: GenerationUser, db: DbSession
) -> CompanyBriefResponse:
    """Generate a research brief for a company, optionally grounded in a public
    page the user pastes or links. One LLM call; nothing is persisted."""
    page_text = payload.page_text
    used_grounding = bool(page_text and page_text.strip())

    # Optional URL grounding: fetch the user-provided public page. SSRF-guarded by
    # the scraper. A fetch failure degrades gracefully — we just skip grounding
    # rather than failing the whole request.
    if not used_grounding and payload.url:
        try:
            validate_url(payload.url)
            scraped = scrape_job(payload.url)
            if scraped.text.strip():
                page_text = scraped.text
                used_grounding = True
        except ScrapeError as exc:
            logger.info("company.grounding_fetch_failed", error=str(exc))

    ledger = UsageLedger()
    try:
        brief = generate_company_brief(
            payload.company,
            role=payload.role,
            page_text=page_text,
            client=_client_for(user),
            ledger=ledger,
        )
    except LlmResponseError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The AI returned an incomplete brief. Please try again.",
        ) from exc
    except LlmError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The AI service is unavailable right now: {exc}",
        ) from exc

    for purpose, usage in ledger.entries:
        db.add(
            LlmUsage(
                user_id=user.id,
                purpose=purpose,
                model=usage.model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cost_usd=usage.cost_usd,
                latency_ms=usage.latency_ms,
            )
        )
    db.commit()

    return CompanyBriefResponse(
        company=payload.company,
        role=payload.role,
        brief=brief,
        contact_guidance=build_contact_guidance(payload.company, payload.role),
        used_grounding=used_grounding,
        cost_usd=ledger.cost_usd,
    )
