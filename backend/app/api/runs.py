import asyncio
import io
import json
import logging
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from app.core.database import SessionLocal, get_db
from app.models.dataset import Dataset
from app.models.run import ProvenanceEvent, Run
from app.schemas.run import RunCreate, RunRead, RunSummary
from app.execution.docker_executor import to_host_path
from app.services.artifact_registry import resolve_run_artifacts
from app.services.pipeline import get_registry
from app.services.run import (
    RunService,
    get_log_buffer,
    get_log_history,
    subscribe,
    unsubscribe,
    _broadcast_done,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["runs"])


def _svc(db: Session = Depends(get_db)) -> RunService:
    return RunService(db)


@router.post("/runs", status_code=201)
def create_run(
    body: RunCreate,
    svc: RunService = Depends(_svc),
) -> RunRead:
    try:
        return svc.create_run(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/runs")
def list_runs(svc: RunService = Depends(_svc)) -> list[RunSummary]:
    return svc.list_all()


@router.get("/runs/queue")
def get_queue() -> dict:
    """Return the current execution queue state."""
    from app.services.execution_queue import get_queue_status
    return get_queue_status()


@router.get("/runs/{run_id}")
def get_run(run_id: int, svc: RunService = Depends(_svc)) -> RunRead:
    try:
        return svc.get_by_id(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: int, db: Session = Depends(get_db)) -> dict:
    """Request cancellation of a queued or running run."""
    run = db.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    if run.status not in ("queued", "pending", "running"):
        raise HTTPException(
            status_code=400,
            detail=f"Run {run_id} cannot be cancelled (status: '{run.status}').",
        )

    run.cancel_requested = True
    db.commit()

    # Remove from queue immediately if still waiting
    from app.services.execution_queue import remove_from_queue
    was_queued = remove_from_queue(run_id)
    if was_queued:
        run.status = "cancelled"
        run.finished_at = datetime.now(UTC)
        run.error_message = "Run was cancelled by user request."
        db.add(ProvenanceEvent(
            run_id=run_id,
            event_type="run_cancelled",
            payload_json='{"reason": "cancelled while queued"}',
        ))
        db.commit()
        _broadcast_done(run_id)
        return {"cancelled": True, "was_queued": True}

    # Signal the running container/process to stop
    from app.execution.docker_executor import _active_containers
    cid = _active_containers.get(run_id)
    if cid:
        try:
            import docker
            docker.from_env().containers.get(cid).stop(timeout=30)
        except Exception as exc:
            log.warning("Could not stop container for run %d: %s", run_id, exc)

    from app.execution.native_executor import _active_native_procs
    proc = _active_native_procs.get(run_id)
    if proc:
        try:
            proc.terminate()
        except Exception as exc:
            log.warning("Could not terminate native process for run %d: %s", run_id, exc)

    return {"cancelled": False, "cancel_requested": True}


@router.post("/runs/{run_id}/retry")
def retry_run(run_id: int, svc: RunService = Depends(_svc)) -> RunRead:
    """Create a new run with the same params as a failed/cancelled/interrupted run."""
    try:
        return svc.rerun(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/runs/{run_id}/rerun")
def rerun_run(run_id: int, svc: RunService = Depends(_svc)) -> RunRead:
    """Create a new run with the same params (available for any finished run)."""
    try:
        return svc.rerun(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: int, svc: RunService = Depends(_svc)) -> None:
    """Delete a finished run record from the database (output files are preserved)."""
    try:
        svc.delete_run(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


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


def _build_run_metadata(run, svc: RunService) -> dict:
    """Assemble provenance metadata for a run from stored fields and the manifest registry.

    `run` is a RunRead schema (returned by svc.get_by_id). Lineage columns
    live only on the ORM Run model, so we fetch the raw row for those fields.
    """
    registry = get_registry()
    manifest = registry.get(run.pipeline_manifest_id, {})

    # ── Timestamps / runtime ──────────────────────────────────────────────────
    runtime_seconds: int | None = None
    if run.started_at and run.finished_at:
        delta = run.finished_at - run.started_at
        runtime_seconds = int(delta.total_seconds())

    # ── Execution type: docker vs native ─────────────────────────────────────
    container_cfg = manifest.get("container")
    if container_cfg:
        execution_type = "docker"
        container_image: str | None = f"{container_cfg['image']}:{container_cfg['tag']}"
    else:
        execution_type = "native"
        container_image = None

    # ── Dataset name ─────────────────────────────────────────────────────────
    dataset = svc.db.get(Dataset, run.dataset_id)
    dataset_name: str | None = dataset.name if dataset else None
    dataset_path: str | None = (
        to_host_path(dataset.path) if dataset and dataset.path else None
    )

    # ── Output path (host-accessible) ────────────────────────────────────────
    output_dir_host: str | None = (
        to_host_path(run.output_dir) if run.output_dir else None
    )

    # ── Workflow lineage ─────────────────────────────────────────────────────
    # Lineage columns live on the ORM Run model, not the RunRead schema.
    import json as _json
    lineage: dict | None = None
    orm_run: Run | None = svc.db.get(Run, run.id)
    if orm_run and orm_run.source_artifacts_json:
        try:
            lineage = _json.loads(orm_run.source_artifacts_json)
        except Exception:
            pass

    # ── Auto-registered dataset (dcm2bids output) ────────────────────────────
    registered_dataset_id: int | None = None
    registered_dataset_name: str | None = None
    if run.pipeline_manifest_id == "dcm2bids" and run.output_dir:
        from pathlib import Path as _Path
        resolved_output = str(_Path(run.output_dir).resolve())
        reg_ds = svc.db.query(Dataset).filter(Dataset.path == resolved_output).first()
        if reg_ds:
            registered_dataset_id = reg_ds.id
            registered_dataset_name = reg_ds.name

    return {
        "run_id": run.id,
        "pipeline_id": run.pipeline_manifest_id,
        "pipeline_display_name": manifest.get("display_name"),
        "pipeline_version": run.pipeline_version,
        "status": run.status,
        "compute_profile": manifest.get("compute_profile"),
        "execution_type": execution_type,
        "container_image": container_image,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "runtime_seconds": runtime_seconds,
        "dataset_id": run.dataset_id,
        "dataset_name": dataset_name,
        "dataset_path": dataset_path,
        "output_dir": output_dir_host,
        "command_preview": run.command_preview,
        "params": run.params,
        "lineage": lineage,
        "registered_dataset_id": registered_dataset_id,
        "registered_dataset_name": registered_dataset_name,
    }


@router.get("/runs/{run_id}/results")
def get_run_results(run_id: int, svc: RunService = Depends(_svc)) -> dict:
    """Discover HTML reports and JSON IQM files in the run's output directory."""
    try:
        run = svc.get_by_id(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    if not run.output_dir:
        return {
            "reports": [], "metrics": [], "group_tables": [], "images": [],
            "connectivity_matrices": [], "timeseries": [], "connectivity_metadata": [],
            "roi_statistics": [], "roi_extraction": [], "graph_analysis": [],
            "group_summary": None,
            "niftis": [], "artifacts": [],
            "metadata": _build_run_metadata(run, svc),
        }

    output_root = Path(run.output_dir)
    if not output_root.exists():
        return {
            "reports": [], "metrics": [], "group_tables": [], "images": [],
            "connectivity_matrices": [], "timeseries": [], "connectivity_metadata": [],
            "roi_statistics": [], "roi_extraction": [], "graph_analysis": [],
            "group_summary": None,
            "niftis": [], "artifacts": [],
            "metadata": _build_run_metadata(run, svc),
        }

    reports = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.glob("*.html"))
    ]
    metrics = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.rglob("sub-*.json"))
    ]
    group_tables = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.glob("group_*.tsv"))
    ]
    images = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.glob("*.png"))
    ]
    connectivity_matrices = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.glob("*connectivity_matrix*.csv"))
    ]
    timeseries = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.glob("*timeseries*.tsv"))
    ]
    connectivity_metadata = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.glob("*connectivity_metadata*.json"))
    ]
    roi_statistics = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.glob("*roi_statistics*"))
        if f.suffix in {".csv", ".json"}
    ]
    roi_extraction = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.glob("roi_extraction*"))
        if f.suffix in {".csv", ".json"}
    ]
    graph_analysis = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.iterdir())
        if f.name in {
            "graph_metrics.json", "node_metrics.csv", "edge_list.csv",
            "graph_report.html", "graph_summary.png",
        }
    ]
    cluster_files = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.iterdir())
        if f.name in {
            "cluster_table.json", "cluster_table.csv",
            "cluster_overlay.png", "cluster_report.html",
            "cluster_metadata.json", "thresholded_map.nii.gz",
        }
    ]
    group_summary_path = output_root / "group_summary.json"
    group_summary: dict | None = None
    if group_summary_path.exists():
        try:
            import json as _json
            with open(group_summary_path) as _f:
                group_summary = _json.load(_f)
        except Exception:
            log.exception("Failed to parse group_summary.json for run %d", run_id)
    # Volumetric files: NIfTI (.nii/.nii.gz) and FreeSurfer MGZ (.mgz).
    # MRIQC produces none; fMRIPrep and FastSurfer produce many.
    # NiiVue reads format from the filename, not Content-Type, so
    # serving as application/octet-stream is correct for all three.
    _VOL_EXTS = (".nii.gz", ".nii", ".mgz")
    niftis = [
        {"name": f.name, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.rglob("*"))
        if any(f.name.endswith(ext) for ext in _VOL_EXTS)
    ]
    # Resolved artifact types from the manifest's produces[] declarations.
    # Used by the frontend to query compatible downstream pipelines.
    # Only populated for successful runs — no artifacts for failed/running runs.
    artifacts: list[dict] = []
    if run.status == "success":
        try:
            registry = get_registry()
            manifest = registry.get(run.pipeline_manifest_id, {})
            resolved = resolve_run_artifacts(
                manifest=manifest,
                output_dir=run.output_dir or "",
                params=run.params,
                status=run.status,
            )
            artifacts = [
                {
                    "type": a.type,
                    "label": a.label,
                    "description": a.description,
                    "resolved": a.resolved,
                    "multiple": a.multiple,
                    "resolution_source": a.resolution_source,
                    "paths": a.paths,
                    "host_paths": [to_host_path(p) for p in a.paths],
                }
                for a in resolved
            ]
        except Exception:
            log.exception("Artifact resolution failed for run %d", run_id)

    return {
        "reports": reports,
        "metrics": metrics,
        "group_tables": group_tables,
        "images": images,
        "connectivity_matrices": connectivity_matrices,
        "timeseries": timeseries,
        "connectivity_metadata": connectivity_metadata,
        "roi_statistics": roi_statistics,
        "roi_extraction": roi_extraction,
        "graph_analysis": graph_analysis,
        "cluster_files": cluster_files,
        "group_summary": group_summary,
        "niftis": niftis,
        "artifacts": artifacts,
        "metadata": _build_run_metadata(run, svc),
    }


@router.get("/runs/{run_id}/download")
def download_run_results(run_id: int, svc: RunService = Depends(_svc)) -> Response:
    """Return the run's entire output directory as a ZIP archive.

    Scoped strictly to output_dir — no files outside it are included.
    Only available for successful runs that have an output directory.
    """
    try:
        run = svc.get_by_id(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")

    if not run.output_dir:
        raise HTTPException(status_code=404, detail="Run has no output directory")

    output_root = Path(run.output_dir).resolve()
    if not output_root.exists():
        raise HTTPException(status_code=404, detail="Output directory not found on disk")

    data_files = sorted(f for f in output_root.rglob("*") if f.is_file())
    if not data_files:
        raise HTTPException(status_code=404, detail="Output directory contains no files")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for fpath in data_files:
            zf.write(fpath, fpath.relative_to(output_root))
    buf.seek(0)

    slug = run.pipeline_manifest_id.replace(" ", "-").lower()
    filename = f"neuroforge-run-{run_id}-{slug}-results.zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


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

            if isinstance(item, dict):
                # Structured message (e.g. progress update) — send as-is
                await websocket.send_text(json.dumps(item))
            else:
                await websocket.send_text(json.dumps({"type": "log", "line": item}))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.warning("WebSocket error for run %d: %s", run_id, exc)
    finally:
        unsubscribe(run_id, queue)
