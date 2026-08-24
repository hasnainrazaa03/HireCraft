"""The browser extension's long-lived key, and the routes it unlocks.

The key is the one credential in the product that lives outside the app and
never expires, so what it can and cannot reach is the thing worth pinning down.
"""

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
def user(db):
    from app.models.user import User

    account = User(email="ext@usc.edu", hashed_password="h", full_name="Ada Lovelace King")
    db.add(account)
    db.commit()
    return account


@pytest.fixture
def auth(user):
    from app.core.security import create_token

    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


def issue(client, auth) -> str:
    response = client.post("/api/v1/account/extension-key", headers=auth)
    assert response.status_code == 200
    return response.json()["key"]


# --- issuing and revoking ---------------------------------------------------


def test_key_is_returned_once_and_never_again(client, auth, user, db):
    key = issue(client, auth)
    assert key.startswith("hcx_")

    db.refresh(user)
    # Only the hash is stored, so a database copy hands over nothing usable.
    assert user.extension_key_hash and user.extension_key_hash != key
    assert key not in (user.extension_key_hash or "")

    status = client.get("/api/v1/account/extension-key", headers=auth).json()
    assert status["configured"] is True
    assert "key" not in status


def test_issuing_again_invalidates_the_previous_key(client, auth):
    first = issue(client, auth)
    second = issue(client, auth)
    assert first != second
    assert client.get("/api/v1/extension/profile", headers={"X-HireCraft-Key": first}).status_code == 401
    assert client.get("/api/v1/extension/profile", headers={"X-HireCraft-Key": second}).status_code == 200


def test_revoking_stops_the_key_working(client, auth):
    key = issue(client, auth)
    assert client.get("/api/v1/extension/profile", headers={"X-HireCraft-Key": key}).status_code == 200

    assert client.delete("/api/v1/account/extension-key", headers=auth).status_code == 200
    assert client.get("/api/v1/extension/profile", headers={"X-HireCraft-Key": key}).status_code == 401


# --- what the key rejects ---------------------------------------------------


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-HireCraft-Key": ""},
        {"X-HireCraft-Key": "   "},
        {"X-HireCraft-Key": "hcx_not-a-real-key"},
        {"X-HireCraft-Key": "totally-wrong"},
    ],
)
def test_bad_or_missing_key_is_rejected(client, auth, headers):
    issue(client, auth)  # a valid key exists; these still must not work
    assert client.get("/api/v1/extension/profile", headers=headers).status_code == 401


@pytest.mark.parametrize(
    "path", ["/api/v1/resumes", "/api/v1/applications", "/api/v1/account/llm", "/api/v1/evidence"]
)
def test_key_does_not_unlock_the_rest_of_the_api(client, auth, path):
    """The point of a separate credential is that it is not a session.

    If the key worked as a bearer token anywhere else, storing it in a browser
    extension would be handing out the whole account.
    """
    key = issue(client, auth)
    assert client.get(path, headers={"X-HireCraft-Key": key}).status_code == 401


def test_disabled_account_is_refused(client, auth, user, db):
    key = issue(client, auth)
    user.is_active = False
    db.commit()
    assert client.get("/api/v1/extension/profile", headers={"X-HireCraft-Key": key}).status_code == 403


# --- the autofill payload ---------------------------------------------------


def test_profile_payload_shape(client, auth, user):
    key = issue(client, auth)
    body = client.get("/api/v1/extension/profile", headers={"X-HireCraft-Key": key}).json()

    assert body["email"] == user.email
    assert body["full_name"] == "Ada Lovelace King"
    # Everything before the final token is the first name: forms ask for two
    # fields, and a middle name belongs with the first, not dropped.
    assert body["first_name"] == "Ada Lovelace"
    assert body["last_name"] == "King"
    assert body["resumes"] == []
    # Absent details are empty strings rather than nulls, so the filler never
    # has to distinguish "missing" from "blank" before typing into a form.
    for field in ("phone", "location", "linkedin", "github", "portfolio", "website"):
        assert body[field] == ""


@pytest.mark.parametrize(
    ("full_name", "expected"),
    [
        ("Ada Lovelace", ("Ada", "Lovelace")),
        ("Mohammad Hasnain Raza", ("Mohammad Hasnain", "Raza")),
        ("Cher", ("Cher", "")),
        ("  spaced   out  ", ("spaced", "out")),
        ("", ("", "")),
        (None, ("", "")),
    ],
)
def test_name_split(full_name, expected):
    from app.api.routes.extension import _split_name

    assert _split_name(full_name) == expected


def test_career_profile_wins_over_the_resume(client, auth, user, db):
    """Both can hold a phone number; the Career Profile is the deliberate one.

    The résumé fills the gaps so the same details aren't entered twice, but it
    must not override a value the user set on the profile itself.
    """
    from app.models.profile import CareerProfile
    from app.models.resume import ResumeProfile

    db.add(
        ResumeProfile(
            user_id=user.id,
            name="Master",
            is_default=True,
            content={
                "basics": {
                    "name": "Ada Lovelace King",
                    "email": "ext@usc.edu",
                    "phone": "555-RESUME",
                    "github": "https://github.com/ada",
                }
            },
        )
    )
    db.add(CareerProfile(user_id=user.id, phone="555-PROFILE"))
    db.commit()

    key = issue(client, auth)
    body = client.get("/api/v1/extension/profile", headers={"X-HireCraft-Key": key}).json()

    assert body["phone"] == "555-PROFILE"          # profile wins where it has one
    assert body["github"] == "https://github.com/ada"  # résumé fills the gap
    assert len(body["resumes"]) == 1
