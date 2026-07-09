"""RunService and pipeline DB seeding.

RunService handles run creation and lookup. The heavy lifting (Docker execution,
log streaming, provenance writing) happens in _execute_run_background(), which
opens its own DB session so it outlives the HTTP request that created the run.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from typing import Any

from fastapi import BackgroundTasks
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.execution.progress_parser import parse_tqdm_line
from app.execution.docker_executor import DockerExecutor, _is_running_in_docker, to_host_path, translate_errors
from app.execution.native_executor import NativeExecutor
from app.execution.executor import Executor, RunContext
from app.models.dataset import Dataset
from app.models.pipeline import Pipeline
from app.models.run import ProvenanceEvent, Run, RunLog
from app.schemas.run import ResourceWarningSchema, RunCreate, RunRead, RunSummary
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

    orphans = db.query(Run).filter_by(status="running").all()
    if not orphans:
        return

    try:
        client = docker_sdk.from_env()
    except Exception as exc:
        log.warning("Docker unavailable during recovery — marking orphaned runs failed: %s", exc)
        for run in orphans:
            run.status = "failed"
            run.finished_at = datetime.now(UTC)
            run.error_message = "Run monitoring was lost due to a server restart and Docker is unavailable."
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
            log.info("No container found for orphaned run %d — marking failed", run.id)
            run.status = "failed"
            run.finished_at = datetime.now(UTC)
            run.error_message = (
                "Run monitoring was interrupted by a server restart. "
                "The container is no longer running — the run may have completed or been stopped."
            )
    db.commit()


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


def _get_executor(manifest: dict) -> Executor:
    """Return the appropriate Executor for the manifest's execution type."""
    exec_type = manifest.get("execution", {}).get("type", "docker")
    if exec_type == "native":
        return NativeExecutor()
    return DockerExecutor()


async def _execute_run_background(run_id: int, ctx: RunContext) -> None:
    """
    Runs the pipeline in the background. Opens its own DB session
    so it can outlive the HTTP request that created the run record.
    """
    executor = _get_executor(ctx.manifest)
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
            run.status = "success" if exit_code == 0 else "failed"
            run.finished_at = datetime.now(UTC)
            run.container_digest = digest
            if translated_error:
                run.error_message = translated_error
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
        background_tasks: BackgroundTasks,
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
            translated = to_host_path(val)
            # Only check existence when the path is reachable from inside the
            # container. to_host_path() returns the input unchanged when no
            # mount covers it (e.g. ~/freesurfer/license.txt when only
            # ~/Documents is mounted). In that case the container can't see the
            # file, but the Docker daemon on the host can — so we skip the check
            # and let Docker fail with "bind source path does not exist" if the
            # path is genuinely wrong.
            #
            # path_is_reachable is True when either:
            #   - to_host_path() translated the path (file is under a known mount), OR
            #   - we're not inside Docker at all (local dev / test environment)
            path_is_reachable = (translated != val) or not _is_running_in_docker()
            if path_is_reachable and not Path(translated).exists():
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

        # Validate source_run_id if lineage was provided
        if body.lineage:
            src = self.db.get(Run, body.lineage.upstream_run_id)
            if src is None:
                raise ValueError(f"Source run {body.lineage.upstream_run_id} not found")

        # Create the DB record. params_json records effective_params (including
        # the auto-injected work-dir) so the provenance record is accurate.
        run = Run(
            dataset_id=body.dataset_id,
            pipeline_id=pipeline_row.id,
            pipeline_version=(manifest.get("container") or {}).get("tag") or manifest.get("execution", {}).get("command", "native"),
            params_json=json.dumps(effective_params),
            status="pending",
            source_run_id=body.lineage.upstream_run_id if body.lineage else None,
            source_artifacts_json=json.dumps(body.lineage.model_dump()) if body.lineage else None,
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

        # Build the execution context
        ctx = RunContext(
            run_id=run.id,
            manifest=manifest,
            params=effective_params,
            dataset_path=dataset.path,
            output_dir=str(output_dir),
        )

        # Resource pre-check (warnings only — never block the run)
        executor = _get_executor(manifest)
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

        # Schedule the actual execution as a background task
        background_tasks.add_task(_execute_run_background, run.id, ctx)

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

    def get_log_text(self, run_id: int) -> str | None:
        """Return the full log text from the log file if available."""
        log_entry = self.db.query(RunLog).filter_by(run_id=run_id).first()
        if not log_entry or not log_entry.log_file_path:
            return None
        try:
            return Path(log_entry.log_file_path).read_text(encoding="utf-8")
        except OSError:
            return None
