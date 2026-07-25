"""Résumé Copilot: grounded chat over the user's own data."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.api.deps import DbSession, GenerationUser
from app.core.logging import get_logger
from app.models.llm_usage import LlmUsage
from app.schemas.copilot import CopilotRequest, CopilotResponse
from app.services.copilot import answer
from app.services.llm.client import LlmConfigurationError, LlmError
from app.services.llm.factory import client_for_user
from app.services.pipeline import UsageLedger

router = APIRouter(prefix="/copilot", tags=["copilot"])
logger = get_logger(__name__)


def _client_for(user, provider: str | None = None, model: str | None = None):  # noqa: ANN001
    """Build the LLM client for this user's active (or overridden) provider/model."""
    try:
        return client_for_user(user, provider=provider, model=model)
    except LlmConfigurationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@router.post("/chat", response_model=CopilotResponse)
def chat(payload: CopilotRequest, user: GenerationUser, db: DbSession) -> CopilotResponse:
    ledger = UsageLedger()
    try:
        reply, grounded_in = answer(
            db, user.id, payload,
            client=_client_for(user, payload.provider, payload.model),
            ledger=ledger,
        )
    except LlmError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"The AI service is unavailable right now: {exc}",
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
    return CopilotResponse(reply=reply, grounded_in=grounded_in, cost_usd=ledger.cost_usd)
