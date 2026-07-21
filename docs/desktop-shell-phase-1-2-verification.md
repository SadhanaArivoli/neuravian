# Desktop Shell Phase 1–2 Verification

Verified on macOS with the packaged application at
`desktop/dist/mac-arm64/NeuroForge.app`.

## Scope

- Restored `Welcome` at `/` for browser and desktop.
- Restored the original sidebar navigation and added `Workspace` at
  `/workspaces`.
- Preserved the global workspace switcher and existing workspace architecture.
- Added only a compact current-workspace label and workspace metadata counts to
  the existing Home page.
- Added a desktop startup guard for a delayed Chromium history restoration that
  otherwise reopened the previous route after the root document loaded.

No backend API, synchronization, pipeline, dataset, run, provenance, viewer,
artifact, deployment, database schema, or scientific output was changed.

## Packaged verification

- A clean packaged launch landed on Home.
- Home retained the original NeuroForge hero, actions, status line, cards,
  branding, and complete sidebar.
- Local Home: 1 project, 10 datasets, 3 workflows, 109 runs, 10 reports.
- AWS Home: 0 projects, 1 dataset, 0 workflows, 7 runs, 0 reports.
- All Workspaces Home: 1 project, 11 datasets, 3 workflows, 116 runs, 10
  reports, explicitly labeled as aggregated metadata.
- AWS Workspace dashboard: 1 dataset, 7 runs, 1 cached run, 6 cloud-only runs.
- Local Workspace dashboard: 1 project, 10 datasets, 3 workflows, 109 runs, 10
  reports.
- All Workspaces displayed local Run #7 and AWS Run #7 with distinct
  workspace-qualified identities.
- AWS Run #7 remained partially cached with 29 artifacts, 2 cached artifacts,
  and FreeView ready from cache.
- Quit/relaunch preserved the last selected workspace and returned to Home.

## Data integrity

- SQLite integrity check: `ok`.
- Database SHA-256 before:
  `9cb96314d328c44d555dfaa1f458361a41a7dcbf1dc30943cfb5df88e924f9cc`
- Database SHA-256 after:
  `9cb96314d328c44d555dfaa1f458361a41a7dcbf1dc30943cfb5df88e924f9cc`
- No migration ran and no local or cloud record was modified.

## Automated verification

- Focused frontend shell/workspace tests: 14 passed.
- Full frontend suite: 406 passed in 30 files.
- Desktop suite: 81 passed in 10 files.
- Frontend strict TypeScript and production build: passed.
- Desktop TypeScript and production build: passed.
- macOS arm64 packaged build: passed.

## Screenshots

- `docs/screenshots/restored-shell/restored-home-complete-sidebar.png`
- `docs/screenshots/restored-shell/home-local.png`
- `docs/screenshots/restored-shell/home-aws.png`
- `docs/screenshots/restored-shell/workspace-aws.png`

## Remaining UI concern

The compact count row uses intentionally subdued secondary text. It preserves
the original Home hierarchy, but may merit a later accessibility contrast review
outside this checkpoint.
