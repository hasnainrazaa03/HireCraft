"""Health and readiness probes."""

from __future__ import annotations

from fastapi import APIRouter, Response, status
from sqlalchemy import text

from app.api.deps import DbSession
from app.core.config import settings
from app.core.rate_limit import get_redis
from app.services.latex.compiler import tectonic_available
from app.services.llm.client import get_client

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict[str, str]:
    """Liveness: is the process up? Never touches a dependency."""
    return {"status": "ok", "service": settings.project_name}


@router.get("/ready")
def ready(db: DbSession, response: Response) -> dict[str, object]:
    """Readiness: can this instance actually serve traffic?"""
    checks: dict[str, object] = {}

    try:
        db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:
        checks["database"] = f"error: {type(exc).__name__}"

    try:
        get_redis().ping()
        checks["redis"] = "ok"
    except Exception as exc:
        checks["redis"] = f"error: {type(exc).__name__}"

    # Degraded, not fatal: the API still serves reads without these.
    checks["tectonic"] = "ok" if tectonic_available() else "missing"
    checks["gemini_api_key"] = "configured" if get_client().configured else "missing"

    hard_failures = [
        name for name in ("database", "redis") if checks[name] != "ok"
    ]
    if hard_failures:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return {"status": "degraded" if hard_failures else "ok", "checks": checks}
