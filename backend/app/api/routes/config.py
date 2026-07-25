"""Public runtime config the frontend reads at startup.

Exposes the effective feature flags and which OAuth providers are configured, so
the UI can hide features an operator has switched off without shipping a build.
No auth: nothing here is sensitive (flag on/off states and provider names).
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import DbSession
from app.schemas.api import ApiModel
from app.services import feature_flags
from app.services.oauth import enabled_providers

router = APIRouter(prefix="/config", tags=["config"])


class PublicConfig(ApiModel):
    flags: dict[str, bool]
    oauth_providers: list[str]


@router.get("", response_model=PublicConfig)
def public_config(db: DbSession) -> PublicConfig:
    return PublicConfig(
        flags=feature_flags.effective_flags(db),
        oauth_providers=enabled_providers(),
    )
