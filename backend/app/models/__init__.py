"""ORM models.

Every model must be imported here so Alembic autogenerate and ``Base.metadata``
see the complete schema.
"""

from app.models.application import (
    Application,
    ApplicationArtifact,
    PipelineStatus,
    TrackerStatus,
)
from app.models.auth import AuthToken, AuthTokenPurpose, Session
from app.models.evidence import EvidenceItem, EvidenceKind
from app.models.feature_flag import FeatureFlag
from app.models.interview import SavedInterviewQuestion
from app.models.job import Job
from app.models.llm_usage import LlmUsage
from app.models.notification import Notification
from app.models.profile import CareerProfile
from app.models.resume import ResumeProfile, ResumeVersion
from app.models.saved_cover_letter import SavedCoverLetter
from app.models.user import User
from app.models.writing import WritingProfile, WritingSample, WritingSampleKind

__all__ = [
    "Application",
    "ApplicationArtifact",
    "AuthToken",
    "AuthTokenPurpose",
    "CareerProfile",
    "EvidenceItem",
    "EvidenceKind",
    "FeatureFlag",
    "Job",
    "SavedInterviewQuestion",
    "LlmUsage",
    "Notification",
    "PipelineStatus",
    "ResumeProfile",
    "ResumeVersion",
    "SavedCoverLetter",
    "Session",
    "TrackerStatus",
    "User",
    "WritingProfile",
    "WritingSample",
    "WritingSampleKind",
]
