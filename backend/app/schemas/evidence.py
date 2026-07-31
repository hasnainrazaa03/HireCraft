"""Schemas for the brag bank (supplemental evidence)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.evidence import EvidenceKind


class EvidenceCreate(BaseModel):
    kind: EvidenceKind = EvidenceKind.IMPACT
    text: str = Field(min_length=3, max_length=2000)
    label: str | None = Field(default=None, max_length=160)


class EvidenceUpdate(BaseModel):
    kind: EvidenceKind | None = None
    text: str | None = Field(default=None, min_length=3, max_length=2000)
    label: str | None = Field(default=None, max_length=160)


class EvidenceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: EvidenceKind
    text: str
    label: str | None
    created_at: datetime
    updated_at: datetime
