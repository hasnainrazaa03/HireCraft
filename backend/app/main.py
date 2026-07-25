"""FastAPI application entrypoint."""

from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware

from app.api.routes import (
    account,
    admin,
    analytics,
    applications,
    auth,
    companies,
    copilot,
    export,
    health,
    insights,
    interview,
    notifications,
    oauth,
    profile,
    resumes,
    studio,
    writing,
)
from app.core.config import settings
from app.core.logging import configure_logging, get_logger, request_id_var
from app.core.rate_limit import check_api_limit

configure_logging()
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "app.startup",
        environment=settings.environment,
        project=settings.project_name,
    )
    yield
    logger.info("app.shutdown")


app = FastAPI(
    title=settings.project_name,
    description=(
        "Automated resume and cover letter tailoring. Rewrites how your real "
        "experience is presented for a specific job - never what it is."
    ),
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None if settings.is_production else "/redoc",
    openapi_url=None if settings.is_production else "/openapi.json",
)

# MIDDLEWARE ORDER MATTERS. Starlette inserts each new middleware at the front
# of the stack, so the LAST one registered is the OUTERMOST. CORS must therefore
# be registered last: if it sits inside the rate limiter or the error handler,
# a 429 or a 500 is returned without Access-Control-Allow-Origin, the browser
# blocks it, and the frontend reports a generic network failure instead of the
# real status. GZip is registered first so it stays innermost and only ever
# compresses a fully-formed response.
#
# Resulting stack, outermost to innermost:
#   CORS -> rate_limit -> request_context -> GZip -> routes
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def request_context(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Assign a request id, log the outcome, and set security headers."""
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
    token = request_id_var.set(request_id)
    started = time.perf_counter()

    try:
        response = await call_next(request)
    except Exception:
        duration_ms = int((time.perf_counter() - started) * 1000)
        logger.exception(
            "http.unhandled_error",
            method=request.method,
            path=request.url.path,
            duration_ms=duration_ms,
        )
        request_id_var.reset(token)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "Internal server error.", "request_id": request_id},
            headers={"X-Request-ID": request_id},
        )

    duration_ms = int((time.perf_counter() - started) * 1000)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    if settings.is_production:
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )

    if request.url.path not in ("/health", "/ready"):
        logger.info(
            "http.request",
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            duration_ms=duration_ms,
        )
    request_id_var.reset(token)
    return response


@app.middleware("http")
async def rate_limit(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Coarse per-client limit. Expensive endpoints add their own tighter quota."""
    if request.url.path in ("/health", "/ready") or request.method == "OPTIONS":
        return await call_next(request)

    # Prefer the authenticated user; fall back to client IP for anonymous calls.
    identifier = request.headers.get("authorization", "")[-32:] or (
        request.client.host if request.client else "unknown"
    )
    result = check_api_limit(identifier)
    if not result.allowed:
        return JSONResponse(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            content={"detail": "Rate limit exceeded. Please slow down."},
            headers={
                "Retry-After": str(result.reset_after),
                "X-RateLimit-Limit": str(result.limit),
                "X-RateLimit-Remaining": "0",
            },
        )

    response = await call_next(request)
    response.headers["X-RateLimit-Limit"] = str(result.limit)
    response.headers["X-RateLimit-Remaining"] = str(result.remaining)
    return response


# Registered last so it wraps everything above; see the ordering note near the
# top of this module.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Request-ID", "X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After"],
    max_age=600,
)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Return field-level validation errors the frontend can display inline."""
    errors = [
        {
            "field": ".".join(str(p) for p in error["loc"][1:]) or "body",
            "message": error["msg"],
        }
        for error in exc.errors()[:20]
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": "Validation failed.", "errors": errors},
    )


app.include_router(health.router)
for module in (
    auth, oauth, account, profile, writing, resumes, applications, studio, companies,
    insights, interview, notifications, copilot, export, admin, analytics,
):
    app.include_router(module.router, prefix=settings.api_v1_prefix)


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {
        "service": settings.project_name,
        "version": "0.1.0",
        "docs": "/docs" if not settings.is_production else "disabled",
    }
