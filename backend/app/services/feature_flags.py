"""Feature-flag resolution: known defaults merged with DB overrides."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.feature_flag import KNOWN_FLAGS, FeatureFlag


def effective_flags(db: Session) -> dict[str, bool]:
    """The on/off state of every known flag (DB override wins over the default)."""
    overrides = {f.key: f.enabled for f in db.scalars(select(FeatureFlag))}
    return {key: overrides.get(key, default) for key, (default, _) in KNOWN_FLAGS.items()}


def is_enabled(db: Session, key: str) -> bool:
    default = KNOWN_FLAGS.get(key, (False, ""))[0]
    row = db.get(FeatureFlag, key)
    return row.enabled if row is not None else default


def set_flag(db: Session, key: str, enabled: bool) -> None:
    if key not in KNOWN_FLAGS:
        raise KeyError(key)
    row = db.get(FeatureFlag, key)
    if row is None:
        row = FeatureFlag(key=key, enabled=enabled, description=KNOWN_FLAGS[key][1])
        db.add(row)
    else:
        row.enabled = enabled
