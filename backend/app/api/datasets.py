import json
import logging
import os
import statistics
from collections import Counter
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.pipeline import Pipeline
from app.models.run import Run
from app.schemas.dataset import DatasetCreate, DatasetRead, DatasetSummary
from app.services.artifact_registry import resolve_run_artifacts
from app.services.dataset import DatasetService
from app.services.pipeline import get_registry

log = logging.getLogger(__name__)

router = APIRouter(prefix="/datasets", tags=["datasets"])


def _svc(db: Session = Depends(get_db)) -> DatasetService:
    return DatasetService(db)


@router.post("", response_model=DatasetRead, status_code=status.HTTP_201_CREATED)
def register_dataset(
    payload: DatasetCreate,
    svc: DatasetService = Depends(_svc),
) -> DatasetRead:
    try:
        return svc.register(payload)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.get("", response_model=list[DatasetSummary])
def list_datasets(svc: DatasetService = Depends(_svc)) -> list[DatasetSummary]:
    return svc.list_all()


@router.get("/{dataset_id}", response_model=DatasetRead)
def get_dataset(dataset_id: int, svc: DatasetService = Depends(_svc)) -> DatasetRead:
    try:
        return svc.get_by_id(dataset_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.get("/{dataset_id}/scans")
def list_dataset_scans(dataset_id: int, svc: DatasetService = Depends(_svc)) -> dict:
    """List NIfTI scan files in the dataset, grouped by path components.

    Uses a simple filesystem walk — no pybids re-indexing per request.
    Only returns .nii and .nii.gz files whose paths follow BIDS structure
    (must start with a sub-* directory).
    """
    try:
        dataset = svc.get_by_id(dataset_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))

    root = Path(dataset.path)
    if not root.exists():
        return {"scans": []}

    scans = []
    for f in sorted(root.rglob("*")):
        if not (f.name.endswith(".nii.gz") or f.name.endswith(".nii")):
            continue
        try:
            rel = f.relative_to(root)
        except ValueError:
            continue
        parts = rel.parts
        if len(parts) < 2 or not parts[0].startswith("sub-"):
            continue

        subject = parts[0][4:]  # strip "sub-"
        # Detect optional session level
        session: str | None = None
        datatype_idx = 1
        if len(parts) > 2 and parts[1].startswith("ses-"):
            session = parts[1][4:]  # strip "ses-"
            datatype_idx = 2

        datatype = parts[datatype_idx] if datatype_idx < len(parts) - 1 else None

        # Suffix: last "_"-separated token of the stem (strip .nii or .nii.gz)
        stem = f.name[:-7] if f.name.endswith(".nii.gz") else f.name[:-4]
        suffix = stem.rsplit("_", 1)[-1] if "_" in stem else stem

        scans.append({
            "subject": subject,
            "session": session,
            "datatype": datatype,
            "suffix": suffix,
            "path": rel.as_posix(),
        })

    return {"scans": scans}


@router.get("/{dataset_id}/files/{file_path:path}")
def serve_dataset_file(
    dataset_id: int,
    file_path: str,
    svc: DatasetService = Depends(_svc),
) -> FileResponse:
    """Serve a file from the dataset's root directory (read-only).

    Scoped strictly to each dataset's own directory — path traversal
    attempts (../../etc/passwd, encoded variants) are rejected with 403.
    """
    try:
        dataset = svc.get_by_id(dataset_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))

    dataset_root = Path(dataset.path).resolve()
    requested = (dataset_root / file_path).resolve()

    # Path traversal protection: raises ValueError if outside dataset_root
    try:
        requested.relative_to(dataset_root)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Path not allowed")

    if not requested.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(str(requested))


# ── Helpers ──────────────────────────────────────────────────────────────────

def _dir_size_bytes(path: Path, max_files: int = 5000) -> int:
    """Return total bytes for a directory (bounded scan)."""
    total = 0
    count = 0
    try:
        for entry in os.scandir(path):
            if count >= max_files:
                break
            if entry.is_file(follow_symlinks=False):
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
            elif entry.is_dir(follow_symlinks=False):
                total += _dir_size_bytes(Path(entry.path), max_files - count)
            count += 1
    except OSError:
        pass
    return total


def _pipeline_name(db: Session, pipeline_db_id: int) -> str:
    row = db.get(Pipeline, pipeline_db_id)
    return row.name if row else f"pipeline:{pipeline_db_id}"


def _runtime_seconds(run: Run) -> float | None:
    if run.started_at and run.finished_at:
        return (run.finished_at - run.started_at).total_seconds()
    return None


# ── Dashboard endpoint ────────────────────────────────────────────────────────

@router.get("/{dataset_id}/dashboard")
def get_dataset_dashboard(
    dataset_id: int,
    svc: DatasetService = Depends(_svc),
    db: Session = Depends(get_db),
) -> dict:
    """Aggregated project-level stats for a dataset."""
    try:
        dataset = svc.get_by_id(dataset_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))

    runs: list[Run] = db.query(Run).filter(Run.dataset_id == dataset_id).all()

    # ── Run counts ──────────────────────────────────────────────────────────
    counts: Counter[str] = Counter(r.status for r in runs)
    total = len(runs)
    success_count = counts.get("success", 0)
    success_rate = round(success_count / total * 100, 1) if total else 0.0

    # Most recently completed run (success or failed with finished_at)
    finished = [r for r in runs if r.finished_at]
    most_recent = max(finished, key=lambda r: r.finished_at) if finished else None  # type: ignore[arg-type]

    # Most commonly used pipeline
    pipeline_counter: Counter[str] = Counter(_pipeline_name(db, r.pipeline_id) for r in runs)
    most_common_pipeline = pipeline_counter.most_common(1)[0][0] if runs else None

    # ── Runtime stats ────────────────────────────────────────────────────────
    runtimes = [(r, rt) for r in runs if (rt := _runtime_seconds(r)) is not None]
    runtime_seconds_list = [rt for _, rt in runtimes]
    total_compute = sum(runtime_seconds_list)
    median_runtime = statistics.median(runtime_seconds_list) if runtime_seconds_list else None

    success_runtimes = [(r, rt) for r, rt in runtimes if r.status == "success"]
    slowest = max(success_runtimes, key=lambda x: x[1])[0] if success_runtimes else None
    fastest = min(success_runtimes, key=lambda x: x[1])[0] if success_runtimes else None

    runtime_by_pipeline: dict[str, float] = {}
    for r, rt in runtimes:
        name = _pipeline_name(db, r.pipeline_id)
        runtime_by_pipeline[name] = runtime_by_pipeline.get(name, 0.0) + rt

    # ── Storage stats ────────────────────────────────────────────────────────
    storage_by_pipeline: dict[str, int] = {}
    artifact_count = 0
    total_bytes = 0
    largest_run_id: int | None = None
    largest_run_bytes = 0
    registry = get_registry()

    for r in runs:
        if r.status != "success" or not r.output_dir:
            continue
        out = Path(r.output_dir)
        if not out.exists():
            continue
        run_bytes = _dir_size_bytes(out)
        total_bytes += run_bytes

        pid = _pipeline_name(db, r.pipeline_id)
        storage_by_pipeline[pid] = storage_by_pipeline.get(pid, 0) + run_bytes

        if run_bytes > largest_run_bytes:
            largest_run_bytes = run_bytes
            largest_run_id = r.id

        # Count resolved artifacts
        try:
            manifest = registry.get(_pipeline_name(db, r.pipeline_id), {})
            params = json.loads(r.params_json or "{}")
            resolved = resolve_run_artifacts(manifest, r.output_dir or "", params, r.status)
            artifact_count += sum(1 for a in resolved if a.resolved)
        except Exception:
            pass

    # ── Recent runs ──────────────────────────────────────────────────────────
    recent_runs = sorted(runs, key=lambda r: r.created_at, reverse=True)[:10]

    return {
        "dataset": dataset,
        "run_counts": {
            "total": total,
            "success": success_count,
            "failed": counts.get("failed", 0),
            "running": counts.get("running", 0),
            "pending": counts.get("pending", 0),
            "success_rate": success_rate,
        },
        "run_stats": {
            "most_recent_run_id": most_recent.id if most_recent else None,
            "most_recent_run_status": most_recent.status if most_recent else None,
            "most_recent_pipeline": _pipeline_name(db, most_recent.pipeline_id) if most_recent else None,
            "most_recent_finished_at": most_recent.finished_at.isoformat() if most_recent and most_recent.finished_at else None,
            "most_common_pipeline": most_common_pipeline,
            "pipeline_run_counts": dict(pipeline_counter),
        },
        "runtime_stats": {
            "total_seconds": total_compute,
            "median_seconds": median_runtime,
            "slowest_run_id": slowest.id if slowest else None,
            "slowest_run_seconds": _runtime_seconds(slowest) if slowest else None,
            "fastest_run_id": fastest.id if fastest else None,
            "fastest_run_seconds": _runtime_seconds(fastest) if fastest else None,
            "by_pipeline": runtime_by_pipeline,
        },
        "storage": {
            "total_bytes": total_bytes,
            "by_pipeline": storage_by_pipeline,
            "artifact_count": artifact_count,
            "largest_run_id": largest_run_id,
            "largest_run_bytes": largest_run_bytes,
        },
        "recent_runs": [
            {
                "id": r.id,
                "pipeline_manifest_id": _pipeline_name(db, r.pipeline_id),
                "pipeline_version": r.pipeline_version,
                "dataset_id": r.dataset_id,
                "status": r.status,
                "source_run_id": r.source_run_id,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                "created_at": r.created_at.isoformat(),
            }
            for r in recent_runs
        ],
    }


# ── Artifacts endpoint ────────────────────────────────────────────────────────

@router.get("/{dataset_id}/artifacts")
def list_dataset_artifacts(
    dataset_id: int,
    svc: DatasetService = Depends(_svc),
    db: Session = Depends(get_db),
) -> list[dict]:
    """Flat list of all resolved artifacts for every successful run in a dataset."""
    try:
        svc.get_by_id(dataset_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))

    runs: list[Run] = (
        db.query(Run)
        .filter(Run.dataset_id == dataset_id, Run.status == "success")
        .all()
    )
    registry = get_registry()
    result: list[dict] = []

    for r in runs:
        if not r.output_dir:
            continue
        try:
            manifest = registry.get(_pipeline_name(db, r.pipeline_id), {})
            params = json.loads(r.params_json or "{}")
            artifacts = resolve_run_artifacts(manifest, r.output_dir or "", params, r.status)
        except Exception as exc:
            log.warning("Artifact resolution failed for run %d: %s", r.id, exc)
            continue

        for a in artifacts:
            if not a.resolved:
                continue
            for path_str in a.paths:
                p = Path(path_str)
                is_dir = p.is_dir()
                try:
                    size_bytes = _dir_size_bytes(p) if is_dir else p.stat().st_size
                except OSError:
                    size_bytes = 0

                atlas_metadata = None
                if a.type.startswith("connectivity_") or a.type == "timeseries_tsv":
                    meta_path = Path(r.output_dir) / "connectivity_metadata.json"
                    if meta_path.is_file():
                        try:
                            meta = json.loads(meta_path.read_text())
                            atlas_metadata = {
                                "atlas_id": meta.get("atlas_id"),
                                "atlas": meta.get("atlas")
                                or meta.get("atlas_display_name"),
                                "n_rois": meta.get("n_rois")
                                or meta.get("roi_count"),
                                "matrix_shape": meta.get("matrix_shape"),
                                "correlation_method": meta.get("correlation_method"),
                            }
                        except Exception:
                            atlas_metadata = None

                result.append({
                    "run_id": r.id,
                    "pipeline_id": _pipeline_name(db, r.pipeline_id),
                    "pipeline_version": r.pipeline_version,
                    "run_status": r.status,
                    "run_started_at": r.started_at.isoformat() if r.started_at else None,
                    "run_finished_at": r.finished_at.isoformat() if r.finished_at else None,
                    "source_run_id": r.source_run_id,
                    "type": a.type,
                    "label": a.label,
                    "description": a.description,
                    "resolution_source": a.resolution_source,
                    "multiple": a.multiple,
                    "path": path_str,
                    "is_directory": is_dir,
                    "size_bytes": size_bytes,
                    "output_dir": r.output_dir,
                    "atlas_metadata": atlas_metadata,
                })

    # Sort newest run first
    result.sort(key=lambda x: x.get("run_finished_at") or "", reverse=True)
    return result
