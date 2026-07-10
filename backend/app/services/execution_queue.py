"""Lightweight in-process execution queue.

Runs one heavy job at a time. New runs are appended to _queue; the
_processor coroutine drains them sequentially. Cancel requests set
cancel_requested on the DB row; the processor checks this before
dispatching and _execute_run_background checks it before writing the
final status.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Optional

from app.execution.executor import RunContext

log = logging.getLogger(__name__)

# ── Queue state (module-level, single process) ────────────────────────────────

_queue: list[tuple[int, RunContext]] = []
_running_run_id: Optional[int] = None
_processor_started: bool = False


# ── Public helpers ────────────────────────────────────────────────────────────

def enqueue(run_id: int, ctx: RunContext) -> None:
    _queue.append((run_id, ctx))


def remove_from_queue(run_id: int) -> bool:
    """Remove run from the waiting queue. Returns True if it was there."""
    before = len(_queue)
    indices = [i for i, (rid, _) in enumerate(_queue) if rid == run_id]
    for i in reversed(indices):
        _queue.pop(i)
    return len(_queue) < before


def get_queue_status() -> dict:
    return {
        "running_run_id": _running_run_id,
        "queued": [
            {"run_id": rid, "position": i + 1}
            for i, (rid, _) in enumerate(_queue)
        ],
    }


def running_run_id() -> Optional[int]:
    return _running_run_id


# ── Processor ─────────────────────────────────────────────────────────────────

async def _processor() -> None:
    global _running_run_id

    # Deferred imports to avoid circular dependency at module load time
    from app.core.database import SessionLocal
    from app.models.run import ProvenanceEvent, Run
    from app.services.run import _execute_run_background, _broadcast_done

    log.info("Execution queue processor started.")
    while True:
        if not _queue:
            await asyncio.sleep(0.5)
            continue

        run_id, ctx = _queue.pop(0)
        _running_run_id = run_id
        log.info("Queue: starting run %d", run_id)

        # Skip if cancelled while waiting
        with SessionLocal() as db:
            run = db.get(Run, run_id)
            if run and run.cancel_requested:
                run.status = "cancelled"
                run.finished_at = datetime.now(UTC)
                db.add(ProvenanceEvent(
                    run_id=run_id,
                    event_type="run_cancelled",
                    payload_json='{"reason": "cancelled while queued"}',
                ))
                db.commit()
                _running_run_id = None
                _broadcast_done(run_id)
                log.info("Queue: run %d cancelled before execution", run_id)
                continue

        try:
            await _execute_run_background(run_id, ctx)
        except Exception:
            log.exception("Queue processor: unhandled error in run %d", run_id)
        finally:
            _running_run_id = None
            log.info("Queue: run %d finished", run_id)


async def _stalled_checker() -> None:
    """Periodic check: mark 'running' runs as 'interrupted' if the processor
    is idle but the DB still shows them as running (e.g. after an uncaught
    exception in the processor)."""
    from app.core.database import SessionLocal
    from app.models.run import Run
    from app.services.run import _broadcast_done

    while True:
        await asyncio.sleep(120)  # check every 2 minutes
        if _running_run_id is not None:
            continue  # something is actively running — skip

        with SessionLocal() as db:
            orphans = db.query(Run).filter_by(status="running").all()
            if not orphans:
                continue
            for run in orphans:
                if run.id == _running_run_id:
                    continue  # still legitimately running
                log.warning(
                    "Stalled run detected: run %d is 'running' in DB but "
                    "the queue processor is idle — marking interrupted.",
                    run.id,
                )
                run.status = "interrupted"
                run.finished_at = datetime.now(UTC)
                run.error_message = (
                    "Run became stalled (the processor lost track of it). "
                    "Use Retry to re-run with the same parameters."
                )
            db.commit()
        for run in orphans:
            _broadcast_done(run.id)


def start_processor() -> None:
    global _processor_started
    if _processor_started:
        return
    _processor_started = True
    asyncio.create_task(_processor())
    asyncio.create_task(_stalled_checker())
    log.info("Execution queue processor and stalled-run checker started.")
