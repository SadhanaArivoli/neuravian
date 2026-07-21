"""
Workspace Replication Engine — server-side endpoints.

The cloud VM is an execution environment with a temporary replication cache,
not a second authoritative NeuroForge installation. Objects flow:

  desktop (authoritative)  →  PUT /replication/objects/:id  →  VM cache
  VM cache                 →  GET /replication/objects/:id  →  desktop
  VM cache summary         →  GET /replication/snapshot     →  desktop

The VM never mints objectIds, never increments revisions, and never calls
back to the desktop. The desktop drives all replication decisions.

The SSE endpoint (GET /replication/events) streams WREEvents to the desktop
so it can react without polling. The 15-second polling loop stays as a
reconnection fallback.
"""

import asyncio
import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Any, AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import Column, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Session

from app.core.database import Base, SessionLocal, engine, get_db

log = logging.getLogger(__name__)
router = APIRouter(tags=["replication"])

# ── SQLAlchemy model ──────────────────────────────────────────────────────────


class ReplicatedObject(Base):
    """
    Ephemeral cache of NeuroForgeObjects pushed from the desktop.
    This table exists only to support execution — it is not authoritative.
    It can be wiped when the VM shuts down without any data loss
    (the desktop holds the canonical copy).
    """

    __tablename__ = "replicated_objects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    object_id = Column(String, unique=True, nullable=False, index=True)
    object_type = Column(String, nullable=False)
    revision = Column(Integer, nullable=False)
    content_hash = Column(String, nullable=False)
    created_at = Column(String, nullable=False)
    modified_at = Column(String, nullable=False)
    payload_json = Column(Text, nullable=False)
    cached_at = Column(DateTime, server_default=func.now(), nullable=False)


Base.metadata.create_all(bind=engine)

# ── SSE event bus ─────────────────────────────────────────────────────────────
# In-process async queue. Callers push WREEvent dicts here; connected
# SSE clients drain them. This is intentionally simple — one process,
# one VM, no cross-process pub/sub needed.

_sse_subscribers: list[asyncio.Queue[dict]] = []


def _broadcast(event: dict) -> None:
    """Broadcast a WREEvent to all connected SSE subscribers."""
    for q in _sse_subscribers:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass  # slow subscriber; they'll catch up on the next poll cycle


def _sse_event(event_type: str, data: dict) -> str:
    """Format as SSE wire format."""
    payload = json.dumps({"type": event_type, **data})
    return f"data: {payload}\n\n"


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.put("/replication/objects/{object_id}", status_code=204)
def upsert_object(
    object_id: str,
    body: dict[str, Any],
    db: Session = Depends(get_db),
) -> None:
    """
    Accept a NeuroForgeObject from the desktop and cache it.
    Idempotent: if the object already exists at the same revision and
    contentHash, this is a no-op. If the revision is higher, the cache
    is updated.
    """
    required = {"objectId", "objectType", "revision", "contentHash", "createdAt", "modifiedAt", "payload"}
    missing = required - body.keys()
    if missing:
        raise HTTPException(status_code=422, detail=f"Missing fields: {missing}")

    if body["objectId"] != object_id:
        raise HTTPException(status_code=422, detail="objectId in body must match URL parameter")

    # Verify contentHash matches the payload
    canonical = json.dumps(body["payload"], sort_keys=True, separators=(",", ":"))
    expected_hash = hashlib.sha256(canonical.encode()).hexdigest()
    if body["contentHash"] != expected_hash:
        raise HTTPException(
            status_code=422,
            detail=f"contentHash mismatch: expected {expected_hash}, got {body['contentHash']}",
        )

    existing = db.query(ReplicatedObject).filter_by(object_id=object_id).first()

    if existing:
        if existing.revision >= body["revision"] and existing.content_hash == body["contentHash"]:
            return  # already at this revision; no-op
        existing.object_type = body["objectType"]
        existing.revision = body["revision"]
        existing.content_hash = body["contentHash"]
        existing.created_at = body["createdAt"]
        existing.modified_at = body["modifiedAt"]
        existing.payload_json = json.dumps(body["payload"])
        existing.cached_at = datetime.now(UTC)
        db.commit()
    else:
        obj = ReplicatedObject(
            object_id=object_id,
            object_type=body["objectType"],
            revision=body["revision"],
            content_hash=body["contentHash"],
            created_at=body["createdAt"],
            modified_at=body["modifiedAt"],
            payload_json=json.dumps(body["payload"]),
        )
        db.add(obj)
        db.commit()

    _broadcast({
        "type": "object:cached",
        "objectId": object_id,
        "objectType": body["objectType"],
        "revision": body["revision"],
    })


@router.get("/replication/objects/{object_id}")
def get_object(object_id: str, db: Session = Depends(get_db)) -> dict:
    """Fetch a single cached object by its desktop-assigned objectId."""
    obj = db.query(ReplicatedObject).filter_by(object_id=object_id).first()
    if not obj:
        raise HTTPException(status_code=404, detail=f"Object {object_id!r} not in replication cache")
    return {
        "objectId": obj.object_id,
        "objectType": obj.object_type,
        "revision": obj.revision,
        "contentHash": obj.content_hash,
        "createdAt": obj.created_at,
        "modifiedAt": obj.modified_at,
        "payload": json.loads(obj.payload_json),
    }


@router.get("/replication/snapshot")
def get_snapshot(db: Session = Depends(get_db)) -> dict:
    """
    Return the revision summary of every object in the cache.
    The desktop diffs this against its local object store to determine
    what to push (desktop has higher revision) and what to pull
    (cache has objects desktop hasn't seen).
    """
    rows = db.query(
        ReplicatedObject.object_id,
        ReplicatedObject.object_type,
        ReplicatedObject.revision,
        ReplicatedObject.content_hash,
    ).all()
    return {
        "workspaceId": None,  # filled in by the VM's workspace identity endpoint
        "snapshotAt": datetime.now(UTC).isoformat(),
        "objects": [
            {
                "objectId": r.object_id,
                "objectType": r.object_type,
                "revision": r.revision,
                "contentHash": r.content_hash,
            }
            for r in rows
        ],
    }


@router.get("/replication/events")
async def stream_events(request: Request) -> StreamingResponse:
    """
    Server-Sent Events stream of WREEvents.

    The desktop subscribes here on workspace:connected and reacts to events
    immediately rather than waiting for the next polling interval. The
    15-second polling loop stays as a reconnection fallback when this
    connection drops.

    Event types emitted:
      object:cached     — an object was pushed and accepted
      heartbeat         — keepalive every 15 s so proxies don't close the connection
    """
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=256)
    _sse_subscribers.append(queue)

    async def generate() -> AsyncGenerator[str, None]:
        try:
            yield _sse_event("connected", {"timestamp": datetime.now(UTC).isoformat()})
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield _sse_event(event.pop("type"), event)
                except asyncio.TimeoutError:
                    yield _sse_event("heartbeat", {"timestamp": datetime.now(UTC).isoformat()})
        finally:
            _sse_subscribers.remove(queue)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable Nginx/Caddy buffering for SSE
        },
    )
