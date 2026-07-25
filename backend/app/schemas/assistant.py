"""Job-search assistant + application-history schemas.

Both are deterministic: the assistant ranks the user's own résumés against a
job's extracted requirements, and the history view rolls up real outcomes per
résumé. No LLM, so the recommendations are explainable and free.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict, Field


class AssistantModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


class ResumeRanking(AssistantModel):
    resume_profile_id: uuid.UUID
    name: str
    match_score: int = Field(ge=0, le=100)
    verdict: str


class ResumeRecommendation(AssistantModel):
    job_title: str | None
    company: str | None
    rankings: list[ResumeRanking]
    best_resume_id: uuid.UUID | None
    weak_areas: list[str]  # gaps for the best-matching résumé
    missing_skills: list[str]


class ResumeOutcome(AssistantModel):
    resume_profile_id: uuid.UUID
    name: str
    applications: int
    interviews: int  # reached interviewing or beyond
    offers: int
    response_rate: float


class HistoryInsights(AssistantModel):
    resumes: list[ResumeOutcome]
    best_resume_id: uuid.UUID | None
    total_applications: int
    # Reusable content: keywords the interview-winning applications covered most.
    winning_keywords: list[str]
