"""Brag bank CRUD: the candidate's supplemental, attested evidence.

These facts widen what tailoring may honestly draw on. They're per-user (not
per-résumé), since a true fact about your work applies to every application.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbSession
from app.models.evidence import EvidenceItem
from app.schemas.evidence import EvidenceCreate, EvidenceResponse, EvidenceUpdate

router = APIRouter(prefix="/evidence", tags=["evidence"])

_MAX_ITEMS = 200  # a generous bound; the brag bank is a curated set, not a log.


@router.get("", response_model=list[EvidenceResponse])
def list_evidence(user: CurrentUser, db: DbSession) -> list[EvidenceItem]:
    return list(
        db.scalars(
            select(EvidenceItem)
            .where(EvidenceItem.user_id == user.id)
            .order_by(EvidenceItem.created_at.desc())
        )
    )


@router.post("", response_model=EvidenceResponse, status_code=status.HTTP_201_CREATED)
def create_evidence(
    payload: EvidenceCreate, user: CurrentUser, db: DbSession
) -> EvidenceItem:
    total = db.scalar(
        select(func.count(EvidenceItem.id)).where(EvidenceItem.user_id == user.id)
    ) or 0
    if total >= _MAX_ITEMS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You've reached the {_MAX_ITEMS}-item limit. Trim older evidence first.",
        )
    item = EvidenceItem(
        user_id=user.id,
        kind=payload.kind,
        text=payload.text.strip(),
        label=(payload.label or "").strip() or None,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _owned(db: DbSession, user_id: uuid.UUID, item_id: uuid.UUID) -> EvidenceItem:
    item = db.get(EvidenceItem, item_id)
    if item is None or item.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Evidence item not found."
        )
    return item


@router.patch("/{item_id}", response_model=EvidenceResponse)
def update_evidence(
    item_id: uuid.UUID, payload: EvidenceUpdate, user: CurrentUser, db: DbSession
) -> EvidenceItem:
    item = _owned(db, user.id, item_id)
    if payload.kind is not None:
        item.kind = payload.kind
    if payload.text is not None:
        item.text = payload.text.strip()
    if payload.label is not None:
        item.label = payload.label.strip() or None
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_evidence(item_id: uuid.UUID, user: CurrentUser, db: DbSession) -> None:
    item = _owned(db, user.id, item_id)
    db.delete(item)
    db.commit()
