"""RunService and pipeline DB seeding.

RunService handles run creation and lookup. The heavy lifting (Docker execution,
log streaming, provenance writing) happens in _execute_run_background(), which
opens its own DB session so it outlives the HTTP request that created the run.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from time import monotonic
from typing import Any

from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.execution.progress_parser import parse_tqdm_line
from app.execution.docker_executor import (
    DockerExecutor,
    _is_running_in_docker,
    from_host_path,
    to_host_path,  # compatibility import for existing test/mocking integrations
    translate_errors,
)
from app.execution.native_executor import NativeExecutor
from app.execution.executor import Executor, RunContext
from app.models.dataset import Dataset
from app.models.pipeline import Pipeline
from app.models.run import ProvenanceEvent, Run, RunLog
from app.schemas.run import ResourceWarningSchema, RunCreate, RunRead, RunSummary
from app.services.dataset_paths import (
    dataset_translation_configured,
    try_resolve_dataset_path,
)
from app.services.pipeline import get_registry

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# In-memory pub/sub for live log streaming (one process, single worker)        #
# --------------------------------------------------------------------------- #

# run_id → ordered list of log lines captured so far (for replay on late connect)
_log_buffers: dict[int, list[str]] = {}

# run_id → set of asyncio.Queue objects (one per connected WebSocket client)
_subscribers: dict[int, set[asyncio.Queue]] = {}


def subscribe(run_id: int) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.setdefault(run_id, set()).add(q)
    return q


def unsubscribe(run_id: int, q: asyncio.Queue) -> None:
    bucket = _subscribers.get(run_id, set())
    bucket.discard(q)
    if not bucket:
        _subscribers.pop(run_id, None)


def _log_file(run_id: int) -> Path:
    return Path(settings.data_dir) / "logs" / f"{run_id}.log"


def get_log_buffer(run_id: int) -> list[str]:
    return list(_log_buffers.get(run_id, []))


def get_log_history(run_id: int) -> list[str]:
    """In-memory buffer for the current process; falls back to the partial
    log file so page refreshes mid-run (or after a backend restart) still
    show everything written so far."""
    if run_id in _log_buffers:
        return list(_log_buffers[run_id])
    p = _log_file(run_id)
    if p.exists():
        try:
            return [l for l in p.read_text(encoding="utf-8").splitlines() if l]
        except OSError:
            pass
    return []


def _broadcast(run_id: int, line: str) -> None:
    """Called in the event-loop thread (via call_soon_threadsafe)."""
    _log_buffers.setdefault(run_id, []).append(line)
    for q in _subscribers.get(run_id, set()):
        q.put_nowait(line)


# --------------------------------------------------------------------------- #
# Progress tracking state (module-level, single-process)                       #
# --------------------------------------------------------------------------- #

_progress_state: dict[int, dict] = {}
_progress_last_write: dict[int, float] = {}
PROGRESS_WRITE_INTERVAL_S = 10  # write to DB at most once per 10s per run


def _write_progress_to_db(run_id: int, progress: dict) -> None:
    try:
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            if run:
                run.progress_json = json.dumps(progress)
                db.commit()
    except Exception as exc:
        log.debug("Progress DB write failed for run %d: %s", run_id, exc)


def _broadcast_progress(run_id: int, progress: dict) -> None:
    """Called in the event-loop thread (via call_soon_threadsafe)."""
    msg = {"type": "progress", "data": progress}
    for q in _subscribers.get(run_id, set()):
        q.put_nowait(msg)


def _broadcast_done(run_id: int) -> None:
    """Signal all WebSocket clients that the run has finished."""
    for q in _subscribers.get(run_id, set()):
        q.put_nowait(None)  # None = sentinel: run ended
    # Keep buffer in memory for a while so late-connecting clients see history.
    # Removed by the GC eventually; fine for single-user v1.


# --------------------------------------------------------------------------- #
# Pipeline DB seeding                                                           #
# --------------------------------------------------------------------------- #


async def recover_interrupted_runs(db: Session) -> None:
    """
    Called at startup. Finds any Run rows still marked 'running' from before
    the last process exit, locates their Docker containers by label, and either
    reattaches a monitoring task (container still alive) or marks the run failed
    (container gone).
    """
    import docker as docker_sdk

    try:
        orphans = db.query(Run).filter_by(status="running").all()
    except OperationalError as exc:
        db.rollback()
        log.warning("Skipping interrupted run recovery because the runs table is unavailable: %s", exc)
        return
    if not orphans:
        return

    try:
        client = docker_sdk.from_env()
    except Exception as exc:
        log.warning("Docker unavailable during recovery — marking orphaned runs interrupted: %s", exc)
        for run in orphans:
            run.status = "interrupted"
            run.finished_at = datetime.now(UTC)
            run.error_message = (
                "Run monitoring was lost due to a server restart and Docker is unavailable. "
                "Use Retry to re-run with the same parameters."
            )
        db.commit()
        return

    for run in orphans:
        # Try label first (containers started after the label feature was added)
        containers = client.containers.list(
            filters={"label": f"neuroforge_run_id={run.id}"}
        )

        # Fall back: match by /out volume binding (pre-label containers)
        if not containers and run.output_dir:
            from app.execution.docker_executor import to_host_path
            host_out = to_host_path(run.output_dir)
            for c in client.containers.list():
                for m in c.attrs.get("Mounts", []):
                    if m.get("Destination") == "/out" and m.get("Source") == host_out:
                        containers = [c]
                        break
                if containers:
                    break

        if containers:
            log.info("Reattaching monitoring for run %d (container %s)", run.id, containers[0].short_id)
            run.status = "running"
            run.error_message = None
            db.commit()
            asyncio.create_task(_reattach_run(run.id, containers[0].id))
        else:
            log.info("No container found for orphaned run %d — marking interrupted", run.id)
            run.status = "interrupted"
            run.finished_at = datetime.now(UTC)
            run.error_message = (
                "Run monitoring was interrupted by a server restart. "
                "The container is no longer running. "
                "Use Retry to re-run with the same parameters."
            )
    db.commit()


async def recover_queued_runs(db: Session) -> None:
    """Called at startup. Finds Run rows still marked 'queued' from before the
    last process exit and re-adds them to the in-memory execution queue so
    pending work survives a backend restart. Preserves created_at ordering."""
    from app.services.execution_queue import enqueue

    try:
        queued = db.query(Run).filter_by(status="queued").order_by(Run.created_at).all()
    except OperationalError as exc:
        log.warning("Skipping queued run recovery: %s", exc)
        return

    if not queued:
        return

    registry = get_registry()
    recovered = 0

    for run in queued:
        try:
            pipeline_row = db.get(Pipeline, run.pipeline_id)
            if not pipeline_row:
                log.warning("Queued run %d: pipeline id %d not found — skipping", run.id, run.pipeline_id)
                continue

            manifest = registry.get(pipeline_row.name)
            if manifest is None:
                log.warning("Queued run %d: manifest '%s' not in registry — skipping", run.id, pipeline_row.name)
                continue

            dataset = db.get(Dataset, run.dataset_id)
            if not dataset:
                log.warning("Queued run %d: dataset %d not found — skipping", run.id, run.dataset_id)
                continue

            params = json.loads(run.params_json or "{}")

            remote_host_cfg: dict | None = None
            if run.remote_host_id is not None:
                from app.models.remote_host import RemoteHost
                rh = db.get(RemoteHost, run.remote_host_id)
                if rh and rh.enabled:
                    remote_host_cfg = {
                        "hostname": rh.hostname,
                        "ssh_port": rh.ssh_port,
                        "username": rh.username,
                        "key_path": rh.key_path,
                        "remote_work_root": rh.remote_work_root,
                        "docker_host": rh.docker_host,
                    }

            output_dir = run.output_dir or str(
                Path(settings.data_dir).resolve() / "derivatives" / pipeline_row.name / str(run.id)
            )

            ctx = RunContext(
                run_id=run.id,
                manifest=manifest,
                params=params,
                dataset_path=dataset.path,
                output_dir=output_dir,
                remote_host_cfg=remote_host_cfg,
            )

            enqueue(run.id, ctx)
            recovered += 1
            log.info("Startup: re-queued run %d (%s)", run.id, pipeline_row.name)

        except Exception:
            log.exception("Failed to recover queued run %d", run.id)

    if recovered:
        log.info("Startup: recovered %d queued run(s) into execution queue", recovered)


async def _reattach_run(run_id: int, container_id: str) -> None:
    """
    Resume monitoring a container that outlived the previous backend process.
    Streams new log output (tail=0 skips lines already in the log file),
    waits for the container to exit, then updates the DB exactly as
    _execute_run_background would.
    """
    import docker as docker_sdk

    loop = asyncio.get_event_loop()

    def _log(line: str) -> None:
        loop.call_soon_threadsafe(_broadcast, run_id, line)

    # Seed the in-memory buffer from the partial log file so WebSocket
    # clients that connect before new lines arrive still see history.
    p = _log_file(run_id)
    if p.exists():
        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                if line:
                    _log_buffers.setdefault(run_id, []).append(line)
        except OSError:
            pass

    # Open log file in append mode — new lines are flushed incrementally
    # so another restart can replay them via get_log_history().
    _reattach_fh = open(p, "a", encoding="utf-8")  # noqa: SIM115

    new_lines: list[str] = []

    def _monitor_sync() -> int:
        client = docker_sdk.from_env()
        try:
            container = client.containers.get(container_id)
        except Exception:
            return 1

        # tail=0: only new output from this point forward (past lines already
        # in the log file are re-seeded into _log_buffers above)
        try:
            for chunk in container.logs(stream=True, follow=True, tail=0):
                for line in chunk.decode("utf-8", errors="replace").splitlines():
                    stripped = line.rstrip()
                    if stripped:
                        try:
                            _reattach_fh.write(stripped + "\n")
                            _reattach_fh.flush()
                        except OSError:
                            pass
                        new_lines.append(stripped)
                        loop.call_soon_threadsafe(_broadcast, run_id, stripped)
        except Exception:
            pass

        result = container.wait()
        exit_code = result.get("StatusCode", 1)
        try:
            container.remove()
        except Exception:
            pass
        return exit_code

    exit_code = await loop.run_in_executor(None, _monitor_sync)

    try:
        _reattach_fh.close()
    except OSError:
        pass

    # Fetch manifest for error translation
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        pipeline = db.get(Pipeline, run.pipeline_id) if run else None

    known_errors: list[dict] = []
    if pipeline:
        registry = get_registry()
        manifest = registry.get(pipeline.name, {})
        known_errors = manifest.get("known_errors", [])

    full_log = "\n".join(list(_log_buffers.get(run_id, [])) + new_lines)
    translated_error: str | None = None
    if exit_code != 0:
        translated_error = translate_errors(full_log, known_errors)
        if not translated_error:
            translated_error = (
                f"The pipeline exited with a non-zero status (code {exit_code}). "
                "Check the log output above for details."
            )

    with SessionLocal() as db:
        run = db.get(Run, run_id)
        if run:
            run.status = "success" if exit_code == 0 else "failed"
            run.finished_at = datetime.now(UTC)
            if translated_error:
                run.error_message = translated_error
            db.commit()

    loop.call_soon_threadsafe(_broadcast_done, run_id)


def seed_pipeline_registry(db: Session) -> None:
    """
    Upsert every loaded manifest into the pipelines DB table.
    Called once at startup so runs.pipeline_id FK is always satisfiable.
    """
    registry = get_registry()
    for manifest_id, manifest in registry.items():
        c = manifest.get("container") or {}
        tag = c.get("tag") or manifest.get("execution", {}).get("command", "native")
        existing = db.query(Pipeline).filter_by(name=manifest_id).first()
        if existing:
            existing.version = tag
            existing.manifest_path = f"{manifest_id}.yaml"
        else:
            db.add(Pipeline(
                name=manifest_id,
                version=tag,
                manifest_path=f"{manifest_id}.yaml",
            ))
    db.commit()


# --------------------------------------------------------------------------- #
# Background execution                                                          #
# --------------------------------------------------------------------------- #


def _get_executor(manifest: dict, remote_host_cfg: dict | None = None) -> Executor:
    """Return the appropriate Executor for the manifest's execution type."""
    if remote_host_cfg:
        from app.execution.ssh_executor import SSHExecutor
        return SSHExecutor(remote_host_cfg)
    exec_type = manifest.get("execution", {}).get("type", "docker")
    if exec_type == "native":
        return NativeExecutor()
    return DockerExecutor()


def _lineage_seed_source(
    manifest: dict[str, Any],
    lineage: Any | None,
) -> Path | None:
    """Return a host/backend-accessible lineage artifact path for output seeding.

    Some official tools, notably MRIQC's group mode, expect their output
    directory to already contain participant-level derivatives. NeuroForge keeps
    each run isolated by copying that upstream artifact into this run's fresh
    output_dir before launch.
    """
    required_type = manifest.get("seed_output_from_lineage_artifact_type")
    if not required_type:
        return None
    if lineage is None:
        raise ValueError(
            f"{manifest['display_name']} must be launched from a completed run "
            f"that produced {required_type}."
        )
    if lineage.artifact_type != required_type:
        raise ValueError(
            f"{manifest['display_name']} requires a {required_type} artifact, "
            f"but received {lineage.artifact_type}."
        )
    if not lineage.injected_path:
        raise ValueError(
            f"{manifest['display_name']} requires a resolved upstream artifact path."
        )

    raw = str(lineage.injected_path)
    candidates = [Path(raw), Path(from_host_path(raw))]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise ValueError(
        f"{manifest['display_name']} could not access upstream artifact path: {raw}"
    )


def _seed_output_from_lineage(source: Path | None, output_dir: Path) -> None:
    if source is None:
        return
    if source.is_dir():
        shutil.copytree(source, output_dir, dirs_exist_ok=True)
        return
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, output_dir / source.name)


def _read_declared_output_log(ctx: RunContext) -> list[str]:
    """Read a safely scoped ``/out`` file when a tool emits no stdout."""
    raw_outfile = str(ctx.params.get("outfile") or "").strip()
    if not raw_outfile:
        return []
    container_path = PurePosixPath(raw_outfile)
    try:
        relative = container_path.relative_to(PurePosixPath("/out"))
    except ValueError:
        return []
    if relative == PurePosixPath(".") or ".." in relative.parts:
        return []

    output_root = Path(ctx.output_dir).resolve()
    report_path = (output_root / Path(*relative.parts)).resolve()
    try:
        report_path.relative_to(output_root)
    except ValueError:
        return []
    if not report_path.is_file():
        return []
    try:
        return report_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


async def _execute_run_background(run_id: int, ctx: RunContext) -> None:
    """
    Runs the pipeline in the background. Opens its own DB session
    so it can outlive the HTTP request that created the run record.
    """
    executor = _get_executor(ctx.manifest, ctx.remote_host_cfg)
    loop = asyncio.get_event_loop()

    def _log(line: str) -> None:
        loop.call_soon_threadsafe(_broadcast, run_id, line)

    # Open the log file early so every line is flushed incrementally.
    # This lets page-refreshes (and post-restart reconnects) read partial
    # logs via get_log_history() even while the run is still in progress.
    lf_path = _log_file(run_id)
    lf_path.parent.mkdir(parents=True, exist_ok=True)
    _log_fh = open(lf_path, "w", encoding="utf-8")  # noqa: SIM115

    log_lines: list[str] = []

    def _log_and_collect(line: str) -> None:
        log_lines.append(line)
        try:
            _log_fh.write(line + "\n")
            _log_fh.flush()
        except OSError:
            pass
        _log(line)

        # Progress parsing
        parsed = parse_tqdm_line(line)
        if parsed:
            progress_dict = {
                "percent": parsed.percent,
                "current": parsed.current,
                "total": parsed.total,
                "elapsed_seconds": parsed.elapsed_seconds,
                "eta_seconds": parsed.eta_seconds,
                "rate": parsed.rate,
                "rate_unit": parsed.rate_unit,
                "last_updated": parsed.last_updated,
            }
            _progress_state[run_id] = progress_dict
            loop.call_soon_threadsafe(_broadcast_progress, run_id, progress_dict)
            now = monotonic()
            if now - _progress_last_write.get(run_id, 0) > PROGRESS_WRITE_INTERVAL_S:
                _progress_last_write[run_id] = now
                _write_progress_to_db(run_id, progress_dict)

    with SessionLocal() as db:
        run = db.get(Run, run_id)
        if not run:
            return

        # Update status → running
        run.status = "running"
        run.started_at = datetime.now(UTC)
        db.commit()

        # Write provenance: execution started
        db.add(ProvenanceEvent(
            run_id=run_id,
            event_type="execution_started",
            payload_json=json.dumps({
                "container_image": (
                    f"{ctx.manifest['container']['image']}:{ctx.manifest['container']['tag']}"
                    if ctx.manifest.get("container") else
                    f"native:{ctx.manifest.get('execution', {}).get('command', 'unknown')}"
                ),
                "command": executor.build_command(ctx),
                "output_dir": ctx.output_dir,
            }),
        ))
        db.commit()

    exit_code = 1
    digest: str | None = None

    try:
        exit_code, digest = await executor.run(ctx, _log_and_collect)
    except Exception as exc:
        log.exception("Executor raised during run %d", run_id)
        _log_and_collect(f"[neuroforge] Executor error: {exc}")

    # Some tools write exclusively to an explicitly declared /out file. Keep
    # their report available in the execution log without duplicating stdout.
    if not log_lines:
        for line in _read_declared_output_log(ctx):
            _log_and_collect(line)

    # Close the incrementally-written log file.
    log_file_path: str | None = str(lf_path)
    try:
        _log_fh.close()
    except OSError:
        pass

    # Error translation
    full_log_text = "\n".join(log_lines)
    known_errors = ctx.manifest.get("known_errors", [])
    translated_error: str | None = None
    if exit_code != 0:
        translated_error = translate_errors(full_log_text, known_errors)
        if not translated_error:
            translated_error = (
                f"The pipeline exited with a non-zero status (code {exit_code}). "
                "Check the log output above for details. "
                "Common causes: the dataset contains empty or corrupt NIfTI files, "
                "a required BIDS field is missing, or the container ran out of memory."
            )

    # Detect matched error signatures for run_logs record
    import re
    matched_signatures: list[str] = []
    for entry in known_errors:
        pattern = entry.get("pattern", "")
        if pattern:
            try:
                if re.search(pattern, full_log_text, re.IGNORECASE | re.MULTILINE):
                    matched_signatures.append(pattern)
            except re.error:
                pass

    with SessionLocal() as db:
        run = db.get(Run, run_id)
        if run:
            if run.cancel_requested:
                run.status = "cancelled"
                run.error_message = "Run was cancelled by user request."
            else:
                run.status = "success" if exit_code == 0 else "failed"
                if translated_error:
                    run.error_message = translated_error
            run.finished_at = datetime.now(UTC)
            run.container_digest = digest
            # Persist final progress snapshot if any was collected
            final_progress = _progress_state.get(run_id)
            if final_progress:
                run.progress_json = json.dumps(final_progress)
            db.commit()

            # RunLog record
            db.add(RunLog(
                run_id=run_id,
                log_file_path=log_file_path,
                error_signatures_detected=json.dumps(matched_signatures) if matched_signatures else None,
            ))

            # Provenance: execution finished
            db.add(ProvenanceEvent(
                run_id=run_id,
                event_type="execution_finished",
                payload_json=json.dumps({
                    "exit_code": exit_code,
                    "container_digest": digest,
                    "status": run.status,
                    "error_matched": bool(translated_error),
                }),
            ))
            db.commit()

            # Auto-register dcm2bids output as a NeuroForge Dataset so MRIQC
            # and fMRIPrep can pick it up via the dataset selector immediately.
            if exit_code == 0 and ctx.manifest.get("id") == "dcm2bids" and run.output_dir:
                _auto_register_dcm2bids_output(run_id, run.output_dir, ctx.params, db)

    loop.call_soon_threadsafe(_broadcast_done, run_id)


_run_logger = logging.getLogger(__name__)


def _auto_register_dcm2bids_output(
    run_id: int, output_dir: str, params: dict[str, Any], db: Session
) -> None:
    """Register the dcm2bids output directory as a NeuroForge Dataset.

    Idempotent: if a dataset with the same path already exists (e.g. run was
    reprocessed), update its name and source_run_id rather than creating a
    duplicate. Any error is logged and swallowed so it never breaks the run.
    """
    import json as _json
    from pathlib import Path as _Path
    from app.models.dataset import Dataset as _Dataset
    from app.services.dataset import DatasetService as _DatasetService
    from app.schemas.dataset import DatasetCreate as _DatasetCreate

    participant = str(params.get("participant-label", "")).strip()
    name = (
        f"dcm2bids run {run_id} — {participant}"
        if participant
        else f"dcm2bids run {run_id}"
    )

    try:
        resolved = str(_Path(output_dir).resolve())
        existing = db.query(_Dataset).filter(_Dataset.path == resolved).first()

        if existing is None:
            svc = _DatasetService(db)
            result = svc.register(_DatasetCreate(path=output_dir))
            dataset = db.get(_Dataset, result.id)
        else:
            dataset = existing

        if dataset is None:
            return

        dataset.name = name

        try:
            meta = _json.loads(dataset.indexed_metadata or "{}")
        except Exception:
            meta = {}
        meta["source_run_id"] = run_id
        dataset.indexed_metadata = _json.dumps(meta)

        db.commit()
        _run_logger.info(
            "Auto-registered dcm2bids output as Dataset id=%s name=%r",
            dataset.id, name,
        )
    except Exception:
        _run_logger.exception(
            "Auto-registration of dcm2bids output failed for run %s", run_id
        )


# --------------------------------------------------------------------------- #
# RunService                                                                    #
# --------------------------------------------------------------------------- #


class RunService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def _get_pipeline_manifest_id(self, pipeline_db_id: int) -> str:
        row = self.db.get(Pipeline, pipeline_db_id)
        return row.name if row else "unknown"

    def _run_to_read(self, run: Run, resource_warnings: list[ResourceWarningSchema] | None = None) -> RunRead:
        params = json.loads(run.params_json or "{}")
        progress = json.loads(run.progress_json) if run.progress_json else None
        return RunRead(
            id=run.id,
            pipeline_manifest_id=self._get_pipeline_manifest_id(run.pipeline_id),
            pipeline_version=run.pipeline_version,
            dataset_id=run.dataset_id,
            status=run.status,
            source_run_id=run.source_run_id,
            remote_host_id=run.remote_host_id,
            params=params,
            command_preview=run.command_preview,
            output_dir=run.output_dir,
            error_message=run.error_message,
            started_at=run.started_at,
            finished_at=run.finished_at,
            created_at=run.created_at,
            resource_warnings=resource_warnings or [],
            progress=progress,
        )

    def create_run(
        self,
        body: RunCreate,
    ) -> RunRead:
        # Resolve manifest
        registry = get_registry()
        manifest = registry.get(body.pipeline_id)
        if not manifest:
            raise ValueError(f"Unknown pipeline: '{body.pipeline_id}'")

        # Resolve dataset
        dataset = self.db.get(Dataset, body.dataset_id)
        if not dataset:
            raise ValueError(f"Dataset {body.dataset_id} not found")

        # Resolve pipeline DB record (seeded at startup)
        pipeline_row = self.db.query(Pipeline).filter_by(name=body.pipeline_id).first()
        if not pipeline_row:
            raise ValueError(f"Pipeline '{body.pipeline_id}' not in DB registry. Is the manifest loaded?")

        # Pre-flight: validate required file_path/directory_path params that
        # need a mount exist on disk NOW, before we create a DB record or touch
        # Docker. Failing here produces a clear 400 error; failing inside the
        # container produces a cryptic startup error after a cold-pull delay.
        for p in manifest.get("parameters", []):
            if not p.get("mount"):
                continue
            name = p["name"]
            val = str(body.params.get(name) or "").strip()
            if not val:
                if p.get("required"):
                    raise ValueError(
                        f"Parameter '{name}' is required for {manifest['display_name']}."
                    )
                continue  # optional mounted param with no value — skip
            candidate_value = val
            if not Path(candidate_value).is_absolute():
                candidate_value = str(Path(dataset.path) / candidate_value)
            resolved_dataset_path = (
                try_resolve_dataset_path(candidate_value)
                if dataset_translation_configured()
                else None
            )
            # Existence is checked only in the backend namespace. The Docker
            # daemon receives the equivalent host path later, when the bind is
            # constructed by DockerExecutor.
            candidate: Path | None = (
                resolved_dataset_path.backend
                if resolved_dataset_path is not None
                else None
            )
            if candidate is None and not _is_running_in_docker():
                # When not in Docker, the backend can access the raw path directly.
                # Inside Docker, paths outside the dataset mounts (e.g. a FreeSurfer
                # license file on the host) are invisible to the backend container —
                # defer to the executor, which passes the path to the Docker daemon.
                candidate = Path(candidate_value).expanduser().resolve()
            expected_directory = p.get("type") == "directory_path"
            if candidate is None:
                available = True
            elif expected_directory:
                available = candidate.is_dir()
            else:
                available = candidate.is_file()
            if not available:
                raise ValueError(
                    f"Parameter '{name}': path not found: '{val}'. "
                    "Check that the file exists and the path is correct."
                )

        # Auto-persist work directory for long-running pipelines.
        #
        # When max_runtime_hours > 4 and the user hasn't set work-dir explicitly,
        # we create data/work/{pipeline_id}/{dataset_id}/ and inject it into the
        # effective params. This directory is shared across all runs of the same
        # pipeline against the same dataset, so nipype's hash-based node cache
        # survives container restarts and makes retries resume from the last
        # completed node rather than restarting from scratch.
        #
        # Nipype hashes every node's complete input state (file paths + param
        # values + mtime/size of large files). A retry with different params
        # (e.g. a different --run-id) will correctly recompute affected nodes
        # while reusing nodes whose inputs are unchanged (e.g. anat steps that
        # don't depend on which BOLD runs are selected). Stale-cache risk is
        # only possible if a file on disk is silently modified without changing
        # its mtime — not a realistic concern in normal use.
        effective_params = dict(body.params)
        if (
            not effective_params.get("work-dir")
            and manifest.get("max_runtime_hours", 0) > 4
        ):
            work_dir = (
                Path(settings.data_dir).resolve()
                / "work"
                / body.pipeline_id
                / str(body.dataset_id)
            )
            work_dir.mkdir(parents=True, exist_ok=True)
            effective_params["work-dir"] = str(work_dir)
            log.info(
                "Auto-mounting persistent work-dir for pipeline %s / dataset %d: %s",
                body.pipeline_id, body.dataset_id, work_dir,
            )

        # For group-functional-connectivity: resolve input-run-ids to matrix-dirs
        # before the executor sees the params. Each run ID is looked up in the DB
        # and its output_dir is appended to a comma-separated list injected as
        # matrix-dirs. This keeps the NativeExecutor generic.
        if (
            body.pipeline_id == "group-functional-connectivity"
            and effective_params.get("input-run-ids")
        ):
            raw_ids = str(effective_params["input-run-ids"])
            resolved_dirs: list[str] = []
            for part in raw_ids.split(","):
                part = part.strip()
                if not part:
                    continue
                try:
                    rid = int(part)
                except ValueError:
                    raise ValueError(f"input-run-ids contains non-integer value: '{part}'")
                src_run = self.db.get(Run, rid)
                if src_run is None:
                    raise ValueError(f"Run {rid} not found (from input-run-ids)")
                if not src_run.output_dir:
                    raise ValueError(f"Run {rid} has no output directory — did it succeed?")
                resolved_dirs.append(src_run.output_dir)
            if not resolved_dirs:
                raise ValueError("input-run-ids produced no resolvable run directories")
            effective_params["matrix-dirs"] = ",".join(resolved_dirs)
            log.info(
                "group-functional-connectivity: resolved %d input runs → matrix-dirs",
                len(resolved_dirs),
            )

        # Validate source_run_id if lineage was provided
        if body.lineage and not body.lineage.external:
            src = self.db.get(Run, body.lineage.upstream_run_id)
            if src is None:
                raise ValueError(f"Source run {body.lineage.upstream_run_id} not found")

        lineage_seed_source = _lineage_seed_source(manifest, body.lineage)

        # Resolve remote host config when caller requested remote execution
        remote_host_cfg: dict | None = None
        if body.remote_host_id is not None:
            from app.models.remote_host import RemoteHost
            rh = self.db.get(RemoteHost, body.remote_host_id)
            if not rh:
                raise ValueError(f"Remote host {body.remote_host_id} not found")
            if not rh.enabled:
                raise ValueError(f"Remote host '{rh.display_name}' is disabled")
            remote_host_cfg = {
                "hostname": rh.hostname,
                "ssh_port": rh.ssh_port,
                "username": rh.username,
                "key_path": rh.key_path,
                "remote_work_root": rh.remote_work_root,
                "docker_host": rh.docker_host,
            }

        # Create the DB record. params_json records effective_params (including
        # the auto-injected work-dir) so the provenance record is accurate.
        run = Run(
            dataset_id=body.dataset_id,
            pipeline_id=pipeline_row.id,
            pipeline_version=(manifest.get("container") or {}).get("tag") or manifest.get("execution", {}).get("command", "native"),
            params_json=json.dumps(effective_params),
            status="queued",
            source_run_id=body.lineage.upstream_run_id if body.lineage and not body.lineage.external else None,
            source_artifacts_json=json.dumps(body.lineage.model_dump()) if body.lineage else None,
            remote_host_id=body.remote_host_id,
        )
        self.db.add(run)
        self.db.commit()
        self.db.refresh(run)

        # Output directory: ./data/derivatives/{pipeline_id}/{run_id}/
        output_dir = (
            Path(settings.data_dir).resolve()
            / "derivatives"
            / body.pipeline_id
            / str(run.id)
        )
        output_dir.mkdir(parents=True, exist_ok=True)
        try:
            _seed_output_from_lineage(lineage_seed_source, output_dir)
        except Exception as exc:
            run.status = "failed"
            run.error_message = (
                f"Could not prepare upstream artifact for {manifest['display_name']}: {exc}"
            )
            self.db.commit()
            raise ValueError(run.error_message) from exc

        # Build the execution context
        ctx = RunContext(
            run_id=run.id,
            manifest=manifest,
            params=effective_params,
            dataset_path=dataset.path,
            output_dir=str(output_dir),
            remote_host_cfg=remote_host_cfg,
        )

        # Resource pre-check (warnings only — never block the run)
        executor = _get_executor(manifest, remote_host_cfg)
        raw_warnings = executor.check_resources(ctx)
        resource_warnings = [
            ResourceWarningSchema(level=w.level, message=w.message)
            for w in raw_warnings
        ]

        # Build and store command preview
        command_preview = " ".join(executor.build_command(ctx))
        run.command_preview = command_preview
        run.output_dir = str(output_dir)
        self.db.commit()

        # Provenance: run created
        self.db.add(ProvenanceEvent(
            run_id=run.id,
            event_type="run_created",
            payload_json=json.dumps({
                "pipeline_id": body.pipeline_id,
                "pipeline_version": (manifest.get("container") or {}).get("tag") or manifest.get("execution", {}).get("command"),
                "container_image": (
                    f"{manifest['container']['image']}:{manifest['container']['tag']}"
                    if manifest.get("container") else
                    f"native:{manifest.get('execution', {}).get('command', 'unknown')}"
                ),
                "dataset_id": body.dataset_id,
                "dataset_path": dataset.path,
                "dataset_hash": dataset.dataset_hash,
                "params": effective_params,
                "command_preview": command_preview,
            }),
        ))
        self.db.commit()

        # Enqueue for sequential execution
        from app.services.execution_queue import enqueue
        enqueue(run.id, ctx)

        return self._run_to_read(run, resource_warnings)

    def list_all(self) -> list[RunSummary]:
        runs = self.db.query(Run).order_by(Run.created_at.desc()).all()
        return [
            RunSummary(
                id=r.id,
                pipeline_manifest_id=self._get_pipeline_manifest_id(r.pipeline_id),
                pipeline_version=r.pipeline_version,
                dataset_id=r.dataset_id,
                status=r.status,
                source_run_id=r.source_run_id,
                remote_host_id=r.remote_host_id,
                started_at=r.started_at,
                finished_at=r.finished_at,
                created_at=r.created_at,
            )
            for r in runs
        ]

    def get_by_id(self, run_id: int) -> RunRead:
        run = self.db.get(Run, run_id)
        if not run:
            raise KeyError(run_id)
        return self._run_to_read(run)

    def rerun(self, source_run_id: int) -> RunRead:
        """Create a new run with the same pipeline, dataset, and params as source_run_id."""
        from app.models.pipeline import Pipeline as PipelineModel
        source = self.db.get(Run, source_run_id)
        if not source:
            raise KeyError(source_run_id)
        terminal = {"success", "failed", "cancelled", "interrupted"}
        if source.status not in terminal:
            raise ValueError(
                f"Can only retry/re-run a finished run (status is '{source.status}')."
            )
        pipeline_row = self.db.get(PipelineModel, source.pipeline_id)
        if not pipeline_row:
            raise ValueError("Pipeline not found for the source run.")
        params = json.loads(source.params_json or "{}")
        body = RunCreate(
            pipeline_id=pipeline_row.name,
            dataset_id=source.dataset_id,
            params=params,
        )
        return self.create_run(body)

    def delete_run(self, run_id: int) -> None:
        """Delete a finished run record from the DB (does not delete output files)."""
        run = self.db.get(Run, run_id)
        if not run:
            raise KeyError(run_id)
        terminal = {"success", "failed", "cancelled", "interrupted"}
        if run.status not in terminal:
            raise ValueError(
                f"Can only delete a finished run (status is '{run.status}')."
            )
        # Cascade: remove associated logs and provenance events
        from app.models.run import RunLog, ProvenanceEvent
        self.db.query(RunLog).filter_by(run_id=run_id).delete()
        self.db.query(ProvenanceEvent).filter_by(run_id=run_id).delete()
        self.db.delete(run)
        self.db.commit()

    def get_log_text(self, run_id: int) -> str | None:
        """Return the full log text from the log file if available."""
        log_entry = self.db.query(RunLog).filter_by(run_id=run_id).first()
        if not log_entry or not log_entry.log_file_path:
            return None
        try:
            return Path(log_entry.log_file_path).read_text(encoding="utf-8")
        except OSError:
            return None
