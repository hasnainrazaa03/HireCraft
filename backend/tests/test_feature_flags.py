"""Feature-flag resolution tests: defaults, DB overrides, and unknown keys."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.db.base import Base
from app.models.feature_flag import KNOWN_FLAGS
from app.services import feature_flags


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with OrmSession(engine) as session:
        yield session


def test_defaults_when_no_overrides(db):
    flags = feature_flags.effective_flags(db)
    assert set(flags) == set(KNOWN_FLAGS)
    # signups default on.
    assert flags["signups_enabled"] is True


def test_override_wins_over_default(db):
    assert feature_flags.is_enabled(db, "signups_enabled") is True
    feature_flags.set_flag(db, "signups_enabled", False)
    db.flush()
    assert feature_flags.is_enabled(db, "signups_enabled") is False
    assert feature_flags.effective_flags(db)["signups_enabled"] is False


def test_toggle_back_on(db):
    feature_flags.set_flag(db, "job_search_enabled", False)
    feature_flags.set_flag(db, "job_search_enabled", True)
    db.flush()
    assert feature_flags.is_enabled(db, "job_search_enabled") is True


def test_unknown_flag_rejected(db):
    with pytest.raises(KeyError):
        feature_flags.set_flag(db, "not_a_real_flag", True)


def test_unknown_flag_reads_false(db):
    assert feature_flags.is_enabled(db, "not_a_real_flag") is False
