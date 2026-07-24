"""Résumé version history: snapshot-on-edit and rollback.

The invariant: ``ResumeProfile.content`` is always the live résumé, and every
*previous* content is preserved as a ``ResumeVersion``. So editing snapshots the
old content first; rolling back snapshots the current content first, then swaps
in the chosen version — which keeps a rollback itself reversible.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session as DbSession

from app.models.resume import ResumeProfile, ResumeVersion


def snapshot_current(
    db: DbSession, profile: ResumeProfile, *, label: str | None = None
) -> ResumeVersion:
    """Freeze the profile's current content as a version at its current number.

    Appends through the ``versions`` relationship rather than ``db.add`` so the
    in-memory collection stays consistent within the same transaction — the
    caller (and any later read of ``profile.versions``) sees the new snapshot
    without an intervening refresh.
    """
    version = ResumeVersion(
        version=profile.current_version,
        content=profile.content,
        label=label,
    )
    profile.versions.append(version)
    db.flush()
    return version


def update_content(
    db: DbSession,
    profile: ResumeProfile,
    new_content: dict[str, Any],
    *,
    label: str | None = None,
) -> None:
    """Snapshot the existing content, then advance to ``new_content``.

    Skips the snapshot when nothing actually changed, so re-saving an unedited
    résumé doesn't inflate the history.
    """
    if profile.content == new_content:
        return
    snapshot_current(db, profile, label=label)
    profile.content = new_content
    profile.current_version += 1


def rollback(db: DbSession, profile: ResumeProfile, target_version: int) -> bool:
    """Restore a prior version's content. Returns False if it doesn't exist."""
    target = next((v for v in profile.versions if v.version == target_version), None)
    if target is None:
        return False
    # Preserve the current content first so the rollback can be undone.
    snapshot_current(db, profile, label=f"before restoring v{target_version}")
    profile.content = target.content
    profile.current_version += 1
    return True
