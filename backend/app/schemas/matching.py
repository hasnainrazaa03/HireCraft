"""Job-match and skill-gap schemas.

Both are computed deterministically from the résumé and a job's extracted
requirements — no LLM — so the fit score is explainable, instant, and free to
recompute. Every number is derived from something concrete (a matched skill, a
covered keyword, a year of experience), and the ``strengths``/``gaps`` lists say
in plain words why the score is what it is.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class MatchModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


class SubScore(MatchModel):
    key: str
    label: str
    score: int = Field(ge=0, le=100)
    weight: float
    detail: str


class SkillHit(MatchModel):
    name: str
    importance: int = Field(ge=1, le=5)
    have: bool


class JobMatch(MatchModel):
    overall_score: int = Field(ge=0, le=100)
    verdict: Literal["Strong match", "Good match", "Fair match", "Reach"]
    subscores: list[SubScore]
    matched_skills: list[SkillHit]
    missing_skills: list[SkillHit]
    matched_keywords: list[str]
    missing_keywords: list[str]
    strengths: list[str]
    gaps: list[str]


class SkillDemand(MatchModel):
    name: str
    demand: int  # how many of the analysed jobs asked for it
    avg_importance: float
    have: bool


class SkillGapReport(MatchModel):
    jobs_analyzed: int
    average_match: int | None  # average overall match across analysed jobs
    top_missing: list[SkillDemand]  # most-demanded skills the résumé lacks
    high_demand: list[SkillDemand]  # most-demanded skills overall (have or not)
    covered: list[SkillDemand]  # in-demand skills the résumé already has
