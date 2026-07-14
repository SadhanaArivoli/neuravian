# NeuroForge desktop prototype

This directory contains a thin Electron launcher for the existing NeuroForge
Docker Compose deployment. It does not contain a replacement frontend, backend,
database, or scientific execution system.

## Prototype prerequisites

- macOS on Apple Silicon
- Docker Desktop with Docker Compose 2.24.4 or newer
- the NeuroForge source checkout and its existing `.env`
- Node.js/npm for development builds

Docker is not installed automatically. If it is missing or stopped, the startup
shell explains the problem, links to Docker Desktop's official macOS installation
page, and keeps the Retry and privacy controls available.

## Run the development app

From this directory:

```bash
npm install
npm run dev
```

The launcher checks the system, starts the repository's canonical
`docker-compose.yml` with `docker-compose.desktop.yml` as a localhost-only
override, waits for the backend and frontend, and then loads the existing React
application in the native window. It uses the Compose project name
`neuroforge-desktop` so it never assumes ownership of a manually started stack.

The override changes only published port bindings:

- backend: `127.0.0.1:8000`
- frontend: `127.0.0.1:3000`

All canonical bind mounts, data paths, pipeline manifests, plugins, the SQLite
database, reports, logs, and derivatives remain unchanged.

## Asset generation

The original logo remains outside the repository and is never modified. Generate
the checked desktop derivatives with:

```bash
./scripts/generate-icons.sh /absolute/path/to/neuroforge-logo.001-removebg-preview.png
```

## Development commands

```bash
npm install
npm run typecheck
npm test
npm run dev
npm run dist:mac
```

`npm run dist:mac` produces the unsigned development bundle under
`desktop/dist/mac-arm64/NeuroForge.app`.

Double-clicking that bundle is the prototype user flow. The first launch may
take several minutes while Docker builds or pulls images. NeuroForge shows real
startup states rather than a synthetic percentage.

Because this development build is unsigned and not notarized, macOS Gatekeeper
may block the first launch. In a development checkout, use Finder's **Open**
context-menu action and confirm the prompt, or allow the blocked app in
**System Settings → Privacy & Security**. Do not remove Gatekeeper protections
globally.

Production distribution will require an Apple Developer ID Application
certificate, hardened runtime/entitlements review, `codesign`, notarization with
Apple's notary service, and stapling the notarization ticket. Those release
steps are intentionally deferred.

The canonical manual deployment remains:

```bash
docker compose up --build
```

The desktop app is optional. It is not required for development, CI, pipeline
execution, plugin development, or server deployment.

## Shutdown behavior

The launcher queries `/api/runs/queue` and `/api/runs` before stopping services.
When execution is idle, it runs Compose `stop` only for services launched by
that app process. It never runs `down -v` or removes data. When a run is active,
Quit offers **Cancel**, **Leave NeuroForge services running**, or **Return to
NeuroForge**; stopping an active run is never the default.

See [prototype-verification.md](../docs/desktop/prototype-verification.md) for
the regression matrix, output hashes, screenshots, and test totals.
