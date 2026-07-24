"""Writing profile schemas: samples and the extracted voice."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

SampleKind = Literal["cover_letter", "email", "sop", "other"]


class WritingModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


class VoiceProfile(WritingModel):
    """The distilled voice. This is also the Gemini response schema, so the
    field descriptions double as extraction instructions."""

    tone: str = Field(
        default="",
        max_length=300,
        description="Overall tone in a few words, e.g. 'warm but direct, quietly confident'.",
    )
    formality: Literal["casual", "conversational", "professional", "formal", "unknown"] = (
        "unknown"
    )
    sentence_style: str = Field(
        default="",
        max_length=300,
        description="Sentence rhythm and length habits, e.g. 'short punchy sentences, "
        "occasional longer one for emphasis'.",
    )
    vocabulary: list[str] = Field(
        default_factory=list,
        max_length=30,
        description="Distinctive words or phrases the writer favors.",
    )
    habits: list[str] = Field(
        default_factory=list,
        max_length=15,
        description="Recurring stylistic habits to preserve when writing as this person.",
    )
    avoid: list[str] = Field(
        default_factory=list,
        max_length=15,
        description="Things this writer never does — clichés or constructions to avoid.",
    )
    summary: str = Field(
        default="",
        max_length=600,
        description="A 2-3 sentence instruction to another writer on how to sound like "
        "this person.",
    )


class WritingSampleCreate(WritingModel):
    kind: SampleKind = "other"
    title: str | None = Field(default=None, max_length=200)
    content: Annotated[str, Field(min_length=30, max_length=20_000)]


class WritingSampleResponse(WritingModel):
    id: uuid.UUID
    kind: str
    title: str | None
    content: str
    created_at: datetime


class WritingProfileResponse(WritingModel):
    voice: VoiceProfile | None
    analyzed_at: datetime | None
    sample_count: int
    samples: list[WritingSampleResponse]
