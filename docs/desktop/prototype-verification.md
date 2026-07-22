# Neuravian local desktop prototype verification

Verified on 2026-07-14 on Apple Silicon macOS. This document records the final
milestone evidence; it does not change pipeline code or scientific behavior.

## Bundle and branding

- Framework: Electron 43.1.1. Tauri was rejected for this prototype because the
  host had neither Rust nor the Xcode command-line toolchain, while Electron can
  directly supervise Docker Compose and package an immediately testable `.app`.
- Bundle: `desktop/dist/mac-arm64/Neuravian.app`
- Bundle ID: `org.neuravian.desktop`
- Packaging: unsigned ARM64 development directory bundle; signing identity is
  explicitly `null`.
- Logo source: `/Users/arivolitirouvingadame/Downloads/neuravian-logo.001-removebg-preview.png`
- Source and retained-copy SHA-256:
  `6a074630ce385e74cba906861af4f3ae8e72840ff53172438f9b888a908d0cf3`
- Preserved source copies: `neuravian-logo.png`, `neuravian-window.png`, and
  `neuravian-splash.png` are byte-identical to the supplied 500×500 RGBA PNG.
- Generated PNG icons: 16, 32, 64, 128, 256, 512, and 1024 pixels.
- Generated macOS icon: `desktop/assets/Neuravian.icns` plus the standard
  1×/2× `.iconset` entries. Transparency and square aspect ratio are preserved.

## Startup, privacy, and ownership

The launcher performs real checks for macOS version, architecture, total RAM,
available data-volume disk, repository files, data-directory read/write access,
Docker CLI, Docker daemon, Compose v2, and ports 8000/3000. It then starts:

```text
docker compose --project-name neuravian-desktop \
  -f docker-compose.yml \
  -f desktop/docker-compose.desktop.yml \
  up --build --detach
```

Backend readiness is polled at `http://127.0.0.1:8000/api/health`; frontend
readiness is polled at `http://127.0.0.1:3000`. The verified desktop containers
published only `127.0.0.1:8000` and `127.0.0.1:3000`. The launcher adds no
telemetry, analytics, accounts, uploads, credentials, or unrelated networking.

The canonical Compose file remains authoritative. The desktop override contains
only localhost port replacements. Both modes use the same `data/`, SQLite file,
dataset mount, pipeline/plugin mounts, derivatives, reports, logs, and Docker
executor socket.

## Native-window verification

- Native title and supplied icon are applied.
- Minimum size is 1024×700; size and position persist in the app user-data
  directory with owner-only file permissions.
- `file:` startup routes and `http://127.0.0.1:3000` routes remain in-app.
- Other HTTP(S) links open in the system browser; unsafe schemes are rejected.
- Release builds disable DevTools by default.
- The Neuravian menu exposes app/Docker status, data/derivatives/log folders,
  diagnostics, restart, stop, quit, and `/api/about` data.
- Diagnostics redact home paths, usernames, and common credential forms.

Screenshots:

- [Native startup shell](screenshots/desktop-startup.png)
- [Desktop native application](screenshots/desktop-native-app.png)
- [Desktop run viewer](screenshots/desktop-run-109-viewer.png)
- [Canonical browser dashboard](screenshots/canonical-dashboard.png)

## Safe shutdown verification

The app combines `/api/runs/queue` with `/api/runs` and treats pending, queued,
or running work as active. An active run produces the required **Cancel**,
**Leave Neuravian services running**, and **Return to Neuravian** options. If
status cannot be verified, stop/restart/quit fails closed. An idle quit issues
`docker compose ... stop` only when that app process successfully started the
services. No code path uses `down`, `down -v`, volume removal, or data deletion.

In the live test, quitting the desktop app left runs 100–109, the SQLite
database, reports, logs, and derivative files intact. The canonical manual stack
then restarted successfully with `docker compose up -d` and returned a healthy
`/api/health` response.

## Representative pipeline regression

Canonical runs 100–104 and desktop-launched runs 105–109 used identical inputs
and parameters. All ten runs succeeded.

| Pipeline | Canonical | Desktop | Deterministic scientific result |
|---|---:|---:|---|
| BIDS Validator (Docker) | 100 | 105 | report SHA-256 `dc5a489491d0d98d05b7b28e2133cdcbcb076862e1c9300551bdc093584e9e22` |
| NIfTI Inspector | 101 | 106 | histogram SHA-256 `7954e24af5a2d31af12791727dc5b1978e3072e3fe0c44f69005ca40e17a147e` |
| Functional Connectivity | 102 | 107 | matrix NPY SHA-256 `127ea28d0c1dff53415bcad3ed5e79af3bfab69ef9d2593be24d8ad85181f4be` |
| ALFF/fALFF | 103 | 108 | ALFF NIfTI SHA-256 `7e41780d37e8c4783d8fad60bbfe4ad5486e3b2688790e973ec174f606aee8d3` |
| ReHo | 104 | 109 | ReHo NIfTI SHA-256 `666fa651bfa176032bd1709874f135f8561ac538b50b286a63b36c442656a99f` |

Byte comparison also matched the NIfTI histogram, FC heatmap/matrix CSV/matrix
NPY/ROI CSV/ROI JSON/timeseries TSV, all ALFF/fALFF maps and plots, and both ReHo
maps plus histogram. Raw metadata JSON correctly records per-execution elapsed
time, and NIfTI Inspector also records its inspection timestamp, so those
volatile fields differ. Removing only those provenance-time fields produces
identical normalized JSON hashes:

| Metadata | Normalized SHA-256 in both modes |
|---|---|
| NIfTI Inspector | `cec363365e792d164f01ae4feb4ce2bbf2e82eb759b57911b7499e7dc85ba03d` |
| Functional Connectivity | `b0e49ac3bcb7b487be39f2cd50105636102bf12a4a0625f48d0714fe77a73260` |
| ALFF/fALFF | `fc618f5af2cac2a607b89c4edd9c6961258b3c21c05494ac51cc8fad1ff847b4` |
| ReHo | `4a92a7a693263cf7e3dfd20f66fc21ee7be3aadf1cd3d1b5e079d4339b391ddf` |

This is the expected reproducibility result: scientific outputs are identical,
while truthful runtime provenance remains specific to each execution.

## Browser and surface QA

The desktop-launched stack was visually verified on run 109 and dataset 1:

- pipeline catalog and Functional Connectivity configuration form
- queue completion and run status
- command-preview disclosure and execution log
- Results and embedded ReHo HTML report
- five discovered ReHo artifacts and downloads
- Analysis Graph with highlighted run 109
- Methods Studio single-run methods/provenance
- Study Report Studio
- shared NIfTI visualization controls, histogram, default Inferno colormap,
  Viridis selection, Reset Viewer, opacity/interpolation/window/crosshair/export
  controls, and keyboard-shortcut labels
- browser console errors: 0

## Automated verification

| Gate | Result |
|---|---|
| Desktop Vitest | 37 passed across 4 files |
| Desktop TypeScript | passed |
| Desktop build | passed |
| Unsigned macOS `.app` build | passed |
| Frontend Vitest | 304 passed across 16 files |
| Frontend TypeScript + production Vite build | passed |
| Backend pytest | 559 passed, 1 skipped |
| Canonical Compose launch | healthy |
| Desktop Compose launch | healthy, localhost-only |
| `git diff --check` | passed |

The first sandboxed backend attempt could not launch Chromium. The required
unrestricted rerun passed all Chromium-backed report tests; the single skip is
the suite's existing conditional skip.

## Deferred release and platform work

- Apple Developer ID signing, hardened-runtime entitlement review, notarization,
  stapling, and a signed installer/DMG.
- Intel macOS/universal build and testing.
- Windows launcher process/port/path integration and signed installer.
- Linux launcher packaging across supported distributions.
- A future installed-app repository-location strategy; this prototype is built
  from and operates beside a Neuravian source checkout (or uses
  `NEURAVIAN_REPO_ROOT`).
- Release automation and update delivery. No auto-updater is included here.
