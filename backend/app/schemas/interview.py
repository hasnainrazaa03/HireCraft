"""Interview-prep schemas: question generation and STAR answer drafting."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

QuestionCategory = Literal[
    "behavioral",
    "technical",
    "resume",
    "project",
    "company",
    "system_design",
    "coding",
    "general",
]


class InterviewModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


class InterviewQuestion(InterviewModel):
    category: QuestionCategory = "general"
    question: str = Field(max_length=600)
    why: str = Field(default="", max_length=400)
    tip: str = Field(default="", max_length=400)


class QuestionSet(InterviewModel):
    """The LLM response schema."""

    questions: list[InterviewQuestion] = Field(default_factory=list, max_length=20)


class StarAnswer(InterviewModel):
    situation: str = Field(default="", max_length=800)
    task: str = Field(default="", max_length=800)
    action: str = Field(default="", max_length=1000)
    result: str = Field(default="", max_length=800)


# --- Saved questions --------------------------------------------------------


class SavedQuestion(InterviewModel):
    """A persisted question plus the state of its answer (if one was drafted)."""

    id: uuid.UUID
    category: QuestionCategory = "general"
    question: str
    why: str = ""
    tip: str = ""
    role: str | None = None
    company: str | None = None
    application_id: uuid.UUID | None = None
    resume_profile_id: uuid.UUID | None = None
    answer: StarAnswer | None = None
    answer_warnings: list[str] = Field(default_factory=list)
    used_voice: bool = False
    order_index: int = 0


class SavedAnswerRequest(InterviewModel):
    """Draft (or redraft) the answer for a saved question. Sending it again on an
    already-answered question replaces the stored answer — that's the 'this one
    isn't good enough' path."""

    use_voice: bool = True


class AnswerResponse(InterviewModel):
    star: StarAnswer
    used_voice: bool
    warnings: list[str] = Field(default_factory=list)
    cost_usd: float


# --- API request/response ---------------------------------------------------


class QuestionsRequest(InterviewModel):
    resume_profile_id: uuid.UUID
    application_id: uuid.UUID | None = None
    role: str | None = Field(default=None, max_length=200)
    company: str | None = Field(default=None, max_length=200)
    categories: list[QuestionCategory] = Field(default_factory=list, max_length=8)
    count: int = Field(default=8, ge=3, le=16)
    # Persist the generated set (replacing any previous set for the same
    # application / standalone bucket) so prep survives a page reload.
    save: bool = True


class QuestionsResponse(InterviewModel):
    questions: list[InterviewQuestion]
    cost_usd: float
    # Populated when the set was saved — these carry the ids the UI needs to
    # draft/redraft an answer against a specific question.
    saved: list[SavedQuestion] = Field(default_factory=list)


class AnswerRequest(InterviewModel):
    resume_profile_id: uuid.UUID
    question: str = Field(min_length=1, max_length=600)
    use_voice: bool = True
