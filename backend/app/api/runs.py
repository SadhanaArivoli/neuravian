import asyncio
import json
import logging
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.database import SessionLocal, get_db
from app.models.run import ProvenanceEvent, Run
from app.schemas.run import RunCreate, RunRead, RunSummary
from app.services.run import RunService, get_log_history, subscribe, unsubscribe

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


@router.get("/runs/{run_id}/provenance")
def get_run_provenance(run_id: int, db: Session = Depends(get_db)) -> dict:
    """Return structured provenance for a run: run-level fields + event log."""
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    events = (
        db.query(ProvenanceEvent)
        .filter(ProvenanceEvent.run_id == run_id)
        .order_by(ProvenanceEvent.timestamp)
        .all()
    )

    import json as _json
    return {
        "run_id": run_id,
        "pipeline_version": run.pipeline_version,
        "container_digest": run.container_digest,
        "params": _json.loads(run.params_json or "{}"),
        "status": run.status,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "events": [
            {
                "event_type": e.event_type,
                "timestamp": e.timestamp.isoformat(),
                "payload": _json.loads(e.payload_json or "{}"),
            }
            for e in events
        ],
    }


@router.get("/runs/{run_id}/results")
def get_run_results(run_id: int, svc: RunService = Depends(_svc)) -> dict:
    """Discover HTML reports and JSON IQM files in the run's output directory."""
    try:
        run = svc.get_by_id(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    if not run.output_dir:
        return {"reports": [], "metrics": []}

    output_root = Path(run.output_dir)
    if not output_root.exists():
        return {"reports": [], "metrics": []}

    reports = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.glob("*.html"))
    ]
    metrics = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.rglob("sub-*.json"))
    ]
    # NIfTI derivatives: any .nii or .nii.gz file in the output tree.
    # MRIQC produces none; fMRIPrep and similar tools produce many.
    # FileResponse serves these as application/octet-stream, which is
    # correct — Niivue reads format from the filename, not Content-Type.
    niftis = [
        {"name": f.name, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.rglob("*"))
        if f.name.endswith(".nii.gz") or f.name.endswith(".nii")
    ]
    return {"reports": reports, "metrics": metrics, "niftis": niftis}


@router.get("/runs/{run_id}/files/{file_path:path}")
def serve_run_file(run_id: int, file_path: str, svc: RunService = Depends(_svc)) -> FileResponse:
    """Serve a file from the run's output directory.

    Scoped strictly to each run's own output_dir — path traversal attempts
    (e.g. ../../etc/passwd) are rejected with 403 before any filesystem access.
    """
    try:
        run = svc.get_by_id(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    if not run.output_dir:
        raise HTTPException(status_code=404, detail="No output directory for this run")

    output_root = Path(run.output_dir).resolve()
    requested = (output_root / file_path).resolve()

    # Path traversal protection: raises ValueError if requested is outside output_root
    try:
        requested.relative_to(output_root)
    except ValueError:
        raise HTTPException(status_code=403, detail="Path not allowed")

    if not requested.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FileResponse(str(requested))


@router.websocket("/runs/{run_id}/logs/stream")
async def stream_run_logs(websocket: WebSocket, run_id: int) -> None:
    await websocket.accept()

    # Send history first — in-memory buffer if available, otherwise the
    # partial log file (covers page-refresh mid-run or post-restart reconnect)
    history = get_log_history(run_id)
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
