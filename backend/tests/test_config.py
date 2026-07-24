"""Settings parsing tests.

These exist because configuration bugs do not surface locally - they surface on
the first containerized deploy, where every setting arrives as an environment
variable rather than a Python default.
"""

from __future__ import annotations

import pytest

from app.core.config import Settings


class TestCorsOrigins:
    def test_parses_comma_separated_env_value(self, monkeypatch: pytest.MonkeyPatch):
        """Regression: this raised SettingsError at import time.

        pydantic-settings json.loads() any complex-typed value coming from the
        environment before field validators run, so a bare URL was a decode
        error and the process died on startup. Docker Compose sets exactly this
        variable, so every containerized run was affected while local runs -
        which never set it - passed.
        """
        monkeypatch.setenv(
            "CORS_ORIGINS", "http://localhost:5173,https://hirecraft.app"
        )
        settings = Settings(_env_file=None)
        assert settings.cors_origins == [
            "http://localhost:5173",
            "https://hirecraft.app",
        ]

    def test_parses_single_origin(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("CORS_ORIGINS", "http://localhost:5173")
        assert Settings(_env_file=None).cors_origins == ["http://localhost:5173"]

    def test_tolerates_whitespace_and_trailing_comma(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("CORS_ORIGINS", " http://a.test , http://b.test ,")
        assert Settings(_env_file=None).cors_origins == [
            "http://a.test",
            "http://b.test",
        ]

    def test_still_accepts_a_json_array(self, monkeypatch: pytest.MonkeyPatch):
        """A JSON array is the documented pydantic-settings form; keep it working."""
        monkeypatch.setenv("CORS_ORIGINS", '["http://a.test", "http://b.test"]')
        assert Settings(_env_file=None).cors_origins == [
            "http://a.test",
            "http://b.test",
        ]

    def test_falls_back_to_default(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("CORS_ORIGINS", raising=False)
        assert Settings(_env_file=None).cors_origins == ["http://localhost:5173"]


class TestProductionSafety:
    def test_rejects_default_secret_key_in_production(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """A deploy that signs tokens with the public default must not boot."""
        from app.core.config import get_settings

        monkeypatch.setenv("ENVIRONMENT", "production")
        monkeypatch.setenv("SECRET_KEY", "dev-only-insecure-key-change-me")
        get_settings.cache_clear()
        try:
            with pytest.raises(RuntimeError, match="SECRET_KEY"):
                get_settings()
        finally:
            get_settings.cache_clear()

    def test_accepts_a_real_secret_key_in_production(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        from app.core.config import get_settings

        monkeypatch.setenv("ENVIRONMENT", "production")
        monkeypatch.setenv("SECRET_KEY", "a-genuinely-random-production-value")
        get_settings.cache_clear()
        try:
            assert get_settings().is_production is True
        finally:
            get_settings.cache_clear()


class TestEnvOverrides:
    def test_numeric_and_boolean_coercion(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("LLM_TEMPERATURE", "0.7")
        monkeypatch.setenv("DEBUG", "true")
        monkeypatch.setenv("RATE_LIMIT_REQUESTS", "250")
        settings = Settings(_env_file=None)
        assert settings.llm_temperature == 0.7
        assert settings.debug is True
        assert settings.rate_limit_requests == 250
