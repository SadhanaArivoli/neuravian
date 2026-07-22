# Unified multi-workspace desktop verification

Verified on macOS on 2026-07-17/18 using the packaged application at
`desktop/dist/mac-arm64/Neuravian.app`. The product name was `Neuravian`,
the bundle identifier was `org.neuravian.desktop`, and no Electron development
application was used for acceptance.

## Backup and identity

- Backup root:
  `/Users/arivolitirouvingadame/Documents/Neuravian Backups/phase1-20260718T052559Z`
- Original and backup database SHA-256:
  `9cb96314d328c44d555dfaa1f458361a41a7dcbf1dc30943cfb5df88e924f9cc`
- Local workspace identity:
  `local-d5454b03-695d-4783-89ed-0f41ae2f3226`
- AWS workspace UUID:
  `96525865-a884-50c2-9cf2-8dfcd77a111d`
- AWS server:
  `https://44-204-18-239.sslip.io`

The final database SHA-256 remained
`9cb96314d328c44d555dfaa1f458361a41a7dcbf1dc30943cfb5df88e924f9cc`.
No database migration ran and no scientific record changed.

## Integrity comparison

| Local object | Before | After |
| --- | ---: | ---: |
| Projects | 1 | 1 |
| Datasets | 10 | 10 |
| Runs | 109 | 109 |
| Run ID range | 1–109 contiguous | 1–109 contiguous |
| Registered artifacts | 330 | 330 |
| Reports | 10 | 10 |
| Provenance events | 328 | 328 |
| Run logs | 108 | 108 |
| Saved workflows | 3 | 3 |

The registered-artifact inventory is unchanged because the scientific database
is byte-identical and no file under `data/derivatives`, `data/reports`, or
`data/logs` was created or modified after the backup timestamp. The current
runtime artifact resolver exposes 335 resolved paths (and 365 semantic artifact
entries); those are derived views, not new database records, and are not the
330-item inventory definition used by the backup manifest.

Representative local files remained unchanged:

- Run 55 `graph_metrics.json`:
  `aefd66dfbf3181aa7625efce41d40aecec7facfe9cc7a1139a1ad0ec28015bb5`
- Run 109 `reho_map.nii.gz`:
  `666fa651bfa176032bd1709874f135f8561ac538b50b286a63b36c442656a99f`

Cloud metadata remained at one dataset and seven runs. Cached Run 7 artifacts
matched their Phase 1 backup copies:

- `aseg.auto.mgz`:
  `0068f96c494904f92351a36c5312b0a32a76d3ed84bfa2fbc0dc2e4dfb2e7bec`
- `orig_nu.mgz`:
  `b224fcf88e89ee42c5f3751753b3ed2ade3e3848e10e0e4139629036d2bcee43`

## Packaged application checks

- Exactly one branded Neuravian main process was used; the startup trace
  reached `main Neuravian UI visible`.
- Local Neuravian displayed 10 datasets, 3 workflows, 109 runs, and
  `Available offline`.
- AWS Neuravian displayed one dataset, seven runs, the expected UUID, and a
  healthy synchronized connection.
- All Workspaces displayed both local Run 7 and AWS Run 7 with distinct keys:
  `local-d5454b03-695d-4783-89ed-0f41ae2f3226:run:7` and
  `96525865-a884-50c2-9cf2-8dfcd77a111d:run:7`.
- Local Runs 1, 55, and 109 opened. Their applicable metadata, provenance,
  logs, results, and artifacts remained available.
- Cloud Run 7 displayed `Metadata Cached`, `Partially Cached`, 29 registered
  artifacts, and the two-file FreeView preset.
- Launching cloud Run 7 in FreeView returned `0 downloaded · 2 reused`.
- MRIcroGL correctly displayed `Not Installed`.
- After a real Wi-Fi disconnect, Local remained available and cloud Run 7
  displayed `Offline Cached`; uncached cloud runs displayed
  `Synchronization Failed`.
- Wi-Fi was restored, DNS again resolved the server to `44.204.18.239`, the
  HTTPS endpoint returned the expected Basic Auth challenge, and workspace
  synchronization returned to `Connected`.
- Selecting AWS, quitting, and relaunching the packaged app restored AWS as the
  last-selected workspace. Switching back to Local immediately restored the
  same 109-run view.

There is no successful local run with a registered, geometry-compatible
`orig_nu.mgz` plus `aseg.auto.mgz` pair. Failed local Run 23 has those files on
disk, but the backend correctly does not register failed-run artifacts. A direct
local FreeView launch was therefore not forced and remains empirically
unverified. The direct-local launch path is covered by desktop and frontend
tests and does not download, copy, or relocate artifacts.

The legacy bare `run-cache/run-7` entry was detected and left untouched. New
cloud cache writes remained under the AWS workspace UUID namespace.

## Automated verification

- Canonical backend verification: 620 tests collected; gate passed (one
  pre-existing skip).
- Frontend: 403 tests passed across 29 files.
- Frontend strict TypeScript and production build: passed.
- Desktop: 81 tests passed across 10 files.
- Desktop strict TypeScript and production build: passed.
- Packaged macOS directory build: passed.

## Screenshots

These qualification captures are historical evidence from before the Neuravian
rename. Their legacy filenames and any branding visible in the pixels are not a
current product-name claim.

- [Local workspace and selector](../screenshots/unified-multi-workspace/local-neuravian.png)
- [AWS workspace](../screenshots/unified-multi-workspace/aws-neuravian.png)
- [All Workspaces](../screenshots/unified-multi-workspace/all-workspaces.png)
- [Local Run 109](../screenshots/unified-multi-workspace/local-run-109.png)
- [Cloud Run 7](../screenshots/unified-multi-workspace/cloud-run-7.png)
- [Cloud FreeView action](../screenshots/unified-multi-workspace/cloud-freeview-action.png)
- [Real offline state](../screenshots/unified-multi-workspace/offline-state.png)
