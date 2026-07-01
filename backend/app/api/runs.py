import asyncio
import json
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.core.database import SessionLocal, get_db
from app.models.run import Run
from app.schemas.run import RunCreate, RunRead, RunSummary
from app.services.run import RunService, get_log_buffer, subscribe, unsubscribe

log = logging.getLogger(__name__)
router = APIRouter(tags=["runs"])


def _svc(db: Session = Depends(get_db)) -> RunService:
    return RunService(db)


@router.post("/runs", status_code=201)
def create_run(
    body: RunCreate,
    background_tasks: BackgroundTasks,
    svc: RunService = Depends(_svc),
) -> RunRead:
    try:
        return svc.create_run(body, background_tasks)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/runs")
def list_runs(svc: RunService = Depends(_svc)) -> list[RunSummary]:
    return svc.list_all()


@router.get("/runs/{run_id}")
def get_run(run_id: int, svc: RunService = Depends(_svc)) -> RunRead:
    try:
        return svc.get_by_id(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")


@router.get("/runs/{run_id}/logs")
def get_run_logs(run_id: int, svc: RunService = Depends(_svc)) -> dict:
    text = svc.get_log_text(run_id)
    if text is None:
        # Fall back to in-memory buffer if log file not written yet
        lines = get_log_buffer(run_id)
        text = "\n".join(lines) if lines else None
    return {"run_id": run_id, "log_text": text}


@router.websocket("/runs/{run_id}/logs/stream")
async def stream_run_logs(websocket: WebSocket, run_id: int) -> None:
    await websocket.accept()

    # Send buffered history first so a late-connecting client catches up
    history = get_log_buffer(run_id)
    for line in history:
        await websocket.send_text(json.dumps({"type": "log", "line": line}))

    # If run is already finished, send done and close
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        if run and run.status in ("success", "failed"):
            await websocket.send_text(
                json.dumps({"type": "done", "status": run.status, "error_message": run.error_message})
            )
            await websocket.close()
            return
        if run is None:
            await websocket.send_text(json.dumps({"type": "error", "detail": "Run not found"}))
            await websocket.close()
            return

    # Subscribe to live log lines
    queue = subscribe(run_id)
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                # Heartbeat to keep the connection alive
                try:
                    await websocket.send_text(json.dumps({"type": "heartbeat"}))
                except Exception:
                    break
                continue

            if item is None:
                # Sentinel: run has ended — fetch final status from DB
                with SessionLocal() as db:
                    run = db.get(Run, run_id)
                    status = run.status if run else "unknown"
                    error_msg = run.error_message if run else None
                await websocket.send_text(
                    json.dumps({"type": "done", "status": status, "error_message": error_msg})
                )
                break

            await websocket.send_text(json.dumps({"type": "log", "line": item}))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.warning("WebSocket error for run %d: %s", run_id, exc)
    finally:
        unsubscribe(run_id, queue)
