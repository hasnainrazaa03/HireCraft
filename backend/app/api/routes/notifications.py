"""In-app notification feed."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import func, select, update

from app.api.deps import CurrentUser, DbSession
from app.models.notification import Notification
from app.schemas.api import ApiModel

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationResponse(ApiModel):
    id: uuid.UUID
    kind: str
    title: str
    body: str | None
    link: str | None
    read_at: datetime | None
    created_at: datetime


class NotificationList(ApiModel):
    items: list[NotificationResponse]
    unread_count: int


@router.get("", response_model=NotificationList)
def list_notifications(
    user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=30, ge=1, le=100),
    unread_only: bool = False,
) -> NotificationList:
    stmt = (
        select(Notification)
        .where(Notification.user_id == user.id)
        .order_by(Notification.created_at.desc())
        .limit(limit)
    )
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    items = list(db.scalars(stmt))

    unread = db.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == user.id, Notification.read_at.is_(None)
        )
    ) or 0
    return NotificationList(
        items=[NotificationResponse.model_validate(n) for n in items],
        unread_count=int(unread),
    )


@router.post("/{notification_id}/read", response_model=NotificationResponse)
def mark_read(
    notification_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> NotificationResponse:
    notification = db.get(Notification, notification_id)
    if notification is None or notification.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found.")
    if notification.read_at is None:
        notification.read_at = datetime.now(UTC)
        db.commit()
        db.refresh(notification)
    return NotificationResponse.model_validate(notification)


@router.post("/read-all", response_model=NotificationList)
def mark_all_read(user: CurrentUser, db: DbSession) -> NotificationList:
    db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        .values(read_at=datetime.now(UTC))
    )
    db.commit()
    return list_notifications(user, db)


@router.delete("/{notification_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_notification(
    notification_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> None:
    notification = db.get(Notification, notification_id)
    if notification is None or notification.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found.")
    db.delete(notification)
    db.commit()
