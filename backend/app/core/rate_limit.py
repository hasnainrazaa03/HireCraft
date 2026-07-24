"""Redis-backed sliding-window rate limiting.

Uses a sorted set per key, trimmed to the window on each request. The read,
trim, count, and insert run in a single pipeline so concurrent requests cannot
interleave into an over-admit. If Redis is unreachable the limiter fails open -
losing rate limiting is strictly better than losing the API.
"""

from __future__ import annotations

import contextlib
import time
import uuid
from dataclasses import dataclass

import redis

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_pool: redis.ConnectionPool | None = None


def get_redis() -> redis.Redis:
    global _pool
    if _pool is None:
        _pool = redis.ConnectionPool.from_url(
            settings.redis_url,
            max_connections=32,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
    return redis.Redis(connection_pool=_pool)


@dataclass(frozen=True)
class RateLimitResult:
    allowed: bool
    limit: int
    remaining: int
    reset_after: int
    """Seconds until the window frees up a slot."""


def check_rate_limit(
    identifier: str,
    *,
    limit: int,
    window_seconds: int,
    bucket: str = "default",
) -> RateLimitResult:
    """Record a request and report whether it is permitted."""
    key = f"ratelimit:{bucket}:{identifier}"
    now = time.time()
    cutoff = now - window_seconds

    try:
        client = get_redis()
        pipe = client.pipeline()
        pipe.zremrangebyscore(key, 0, cutoff)
        pipe.zcard(key)
        pipe.zadd(key, {f"{now}:{uuid.uuid4().hex[:8]}": now})
        pipe.expire(key, window_seconds + 1)
        _, used, _, _ = pipe.execute()
    except redis.RedisError as exc:
        # Fail open: an unavailable limiter must not take down the whole API.
        logger.warning("ratelimit.unavailable", error=str(exc))
        return RateLimitResult(True, limit, limit, 0)

    # `used` is the count before this request was added.
    allowed = used < limit
    if not allowed:
        # This request was rejected, so do not let it occupy a slot in the
        # window. Failing to clean up is harmless - the entry expires anyway.
        with contextlib.suppress(redis.RedisError):
            get_redis().zremrangebyscore(key, now, now)

    remaining = max(limit - used - 1, 0)
    return RateLimitResult(
        allowed=allowed,
        limit=limit,
        remaining=remaining,
        reset_after=window_seconds,
    )


def check_api_limit(identifier: str) -> RateLimitResult:
    return check_rate_limit(
        identifier,
        limit=settings.rate_limit_requests,
        window_seconds=settings.rate_limit_window_seconds,
        bucket="api",
    )


def check_generation_limit(identifier: str) -> RateLimitResult:
    """A much tighter budget: each generation costs real LLM money."""
    return check_rate_limit(
        identifier,
        limit=settings.rate_limit_generate_requests,
        window_seconds=settings.rate_limit_generate_window_seconds,
        bucket="generate",
    )
