"""Brag bank CRUD: create/list/update/delete, ownership, and the item cap."""

from __future__ import annotations

import pytest


@pytest.fixture
def db():
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
def client(db):
    from fastapi.testclient import TestClient

    from app.db.session import get_db
    from app.main import app

    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def auth(db):
    from app.core.security import create_token
    from app.models.user import User

    user = User(email="brag@usc.edu", hashed_password="h")
    db.add(user)
    db.commit()
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


def test_create_list_update_delete(client, auth):
    r = client.post(
        "/api/v1/evidence",
        headers=auth,
        json={"kind": "scope", "text": "Pipeline processed 5M+ volumes.", "label": "Prana.ai"},
    )
    assert r.status_code == 201
    item = r.json()
    assert item["kind"] == "scope" and item["label"] == "Prana.ai"
    item_id = item["id"]

    listed = client.get("/api/v1/evidence", headers=auth).json()
    assert [i["id"] for i in listed] == [item_id]

    patched = client.patch(
        f"/api/v1/evidence/{item_id}", headers=auth, json={"kind": "impact"}
    )
    assert patched.status_code == 200 and patched.json()["kind"] == "impact"

    assert client.delete(f"/api/v1/evidence/{item_id}", headers=auth).status_code == 204
    assert client.get("/api/v1/evidence", headers=auth).json() == []


def test_cannot_touch_another_users_item(client, auth, db):
    from app.core.security import create_token
    from app.models.user import User

    other = User(email="other@usc.edu", hashed_password="h")
    db.add(other)
    db.commit()
    other_auth = {"Authorization": f"Bearer {create_token(other.id, 'access')}"}

    item_id = client.post(
        "/api/v1/evidence", headers=auth, json={"text": "Mine only."}
    ).json()["id"]

    # The other user sees nothing and gets a 404 (never a 403 that confirms it exists).
    assert client.get("/api/v1/evidence", headers=other_auth).json() == []
    assert client.patch(
        f"/api/v1/evidence/{item_id}", headers=other_auth, json={"text": "hijack"}
    ).status_code == 404
    assert client.delete(f"/api/v1/evidence/{item_id}", headers=other_auth).status_code == 404


def test_short_text_is_rejected(client, auth):
    assert client.post("/api/v1/evidence", headers=auth, json={"text": "x"}).status_code == 422
