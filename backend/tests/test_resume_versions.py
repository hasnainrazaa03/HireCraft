"""Résumé version history tests.

The invariant under test: current content is always live, every prior content is
a recoverable snapshot, and a rollback is itself reversible.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (register all tables)
from app.db.base import Base
from app.models.resume import ResumeProfile
from app.models.user import User
from app.services import resume_versions


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    with OrmSession(engine) as session:
        yield session


@pytest.fixture
def profile(db):
    user = User(email="v@usc.edu", hashed_password="x")
    db.add(user)
    db.flush()
    p = ResumeProfile(user_id=user.id, name="Master", content={"v": 1}, current_version=1)
    db.add(p)
    db.flush()
    return p


def test_edit_snapshots_previous_content(db, profile):
    resume_versions.update_content(db, profile, {"v": 2})
    db.flush()
    assert profile.content == {"v": 2}
    assert profile.current_version == 2
    # The old content is preserved as version 1.
    assert [v.version for v in profile.versions] == [1]
    assert profile.versions[0].content == {"v": 1}


def test_no_op_edit_does_not_snapshot(db, profile):
    resume_versions.update_content(db, profile, {"v": 1})  # identical
    db.flush()
    assert profile.current_version == 1
    assert list(profile.versions) == []


def test_multiple_edits_accumulate_history(db, profile):
    for i in range(2, 5):
        resume_versions.update_content(db, profile, {"v": i})
    db.commit()
    assert profile.current_version == 4
    # Reload so the relationship's `version desc` ordering applies, as it does
    # in the API after commit+refresh.
    db.expire(profile)
    assert [v.version for v in profile.versions] == [3, 2, 1]


def test_rollback_restores_and_is_reversible(db, profile):
    resume_versions.update_content(db, profile, {"v": 2})
    resume_versions.update_content(db, profile, {"v": 3})
    db.flush()
    assert profile.content == {"v": 3} and profile.current_version == 3

    ok = resume_versions.rollback(db, profile, 1)
    db.flush()
    assert ok is True
    assert profile.content == {"v": 1}
    # Rollback snapshotted the pre-rollback content (v3 at version 3), so the
    # current content advances to a new version and nothing is lost.
    assert profile.current_version == 4
    assert any(v.content == {"v": 3} for v in profile.versions)


def test_rollback_to_missing_version_returns_false(db, profile):
    assert resume_versions.rollback(db, profile, 99) is False
