"""Résumé analysis: scores, findings, and ATS structural checks.

Deliberately deterministic — every score and finding is computed from the
résumé's own structure and text, with no LLM. That keeps analysis instant,
free, and fully explainable: each number can be traced to a concrete rule, and
each finding points at a specific bullet or section the user can fix.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Severity = Literal["good", "info", "warning", "critical"]

MetricKey = Literal[
    "quantification",
    "action_verbs",
    "impact",
    "brevity",
    "readability",
    "completeness",
    "recruiter_friendly",
]


class AnalysisModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class ScoreMetric(AnalysisModel):
    key: MetricKey
    label: str
    score: int = Field(ge=0, le=100)
    detail: str


class Finding(AnalysisModel):
    category: str
    severity: Severity
    title: str
    detail: str
    # Which résumé entry it points at, for the UI to anchor on.
    location: str | None = None


class AtsCheck(AnalysisModel):
    name: str
    passed: bool
    detail: str


class ResumeAnalysis(AnalysisModel):
    overall_score: int = Field(ge=0, le=100)
    grade: Literal["Excellent", "Strong", "Fair", "Needs work"]
    metrics: list[ScoreMetric]
    findings: list[Finding]
    ats_checks: list[AtsCheck]
    ats_score: int = Field(ge=0, le=100)
    # Quick counts the UI can headline.
    bullet_count: int
    quantified_bullets: int
    estimated_pages: float
