# NeuroForge local desktop launcher architecture

Status: architecture decision for the macOS prototype  
Date: 2026-07-14

## 1. Problem statement and boundary

The desktop milestone adds a thin, local launcher and native window around the
existing NeuroForge deployment. It does not create another NeuroForge runtime.
The canonical React frontend, FastAPI backend, SQLite database, pipeline
registry, plugins, executors, artifact discovery, provenance, reports, and
output paths remain authoritative.

Two equal installation paths must remain supported:

- Desktop prototype: double-click `NeuroForge.app`; the launcher checks the
  host, starts the canonical Docker Compose services, waits for health, and
  opens `http://127.0.0.1:3000` in its native window.
- Manual/developer mode: run `docker compose up --build` from the repository as
  today. Desktop code is never required by the backend, frontend, CI, pipeline
  execution, plugin development, or server deployment.

The launcher may adapt host binding and Compose project ownership. It must not
adapt scientific behavior, mounts, data locations, or run execution.

## 2. Current deployment audit

### Canonical services and ports

`docker-compose.yml` defines two services:

| Service | Container port | Current published port | Health/readiness |
| --- | ---: | ---: | --- |
| FastAPI backend | 8000 | 8000 | `GET /api/health` returns `{"status":"ok","service":"neuroforge-backend"}` |
| Nginx/React frontend | 3000 | 3000 | HTTP response from `/`; Compose waits for backend health before starting it |

The current short-form port mappings publish on all interfaces. Desktop mode
must instead use an isolated Compose override with the Compose `!override` tag:

```yaml
services:
  backend:
    ports: !override
      - "127.0.0.1:8000:8000"
  frontend:
    ports: !override
      - "127.0.0.1:3000:3000"
```

This keeps the primary Compose file unchanged and authoritative. The launcher
will require a Docker Compose release that supports `!override` (2.24.4 or
newer), validate the effective configuration with `docker compose config`, and
reject any desktop configuration that publishes either service on `0.0.0.0`.
Manual Compose behavior remains unchanged.

### Frontend routing and API behavior

- The frontend uses `BrowserRouter`; all existing routes are normal path-based
  routes.
- Nginx has an SPA fallback to `/index.html`, so refresh and deep links work at
  `127.0.0.1:3000`.
- Production API calls are same-origin under `/api`. Nginx proxies `/api/` and
  WebSocket upgrades to `backend:8000` with a one-hour read timeout.
- Development uses Vite on port 5173 and proxies `/api` to
  `127.0.0.1:8000`.
- `VITE_API_URL` remains optional. Desktop mode does not need to rewrite or
  rebuild the React application with a different API URL.

The native window will allow navigation only to the local NeuroForge origin.
External `http:` and `https:` destinations will be opened through the macOS
default browser. Popups will not create untracked Electron windows.

### Persistence, mounts, and paths

The backend receives the existing mounts without modification:

| Host source | Container destination | Purpose |
| --- | --- | --- |
| `./data` | `/app/data` | SQLite DB, logs, derivatives, reports, run state |
| `./pipelines` | `/pipelines:ro` | canonical pipeline manifests |
| `./plugins` | `/plugins:ro` | bundled plugins |
| `./plugins` | `/plugins-user:ro` | current user-plugin discovery mount |
| `${HOST_DATASETS_DIR:-~/Documents}` | `/host-data:ro` | read-only dataset access |
| `/var/run/docker.sock` | same path | launching existing Docker-based pipelines |

Within `/app/data`, the current backend uses:

- database: `/app/data/neuroforge.db`, persisted at `./data/neuroforge.db`;
- run logs: `/app/data/logs/{run_id}.log`, persisted at `./data/logs`;
- outputs: `/app/data/derivatives/{pipeline_id}/{run_id}`, persisted at
  `./data/derivatives`.

The launcher must not substitute a second database, change these destinations,
copy datasets, or create desktop-only derivatives. It will verify that the
repository and `data` directory are readable and that `data` is writable before
startup. Dataset access remains read-only through the existing mount.

### Environment

The existing `.env` controls `HOST_DATASETS_DIR`, `HOST_UID`, and `HOST_GID`.
The launcher runs Compose with the repository as its working directory so
Compose continues to load this file normally. Diagnostics may report whether a
setting is present, but must redact home paths, usernames, tokens, credentials,
and environment values.

### Run activity and recovery

The backend already exposes the information needed for safe desktop shutdown:

- `GET /api/runs/queue` returns `running_run_id` and queued run IDs.
- `GET /api/runs` exposes persisted statuses, including `queued`, `pending`,
  and `running`.

The launcher will treat any queue entry or persisted active status as an active
scientific run. A quit request with an active run presents only:

- Cancel;
- Leave NeuroForge services running;
- Return to NeuroForge.

It will not cancel or kill the run by default. If no run is active, it may run
`docker compose ... stop` only when this launcher instance successfully started
the desktop-owned Compose project. It will never run `down -v`, delete a bind
mount, remove a volume, or stop an unrelated/manual Compose project.

Backend restart recovery is already implemented. At startup, persisted
`running` rows are matched to Docker containers using the `neuroforge_run_id`
label, with an output-mount fallback. Monitoring is reattached when the
container survives; otherwise the run is marked `interrupted`. A separate
checker detects stalled persisted runs when the in-process queue is idle. The
desktop launcher must preserve this behavior and must not add competing run
recovery logic.

## 3. Framework decision

### Decision: Electron for the prototype

Electron is selected for this macOS development prototype.

| Requirement | Tauri | Electron |
| --- | --- | --- |
| Launch and monitor Docker Compose | Reliable through Rust commands or shell plugin | Reliable through Node `child_process` |
| Reuse existing hosted React app | Webview can navigate to localhost | `BrowserWindow.loadURL` directly |
| Process lifecycle and logs | Requires Rust/plugin boundary | Native Node streams and process APIs |
| External links | Plugin/navigation handler | `setWindowOpenHandler` and `shell.openExternal` |
| macOS icon and `.app` | Supported | Supported by electron-builder |
| Current machine prerequisites | Blocked: no Rust toolchain or Xcode build tools detected | Node 24 and npm 11 already installed |

Tauri is attractive for a smaller production binary, but it is not the most
reliable prototype path on the audited machine because no `cargo`, `rustc`, or
usable Xcode build toolchain is installed. Installing and maintaining a second
language toolchain would add a material packaging prerequisite unrelated to
NeuroForge. Electron provides the required process control and native-window
behavior with the toolchain already used by the project.

This decision does not prevent a later Tauri evaluation once packaging,
signing, auto-update policy, and cross-platform requirements are stable.

## 4. Isolated desktop architecture

Desktop code will live under `desktop/`:

```text
desktop/
  assets/              # copied source logo and generated icons
  scripts/             # deterministic icon/build helpers
  src/
    main/               # Electron main process and orchestration
    preload/            # narrow typed IPC bridge
    renderer/           # lightweight startup/status shell only
  tests/                # launcher unit tests
  package.json
  tsconfig.json
  electron-builder.yml
  docker-compose.desktop.yml
  README.md
```

The desktop renderer is not a second NeuroForge frontend. It shows only startup,
error, diagnostics, privacy, and shutdown state. When ready, the same window
navigates to the existing Nginx-served React application.

Main-process modules will separate:

- system checks;
- redacted diagnostics;
- localhost/port checks;
- Compose command construction and owned-process state;
- health polling with explicit backend and frontend timeouts;
- safe shutdown/active-run policy;
- window bounds persistence and navigation policy;
- native menu actions.

The preload bridge will expose a small allowlisted IPC surface. The renderer
will not receive arbitrary shell execution or Node access. Electron windows use
`contextIsolation: true`, `nodeIntegration: false`, and sandboxing where
compatible.

## 5. Startup workflow

The startup state machine uses named states and elapsed-time detail, never fake
percentages:

1. **Checking system** — macOS version, architecture, RAM, disk, repository,
   directories, Docker CLI, daemon, Compose, and ports.
2. A precise blocking state when required: **Docker not installed**, **Docker
   daemon stopped**, **Docker Compose unavailable**, or **Port conflict**.
3. **Starting NeuroForge** — run the canonical Compose file plus the isolated
   localhost override under app-owned project name `neuroforge-desktop`.
4. **Backend starting** — poll `http://127.0.0.1:8000/api/health`.
5. **Frontend starting** — poll `http://127.0.0.1:3000/`.
6. **Ready** — show the privacy statement, then load the existing frontend.
7. **Startup failed** — show redacted details, Retry, Copy diagnostics, and Open
   logs.
8. **Shutting down** — apply the active-run policy before stopping anything.

The startup shell displays the provided logo, “NeuroForge”, “Local-first
neuroimaging workstation”, and:

> NeuroForge is running locally. The desktop launcher does not upload your datasets.

Docker is never installed automatically. When missing, the only installation
action opens the official Docker Desktop page in the system browser.

## 6. Compose ownership, health, logs, and shutdown

The desktop command is derived from the canonical deployment:

```text
docker compose
  --project-name neuroforge-desktop
  -f <repo>/docker-compose.yml
  -f <repo>/desktop/docker-compose.desktop.yml
  up --build -d
```

The launcher records ownership only after this command succeeds. It does not
claim a healthy stack found on occupied ports. A non-owned listener is a port
conflict, preventing accidental shutdown of manual or unrelated services.

Readiness is two-stage rather than inferred from process exit:

- backend: successful JSON health response;
- frontend: successful HTTP response after Compose reports backend healthy.

Logs are read using the same file set and `docker compose ... logs --no-color`
for the desktop project. Display and clipboard diagnostics are bounded and
redacted. Raw scientific run logs remain available through the existing UI.

Safe stop uses `docker compose ... stop` only for the owned project and only
when no scientific run is active. Files and bind mounts are untouched. “Leave
services running” releases the window without stopping Compose. Crash recovery
does not assume that an existing desktop-named project is owned by a newly
launched process; the next launch inspects it and requires an explicit safe
path.

## 7. Native window policy

- title: `NeuroForge`;
- minimum size: 1024 × 700, with last valid size and position restored;
- icon: generated from the supplied transparent logo;
- local paths and same-origin API/file links stay in the window;
- external links open in the macOS default browser;
- deep links and refresh rely on the existing Nginx SPA fallback;
- Escape is not registered as an application quit shortcut;
- development builds may open DevTools explicitly;
- packaged builds do not expose DevTools by default.

The native application menu/status area will expose NeuroForge, Docker,
backend, and frontend status; data, derivatives, and logs folders; copied
redacted diagnostics; restart/stop actions; About data from `/api/about`; and
Quit with the active-run guard.

## 8. Privacy and security

- Desktop-published services bind only to `127.0.0.1`.
- No telemetry, analytics, cloud account, remote compute, dataset upload, or
  desktop credential store is added.
- Docker may perform its normal image pulls when the canonical stack or a
  pipeline requires an image.
- Diagnostics replace user/home paths and environment values with stable
  redaction markers.
- The application makes no HIPAA, GDPR, clinical, or legal-compliance claim.
- The original logo remains unchanged at
  `/Users/arivolitirouvingadame/Downloads/neuroforge-logo.001-removebg-preview.png`.
  It is a 500 × 500 PNG with alpha; a copy will be placed under desktop assets
  during the scaffold milestone.

## 9. macOS prototype limitations

- Docker Desktop is an external prerequisite and must be running.
- The app will be an unsigned, unnotarized development bundle. Gatekeeper may
  require Control-click → Open or removal of quarantine for local testing.
- The prototype does not bundle Docker images; first use may take time while
  existing images build or pull.
- The repository and `.env` remain the source of deployment configuration; this
  prototype is not yet a relocatable consumer installer.
- Apple signing identity, hardened runtime, entitlements, notarization,
  universal binaries, update delivery, and installer UX are deferred.

## 10. Windows and Linux future considerations

- Replace macOS folder-opening and system-information adapters with tested
  platform abstractions.
- Handle Docker Desktop/WSL2 paths and named pipes on Windows.
- Handle native Docker sockets and desktop-file/AppImage packaging on Linux.
- Replace `.icns` with `.ico` and Linux PNG/icon-theme assets.
- Define per-platform dataset-path translation before claiming cross-platform
  pipeline parity.
- Keep the same canonical Compose deployment and localhost-only policy.

No Windows or Linux behavior will be guessed or silently enabled in this
macOS-first milestone.

## 11. Verification gates

Implementation may proceed only while all of the following remain true:

- canonical manual Compose still launches unchanged;
- the effective desktop Compose publishes only on `127.0.0.1`;
- desktop and manual launches share the same database, mounts, outputs,
  pipeline registry, plugins, and executors;
- active runs prevent automatic service shutdown;
- no command removes volumes;
- the original logo is unchanged;
- output hashes for identical representative runs match between launch modes;
- existing frontend and backend suites remain green.

If any gate fails, desktop implementation stops rather than adapting the
scientific stack.
