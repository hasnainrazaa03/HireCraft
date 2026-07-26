"""Artifact storage.

Files are addressed by ``<user_id>/<application_id>/<filename>`` relative to
``settings.artifacts_dir``. Only relative paths are persisted, so the storage
root can be relocated - or swapped for an S3 prefix - without a data migration.
Every read resolves the final path and asserts it is still inside the root,
which is what stops a crafted stored path from escaping via ``..``.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")


class StorageError(Exception):
    """Raised when an artifact cannot be stored or retrieved."""


def _root() -> Path:
    """The artifacts root, created on demand.

    Filesystem failures are re-raised as ``StorageError`` — this module's
    documented failure mode and the only thing callers catch. A bare OSError
    escaping from here defeated every ``except StorageError`` in the codebase:
    "delete my account" is written to treat artifact cleanup as best-effort,
    but an unwritable root turned it into a 500 that left the account intact.
    """
    root = Path(settings.artifacts_dir).resolve()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise StorageError(f"Artifacts root {root} is unavailable: {exc}") from exc
    return root


def safe_filename(name: str, *, fallback: str = "file") -> str:
    """Reduce an arbitrary string to a filesystem-safe basename."""
    cleaned = _SAFE_NAME.sub("_", Path(name).name).strip("._")
    return cleaned[:120] or fallback


def build_relative_path(
    user_id: uuid.UUID, application_id: uuid.UUID, filename: str
) -> str:
    return f"{user_id}/{application_id}/{safe_filename(filename)}"


def save_bytes(relative_path: str, data: bytes) -> int:
    """Write ``data`` to ``relative_path`` under the artifacts root."""
    root = _root()
    target = (root / relative_path).resolve()
    if not target.is_relative_to(root):
        raise StorageError(f"Refusing to write outside the artifacts root: {relative_path!r}")

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    except OSError as exc:
        raise StorageError(f"Could not write {relative_path}: {exc}") from exc
    logger.info("storage.saved", path=relative_path, bytes=len(data))
    return len(data)


def read_bytes(relative_path: str) -> bytes:
    root = _root()
    target = (root / relative_path).resolve()
    if not target.is_relative_to(root):
        raise StorageError(f"Refusing to read outside the artifacts root: {relative_path!r}")
    if not target.is_file():
        raise StorageError(f"Artifact not found: {relative_path}")
    try:
        return target.read_bytes()
    except OSError as exc:
        raise StorageError(f"Could not read {relative_path}: {exc}") from exc


def resolve_path(relative_path: str) -> Path:
    """Absolute path for an artifact, validated against the root."""
    root = _root()
    target = (root / relative_path).resolve()
    if not target.is_relative_to(root):
        raise StorageError(f"Refusing to access outside the artifacts root: {relative_path!r}")
    return target


def delete_prefix(relative_prefix: str) -> int:
    """Delete every artifact under a prefix. Returns the number removed."""
    root = _root()
    target = (root / relative_prefix).resolve()
    if not target.is_relative_to(root) or target == root:
        raise StorageError(f"Refusing to delete {relative_prefix!r}")
    if not target.exists():
        return 0

    removed = 0
    try:
        for path in sorted(target.rglob("*"), reverse=True):
            if path.is_file():
                path.unlink()
                removed += 1
            elif path.is_dir():
                path.rmdir()
        target.rmdir()
    except OSError as exc:
        raise StorageError(f"Could not delete {relative_prefix}: {exc}") from exc
    return removed
