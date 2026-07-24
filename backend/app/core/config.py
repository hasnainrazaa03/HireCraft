"""Application configuration, loaded from environment variables."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Environment ---
    environment: Literal["development", "staging", "production"] = "development"
    debug: bool = False
    log_level: str = "INFO"

    # --- Server ---
    api_v1_prefix: str = "/api/v1"
    project_name: str = "HireCraft"
    # NoDecode is required, not stylistic. Without it pydantic-settings tries to
    # json.loads() any complex-typed value coming from an environment variable,
    # before field validators run - so CORS_ORIGINS=http://localhost:5173 raises
    # a SettingsError at import and the process never starts. NoDecode hands the
    # raw string to _split_origins below instead.
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173"]
    )

    # --- Database ---
    database_url: str = "postgresql+psycopg://hirecraft:hirecraft@localhost:5432/hirecraft"
    db_pool_size: int = 5
    db_max_overflow: int = 10

    # --- Redis / Celery ---
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"

    # --- Auth ---
    secret_key: str = "dev-only-insecure-key-change-me"
    access_token_ttl_minutes: int = 60 * 12
    refresh_token_ttl_days: int = 14
    jwt_algorithm: str = "HS256"

    # --- LLM (Gemini) ---
    gemini_api_key: str = ""
    # "gemini-flash-latest" is a stable alias that always resolves to the current
    # Flash generation. Pinning "gemini-2.0-flash" was a trap: newer API keys get
    # a zero free-tier quota on that specific model and every request 429s with
    # "limit: 0", while the alias points at a model the key can actually use.
    gemini_model: str = "gemini-flash-latest"
    llm_max_output_tokens: int = 8192
    llm_temperature: float = 0.2
    llm_timeout_seconds: int = 90
    llm_max_retries: int = 3

    # Cost tracking: USD per 1M tokens. Defaults track Gemini Flash pricing.
    llm_input_cost_per_mtok: float = 0.10
    llm_output_cost_per_mtok: float = 0.40

    # --- Scraping ---
    scrape_timeout_seconds: int = 20
    scrape_max_bytes: int = 4_000_000
    scrape_user_agent: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )

    # --- LaTeX ---
    tectonic_binary: str = "tectonic"
    latex_timeout_seconds: int = 120
    templates_dir: str = "/app/templates"

    # --- Storage ---
    artifacts_dir: str = "/app/artifacts"
    max_upload_bytes: int = 5 * 1024 * 1024

    # --- Rate limiting (per user, sliding window) ---
    rate_limit_requests: int = 100
    rate_limit_window_seconds: int = 60
    rate_limit_generate_requests: int = 10
    rate_limit_generate_window_seconds: int = 3600

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        """Accept CORS_ORIGINS as either a JSON array or a comma-separated list.

        NoDecode means this validator now receives the raw environment string,
        so it owns both forms: the JSON array that pydantic-settings documents,
        and the comma-separated form that is far easier to write in a .env file
        or a Compose environment block.
        """
        if not isinstance(v, str):
            return v

        text = v.strip()
        if text.startswith("["):
            try:
                decoded = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"CORS_ORIGINS looks like JSON but could not be parsed: {exc}"
                ) from exc
            if not isinstance(decoded, list):
                raise ValueError("CORS_ORIGINS JSON must be an array of strings.")
            return [str(origin).strip() for origin in decoded if str(origin).strip()]

        return [origin.strip() for origin in text.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    if settings.is_production and settings.secret_key == "dev-only-insecure-key-change-me":
        raise RuntimeError(
            "SECRET_KEY must be set to a strong random value in production. "
            "Generate one with: python -c 'import secrets; print(secrets.token_urlsafe(64))'"
        )
    return settings


settings = get_settings()
