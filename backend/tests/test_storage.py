"""Artifact storage tests.

Two properties matter: a stored path can never escape the artifacts root, and
filesystem trouble surfaces as this module's own StorageError. The second is
not cosmetic — callers that treat artifact cleanup as best-effort catch exactly
that type, and a bare OSError escaping made "delete my account" a 500 that left
the account in place.
"""

from __future__ import annotations

import uuid

import pytest

from app.services import storage
from app.services.storage import StorageError


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.core import config

    monkeypatch.setattr(config.settings, "artifacts_dir", str(tmp_path / "artifacts"))
    return tmp_path / "artifacts"


@pytest.fixture
def unwritable(monkeypatch):
    """Point the root somewhere that cannot be created."""
    from app.core import config

    monkeypatch.setattr(config.settings, "artifacts_dir", "/proc/nope/artifacts")


class TestContainment:
    def test_round_trip(self, root):
        rel = storage.build_relative_path(uuid.uuid4(), uuid.uuid4(), "resume.pdf")
        assert storage.save_bytes(rel, b"%PDF-1.4 data") == 13
        assert storage.read_bytes(rel) == b"%PDF-1.4 data"

    @pytest.mark.parametrize("rel", ["../escape.pdf", "a/../../escape.pdf", "/etc/passwd"])
    def test_paths_cannot_escape_the_root(self, root, rel):
        with pytest.raises(StorageError):
            storage.save_bytes(rel, b"x")
        with pytest.raises(StorageError):
            storage.read_bytes(rel)

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            # Only the last path segment survives, so directory traversal in a
            # filename is dropped rather than escaped.
            ("../../etc/passwd", "passwd"),
            ("a b;rm -rf.pdf", "a_b_rm_-rf.pdf"),  # shell metacharacters neutralised
            ('quote".pdf', "quote_.pdf"),
            ("...", "file"),  # nothing usable left -> fallback
            ("résumé.pdf", "r_sum_.pdf"),  # non-ASCII replaced, extension kept
        ],
    )
    def test_filenames_are_reduced_to_a_safe_basename(self, raw, expected):
        assert storage.safe_filename(raw) == expected

    def test_refuses_to_delete_the_root_itself(self, root):
        storage.save_bytes("u/a/f.pdf", b"x")
        with pytest.raises(StorageError):
            storage.delete_prefix("")

    def test_delete_prefix_removes_a_subtree(self, root):
        storage.save_bytes("u/a/one.pdf", b"x")
        storage.save_bytes("u/a/two.pdf", b"y")
        assert storage.delete_prefix("u/a") == 2
        assert storage.delete_prefix("u/a") == 0  # already gone, not an error


class TestFilesystemFailuresAreStorageErrors:
    """Regression: these raised bare OSError, which every `except StorageError`
    in the app missed."""

    def test_save(self, unwritable):
        with pytest.raises(StorageError):
            storage.save_bytes("u/a/f.pdf", b"x")

    def test_read(self, unwritable):
        with pytest.raises(StorageError):
            storage.read_bytes("u/a/f.pdf")

    def test_resolve(self, unwritable):
        with pytest.raises(StorageError):
            storage.resolve_path("u/a/f.pdf")

    def test_delete(self, unwritable):
        with pytest.raises(StorageError):
            storage.delete_prefix("u/a")


class TestCallersDegradeGracefully:
    """Artifact cleanup is best-effort by design; a broken disk must not block
    a user from deleting their data."""

    @pytest.fixture
    def db(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import Session as OrmSession
        from sqlalchemy.pool import StaticPool

        import app.models  # noqa: F401
        from app.db.base import Base

        engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(engine)
        with OrmSession(engine) as session:
            yield session

    @pytest.fixture
    def client(self, db):
        from fastapi.testclient import TestClient

        from app.db.session import get_db
        from app.main import app

        app.dependency_overrides[get_db] = lambda: db
        with TestClient(app) as client:
            yield client
        app.dependency_overrides.clear()

    def test_account_deletion_survives_an_unusable_artifacts_root(
        self, client, db, unwritable
    ):
        from app.core.security import create_token
        from app.models.user import User

        user = User(email="gone@usc.edu", hashed_password="h")
        db.add(user)
        db.commit()
        headers = {"Authorization": f"Bearer {create_token(user.id, 'access')}"}

        response = client.delete("/api/v1/account", headers=headers)
        assert response.status_code == 200, response.text
        assert db.query(User).count() == 0, "the account must actually be deleted"
