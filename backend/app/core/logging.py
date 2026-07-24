"""Structured logging configuration.

Emits human-readable console logs in development and JSON lines in production so
the output can be shipped straight into a log aggregator.
"""

from __future__ import annotations

import logging
import sys
from contextvars import ContextVar
from typing import Any

import structlog

from app.core.config import settings

# Correlates every log line emitted while handling a single request/task.
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)


def _inject_request_id(
    _logger: Any, _method: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    request_id = request_id_var.get()
    if request_id:
        event_dict["request_id"] = request_id
    return event_dict


def configure_logging() -> None:
    """Configure structlog + stdlib logging. Safe to call more than once."""
    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    shared_processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        # Deliberately NOT structlog.stdlib.add_logger_name: it reads `.name` off
        # a stdlib logger, which PrintLogger does not have. get_logger() binds
        # the module name explicitly instead.
        _inject_request_id,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    if settings.is_production:
        renderer: Any = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer(colors=True)

    structlog.configure(
        processors=[*shared_processors, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )

    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level,
        force=True,
    )
    # Uvicorn's access log duplicates our own request middleware log line.
    logging.getLogger("uvicorn.access").disabled = True


def get_logger(name: str | None = None) -> Any:
    """Return a logger, tagging every line with the calling module's name."""
    logger = structlog.get_logger()
    return logger.bind(logger=name) if name else logger
