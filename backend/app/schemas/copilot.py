"""Résumé Copilot schemas.

The copilot answers questions about the user's job search grounded ONLY in their
real data — résumé scores, job-match results, skill gaps, and the guardrail
decisions HireCraft already made. It retrieves that data deterministically and
hands it to the model as context; the model may only reason over what it's given.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CopilotModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


class ChatMessage(CopilotModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class CopilotRequest(CopilotModel):
    message: str = Field(min_length=1, max_length=2000)
    # Recent turns for continuity (trimmed server-side).
    history: list[ChatMessage] = Field(default_factory=list, max_length=20)
    # Optional focus: ground the answer in a specific résumé and/or application.
    resume_profile_id: uuid.UUID | None = None
    application_id: uuid.UUID | None = None
    # Optional per-message model switch (falls back to the user's active choice).
    provider: str | None = Field(default=None, max_length=20)
    model: str | None = Field(default=None, max_length=80)


class CopilotResponse(CopilotModel):
    reply: str
    # Human-readable labels of the data the answer was grounded in, for transparency.
    grounded_in: list[str] = Field(default_factory=list)
    cost_usd: float = 0.0
