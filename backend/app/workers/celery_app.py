"""Celery application."""

from __future__ import annotations

from celery import Celery
from celery.signals import setup_logging

from app.core.config import settings
from app.core.logging import configure_logging

celery_app = Celery(
    "hirecraft",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=["app.workers.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    # A tailoring run makes several LLM calls plus a LaTeX compile.
    task_soft_time_limit=8 * 60,
    task_time_limit=10 * 60,
    task_acks_late=True,
    # Long, unevenly-sized tasks: prefetching starves other workers.
    worker_prefetch_multiplier=1,
    worker_max_tasks_per_child=100,
    task_track_started=True,
    result_expires=60 * 60 * 24,
    broker_connection_retry_on_startup=True,
)

# Scheduled jobs. Runs only when a `celery beat` process is started alongside
# the workers (see docker-compose `scheduler` service). Phase 11 reminders will
# register their schedules here; for now it holds a lightweight daily
# housekeeping slot so the beat wiring is proven end to end.
celery_app.conf.beat_schedule = {
    "daily-housekeeping": {
        "task": "hirecraft.housekeeping",
        "schedule": 60 * 60 * 24,  # once a day
    },
    # Reminders are idempotent (dedupe keys), so scanning several times a day
    # just means nudges surface promptly without ever duplicating.
    "scan-reminders": {
        "task": "hirecraft.scan_reminders",
        "schedule": 60 * 60 * 6,  # every 6 hours
    },
    "weekly-summary": {
        "task": "hirecraft.weekly_summary",
        "schedule": 60 * 60 * 24,  # daily check; the weekly dedupe key gates it
    },
}


@setup_logging.connect
def _configure_worker_logging(**_kwargs: object) -> None:
    """Use our structlog config instead of Celery's default handlers."""
    configure_logging()
