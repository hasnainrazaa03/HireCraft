"""Shared pytest fixtures."""

from __future__ import annotations

import pytest

from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume

MASTER_RESUME_FIXTURE = {
    "basics": {
        "name": "Hasnain Raza",
        "email": "razam@usc.edu",
        "location": "Los Angeles, CA",
    },
    "experience": [
        {
            "company": "Acme Corp",
            "title": "Software Engineering Intern",
            "start_date": "2024-05",
            "end_date": "2024-08",
            "highlights": [
                "Built an internal dashboard using React that served 200 users",
                "Wrote Python scripts to automate report generation",
            ],
            "technologies": ["React", "Python"],
        }
    ],
    "education": [
        {
            "institution": "University of Southern California",
            "degree": "BS",
            "field_of_study": "Computer Science",
            "start_date": "2022",
            "end_date": "2026",
            "gpa": "3.8",
        }
    ],
    "skills": [{"category": "Languages", "items": ["Python", "JavaScript", "SQL"]}],
}


@pytest.fixture
def master() -> MasterResume:
    return MasterResume.model_validate(MASTER_RESUME_FIXTURE)


@pytest.fixture
def experience_id(master: MasterResume) -> str:
    return master.experience[0].id


@pytest.fixture
def requirements() -> JobRequirements:
    return JobRequirements.model_validate(
        {
            "title": "Backend Engineer Intern",
            "company": "Globex",
            "ats_keywords": ["Python", "Kubernetes", "SQL"],
            "required_skills": [{"name": "Python", "importance": 5}],
        }
    )
