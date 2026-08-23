"""Résumé Copilot: grounded chat over the user's own data."""

from __future__ import annotations

import json

from fastapi.responses import StreamingResponse
from fastapi import APIRouter, HTTPException, status

from app.api.deps import DbSession, GenerationUser
from app.core.logging import get_logger
from app.models.llm_usage import LlmUsage
from app.schemas.copilot import CopilotRequest, CopilotResponse
from app.services.copilot import answer, looks_like_edit, stream_answer
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
        reply, grounded_in, action = answer(
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
    return CopilotResponse(
        reply=reply, grounded_in=grounded_in, action=action, cost_usd=ledger.cost_usd
    )


@router.post("/stream")
def chat_stream(payload: CopilotRequest, user: GenerationUser, db: DbSession) -> StreamingResponse:
    """Server-sent events: the reply arrives token by token as it's generated.

    Edit requests fall back to the structured path and arrive as one event — they
    produce a proposal card to accept or reject, so there is no prose to stream.
    Providers without a streaming implementation degrade the same way.
    """
    client = _client_for(user, payload.provider, payload.model)
    streamable = looks_like_edit(payload.message) is False and hasattr(client, "stream_text")

    def emit(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"

    def events():
        ledger = UsageLedger()
        try:
            if streamable:
                labels: list[str] = []
                usage = None
                for chunk, final in stream_answer(db, user.id, payload, client=client):
                    if chunk is not None:
                        yield emit("token", {"text": chunk})
                    else:
                        labels, usage = final
                if usage is not None:
                    ledger.record("copilot", usage)
                yield emit(
                    "done",
                    {"grounded_in": labels, "action": None, "cost_usd": ledger.cost_usd},
                )
            else:
                reply, labels, action = answer(db, user.id, payload, client=client, ledger=ledger)
                yield emit("token", {"text": reply})
                yield emit(
                    "done",
                    {
                        "grounded_in": labels,
                        "action": action.model_dump() if action else None,
                        "cost_usd": ledger.cost_usd,
                    },
                )
        except LlmError as exc:
            yield emit("error", {"detail": f"The AI service is unavailable right now: {exc}"})
            return
        except Exception as exc:  # noqa: BLE001 - a stream can't raise an HTTP error mid-body
            logger.warning("copilot.stream_failed", error=str(exc)[:300])
            yield emit("error", {"detail": "Something went wrong generating that reply."})
            return

        # Metered after the body is sent, so token cost never delays first paint.
        for purpose, usage in ledger.entries:
            db.add(
                LlmUsage(
                    user_id=user.id, purpose=purpose, model=usage.model,
                    input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
                    cost_usd=usage.cost_usd, latency_ms=usage.latency_ms,
                )
            )
        db.commit()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        # Proxies buffer by default, which would defeat the whole point.
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
