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
from typing import Any

from fastapi import BackgroundTasks
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.execution.docker_executor import DockerExecutor, translate_errors
from app.execution.executor import RunContext
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
        tag = manifest["container"]["tag"]
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


async def _execute_run_background(run_id: int, ctx: RunContext) -> None:
    """
    Runs the pipeline container in the background. Opens its own DB session
    so it can outlive the HTTP request that created the run record.
    """
    executor = DockerExecutor()
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
                "container_image": f"{ctx.manifest['container']['image']}:{ctx.manifest['container']['tag']}",
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

    loop.call_soon_threadsafe(_broadcast_done, run_id)


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

        # Create the DB record (no output_dir yet — we need the run_id first)
        run = Run(
            dataset_id=body.dataset_id,
            pipeline_id=pipeline_row.id,
            pipeline_version=manifest["container"]["tag"],
            params_json=json.dumps(body.params),
            status="pending",
        )
        self.db.add(run)
        self.db.commit()
        self.db.refresh(run)

        # Output directory: ./data/derivatives/{pipeline_id}/{run_id}/
        output_dir = Path(settings.data_dir) / "derivatives" / body.pipeline_id / str(run.id)
        output_dir.mkdir(parents=True, exist_ok=True)

        # Build the execution context
        ctx = RunContext(
            run_id=run.id,
            manifest=manifest,
            params=body.params,
            dataset_path=dataset.path,
            output_dir=str(output_dir),
        )

        # Resource pre-check (warnings only — never block the run)
        executor = DockerExecutor()
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
                "pipeline_version": manifest["container"]["tag"],
                "container_image": f"{manifest['container']['image']}:{manifest['container']['tag']}",
                "dataset_id": body.dataset_id,
                "dataset_path": dataset.path,
                "dataset_hash": dataset.dataset_hash,
                "params": body.params,
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
