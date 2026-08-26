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
    # Short access TTL keeps stateless access tokens honest: after "log out
    # everywhere" revokes the refresh sessions, any lingering access token dies
    # within the hour rather than staying valid for half a day.
    access_token_ttl_minutes: int = 60
    refresh_token_ttl_days: int = 14
    jwt_algorithm: str = "HS256"

    # --- LLM (multi-provider) ---
    # The server-wide default provider. A user can override it (and the model)
    # from their account settings; whichever is active is used one at a time.
    default_llm_provider: str = "gemini"

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
    # Cap the model's internal "thinking" tokens. Flash-class models default to
    # unlimited thinking, which on a large résumé eats the whole output budget
    # and truncates the JSON (a slow 502). A small budget leaves room for the
    # actual answer, is faster, and is cheaper. 0 disables the cap (some models
    # reject a budget of 0, so we send the config only when this is > 0).
    llm_thinking_budget: int = 512

    # Anthropic (Claude) — optional. Server key + default model; enabled only
    # when a key (server or the user's own) is available.
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-4-5-20251001"

    # OpenAI — optional, same gating.
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"

    # Cost tracking: USD per 1M tokens. Per-model prices live in the model
    # registry; these are the fallback for any model not listed there.
    llm_input_cost_per_mtok: float = 0.10
    llm_output_cost_per_mtok: float = 0.40

    # --- Scraping ---
    scrape_timeout_seconds: int = 20
    scrape_max_bytes: int = 4_000_000
    scrape_user_agent: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )

    # --- Job search sources ---
    # Comma-separated list of enabled sources (all free / keyless):
    #   arbeitnow · remotive · remoteok · github
    job_sources: str = "arbeitnow,remotive,remoteok,github"
    # Comma-separated "owner/repo" of GitHub job-listing repos. These are read as
    # a structured listings.json when present, else parsed from the README table.
    # Add your own repo here (or via the GITHUB_JOB_REPOS env var).
    github_job_repos: str = (
        "SimplifyJobs/Summer2026-Internships,"
        "SimplifyJobs/New-Grad-Positions,"
        "vanshb03/Summer2027-Internships"
    )

    # --- LaTeX ---
    tectonic_binary: str = "tectonic"
    latex_timeout_seconds: int = 120
    templates_dir: str = "/app/templates"

    #: A folder of résumé PDFs kept on disk, mounted read-only into the
    #: container. Lets the extension offer the tailored PDFs a user already
    #: maintains — base/MHR_AIML.pdf, applications/Vercel/MHR_Vercel.pdf —
    #: alongside the ones uploaded here, since a browser extension cannot read
    #: local files itself and the API is already on the same machine.
    local_resumes_dir: str = "/app/local_resumes"

    # --- Storage ---
    artifacts_dir: str = "/app/artifacts"
    max_upload_bytes: int = 5 * 1024 * 1024

    # --- Email (SMTP) ---
    # When smtp_host is empty, the app runs in "console" mode: emails are logged
    # instead of sent, so local development needs no mail server. Set these in
    # production (Resend/Postmark/SES/etc.) to actually deliver.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True
    smtp_timeout_seconds: int = 15
    email_from: str = "HireCraft <no-reply@hirecraft.app>"
    # Base URL the frontend serves from; used to build links in emails.
    frontend_base_url: str = "http://localhost:5173"

    # OAuth (optional). A provider is "enabled" only when both id and secret are
    # set; otherwise its endpoints report 501 and the login buttons hide.
    google_client_id: str = ""
    google_client_secret: str = ""
    github_client_id: str = ""
    github_client_secret: str = ""
    # Where the provider redirects back to (the API's callback). Defaults derive
    # from the API's own base at request time when left blank.
    oauth_redirect_base: str = ""

    # --- Token TTLs for email flows ---
    email_verify_ttl_hours: int = 48
    password_reset_ttl_minutes: int = 30

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
