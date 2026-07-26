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


# --- Rate-limit identity -----------------------------------------------------


def test_rate_limit_follows_the_account_not_the_token():
    """Regression: the bucket key was the tail of the bearer token.

    Access tokens rotate on every refresh, so a client got a brand-new quota
    just by refreshing and the coarse limit enforced nothing.
    """
    from types import SimpleNamespace

    from app.core.security import create_token
    from app.main import _rate_limit_identity

    def request(auth=None, ip="1.2.3.4"):
        return SimpleNamespace(
            headers={"authorization": auth} if auth else {},
            client=SimpleNamespace(host=ip),
        )

    user = "11111111-1111-1111-1111-111111111111"
    first, second = create_token(user, "access"), create_token(user, "access")
    assert first != second  # rotation really does produce a different token

    assert _rate_limit_identity(request(f"Bearer {first}")) == _rate_limit_identity(
        request(f"Bearer {second}")
    )
    other = create_token("22222222-2222-2222-2222-222222222222", "access")
    assert _rate_limit_identity(request(f"Bearer {other}")) != _rate_limit_identity(
        request(f"Bearer {first}")
    )


def test_rate_limit_falls_back_to_ip_when_unauthenticated():
    from types import SimpleNamespace

    from app.main import _rate_limit_identity

    def request(auth=None):
        return SimpleNamespace(
            headers={"authorization": auth} if auth else {},
            client=SimpleNamespace(host="9.9.9.9"),
        )

    assert _rate_limit_identity(request()) == "ip:9.9.9.9"
    assert _rate_limit_identity(request("Bearer garbage")) == "ip:9.9.9.9"


# --- Outbound-call and auth surface -----------------------------------------


def test_every_api_route_requires_authentication():
    """No endpoint should be reachable without a bearer token except the
    handful that genuinely cannot be (login, token refresh, the email-link
    flows, the OAuth handshake, and the public runtime config)."""
    import importlib
    import pkgutil

    import app.api.routes as routes_pkg
    from app.api.deps import enforce_generation_quota, get_current_user, require_admin

    guards = {get_current_user, require_admin, enforce_generation_quota}
    public = {
        ("POST", "/auth/register"), ("POST", "/auth/login"), ("POST", "/auth/refresh"),
        ("POST", "/auth/verify-email"), ("POST", "/auth/forgot-password"),
        ("POST", "/auth/reset-password"), ("GET", "/auth/oauth/providers"),
        ("GET", "/auth/oauth/{provider}/authorize"),
        ("GET", "/auth/oauth/{provider}/callback"), ("GET", "/config"),
        # Orchestrator probes: an unauthenticated liveness/readiness check is
        # the point of them.
        ("GET", "/health"), ("GET", "/ready"),
    }

    unguarded, seen = [], 0
    for module in pkgutil.iter_modules(routes_pkg.__path__):
        router = getattr(
            importlib.import_module(f"app.api.routes.{module.name}"), "router", None
        )
        if router is None:
            continue
        for route in router.routes:
            if not hasattr(route, "dependant"):
                continue
            seen += 1
            stack, found = [route.dependant], False
            while stack:
                dep = stack.pop()
                found = found or dep.call in guards
                stack.extend(dep.dependencies)
            for method in route.methods - {"HEAD", "OPTIONS"}:
                if not found and (method, route.path) not in public:
                    unguarded.append(f"{method} {route.path}")

    assert seen > 50, f"route discovery broke — only saw {seen}"
    assert unguarded == [], f"unauthenticated routes: {unguarded}"


def test_key_validation_cannot_drive_unbounded_provider_calls():
    """Saving an API key makes a live outbound request to the provider, so it
    needs its own throttle — it isn't covered by the generation quota."""
    import inspect

    from app.api.routes import account

    for handler in (account.set_api_key, account.set_llm_key):
        assert "_throttle_key_probe" in inspect.getsource(handler), handler.__name__
