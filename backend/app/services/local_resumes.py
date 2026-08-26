"""Résumé PDFs a user keeps on disk, offered alongside the ones uploaded here.

People tailor a résumé per application and keep the results in a folder. Making
them re-upload each one to attach it is the app refusing to use what is already
there, and a browser extension cannot read local files itself.

The API can, since it runs on the same machine, so the folder is mounted
read-only and listed here.

Every path decision is made on this side. A caller names a file by an opaque id
this module minted, never by a path, so there is no string a client could send
that resolves anywhere unexpected — the traversal question does not arise
rather than being defended against.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from app.core.logging import get_logger

logger = get_logger(__name__)

#: Where to look, and what to call what is found there. Only these, so a folder
#: of unrelated PDFs sitting alongside cannot be offered as a résumé.
_BASE = "base"
_APPLICATIONS = "applications"

#: A cover letter is not a résumé, and attaching one as a résumé is worse than
#: attaching nothing — it looks done.
_NOT_A_RESUME = ("coverletter", "cover_letter", "cover letter", "transcript")


@dataclass(frozen=True)
class LocalResume:
    """One PDF found on disk."""

    id: str
    name: str
    #: "base", or the application folder's name — what the picker groups by.
    folder: str
    path: Path
    modified: float

    @property
    def label(self) -> str:
        return f"{self.name} · {self.folder}"


def _identify(relative: str) -> str:
    """A stable, opaque handle for a file, derived from where it sits.

    Opaque so a client cannot ask for a path, stable so a picked résumé stays
    picked across a reload, and derived from the path so it needs no storage.
    """
    return hashlib.sha256(relative.encode("utf-8")).hexdigest()[:16]


def _looks_like_a_resume(path: Path) -> bool:
    if path.suffix.lower() != ".pdf":
        return False
    lowered = path.name.lower()
    return not any(word in lowered for word in _NOT_A_RESUME)


def _collect(root: Path, folder: Path, label: str) -> list[LocalResume]:
    found: list[LocalResume] = []
    if not folder.is_dir():
        return found
    for path in sorted(folder.iterdir()):
        if not path.is_file() or not _looks_like_a_resume(path):
            continue
        relative = str(path.relative_to(root))
        found.append(
            LocalResume(
                id=_identify(relative),
                name=path.stem,
                folder=label,
                path=path,
                modified=path.stat().st_mtime,
            )
        )
    return found


def list_local(root_dir: str) -> list[LocalResume]:
    """Every résumé PDF under the folder, newest application folders first.

    Returns nothing at all when the folder is absent or unreadable, which is the
    ordinary case for anyone who has not set one up.
    """
    root = Path(root_dir)
    try:
        if not root.is_dir():
            return []
    except OSError:
        return []

    try:
        found = _collect(root, root / _BASE, "base")
        # A "fulltime" subfolder is a common way to keep a second set.
        found += _collect(root, root / _BASE / "fulltime", "base · full-time")

        applications = root / _APPLICATIONS
        if applications.is_dir():
            for company in sorted(applications.iterdir()):
                if company.is_dir():
                    found += _collect(root, company, company.name)
    except OSError as exc:
        logger.warning("local_resumes.unreadable", error=str(exc)[:200])
        return []

    # Most recently edited first: the one being worked on is the one wanted.
    found.sort(key=lambda item: item.modified, reverse=True)
    return found


def find_local(root_dir: str, resume_id: str) -> LocalResume | None:
    """The file behind an id, or nothing.

    Resolved by re-listing rather than by rebuilding a path from the id, so an
    id for a file that has since been deleted or renamed returns nothing
    instead of a stale read.
    """
    return next((item for item in list_local(root_dir) if item.id == resume_id), None)
