# Desktop startup-state fix verification

Verified on macOS Apple Silicon on 2026-07-14 with the exact unsigned bundle at
`desktop/dist/mac-arm64/Neuravian.app`.

## Root cause

The visible launcher shell depended on a transient main-to-renderer Ready event.
If the event preceded renderer listener registration, the renderer had no query
or replay path and could remain on its static initial “Checking system” state.
The launcher also treated occupied ports as a fatal preflight conflict before it
could recognize an already-healthy Neuravian stack, so it had no valid warm
attach path or external-ownership state.

The current desktop source and packaged ASAR already used the canonical backend
health URL, `http://127.0.0.1:8000/api/health`. The observed direct `/health` 404
requests were not emitted by the Electron main-process startup poll and were not
the blocking cause. A focused regression now locks the desktop constant to
`/api/health` and rejects a trailing bare `/health` URL.

The main process now stores every startup state before emitting it. The renderer
subscribes for future updates, queries the current state on load, and acknowledges
Ready before the main process swaps the startup shell for the application URL.
Startup attempts have IDs, stale updates are rejected, repeated run/Retry calls
share the same promise, and Compose ownership is explicit (`owned`, `external`,
or `none`).

## Instrumentation and timeouts

`~/Library/Logs/Neuravian/startup.log` records the requested 21 named stages,
ISO timestamps, attempt ID, app version, architecture, endpoints/status, and
elapsed durations. Writes are serialized to preserve transition order and pass
through the desktop diagnostics redactor before persistence.

Central hard limits are:

- system checks: 10 seconds
- Docker daemon: 10 seconds
- Compose start: 30 seconds
- backend health: 60 seconds
- frontend health: 60 seconds
- renderer load and Ready acknowledgement: 30 seconds
- individual health request: 5 seconds

Failures display the failed stage, reason, elapsed time, Retry, Copy diagnostics,
Open logs, and contextual Docker/browser actions. No raw stack trace is shown by
default.

## Packaged-app QA

Warm start used an already-healthy backend and frontend. The bundle detected
HTTP 200 from `/api/health` and port 3000, attached with external ownership,
emitted and received Ready at 649 ms, loaded the application URL at 708 ms, and
confirmed the visible Neuravian UI. It did not invoke Compose. Normal quit left
both existing containers healthy.

Cold start began with both desktop services stopped and an empty run queue. The
bundle invoked Compose once at 662 ms, received backend health at 14.074 seconds,
frontend health at 14.088 seconds, and confirmed the visible UI 114 ms after the
renderer Ready acknowledgement. Normal quit stopped only desktop-owned services
with `compose stop`; it did not remove volumes or data. The canonical stack was
then restored and returned HTTP 200 for both services.

The final warm and cold attempts contained no `renderer error` or `renderer
warning` entries. No refresh or manual interaction was needed, and neither test
showed a blank window.

## Visual evidence

- [Startup shell](screenshots/desktop-startup.png)
- [Successful warm attach](screenshots/startup-fix-warm.png)
- [Successful cold start](screenshots/startup-fix-cold.png)

## Regression coverage

Desktop tests cover the canonical endpoint, bounded retry after a 404, warm
attach, cold Compose startup, backend-before-frontend ordering, late renderer
subscription, Ready replay/query, backend/frontend timeouts, Docker/Compose
failure states, Retry deduplication, listener cleanup, visible failure metadata,
shell-to-app handoff wiring, Compose ownership preservation, ordered persistent
logging, and diagnostics redaction.

This change is confined to the Electron launcher, its startup shell, tests, and
documentation. Scientific pipelines, manifests, executors, reports, artifacts,
backend algorithms, Docker images, and canonical Compose configuration were not
changed.
