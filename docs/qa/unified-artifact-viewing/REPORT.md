# Unified artifact viewing qualification — 2026-07-21

## Verdict

The same artifact classification now selects the same Neuravian adapter for
local, remote, cloud-origin, synchronized, imported, and cached records. Local
MRIQC report viewing was inspected live. Cloud-origin behavior was qualified
with deterministic workspace/cache fixtures only; no authenticated cloud
workspace was available.

## Behavioral differences found

- Synchronized volumes used a smaller duplicate `CloudNiivueViewer`; local
  volumes used the full `NeuroImageViewer` controls and scientific display
  profiles.
- Cloud actions depended on cache/origin branches and advertised a separate
  “Cloud Browser”; local actions were capability/pipeline-panel driven.
- Extension rules existed in both `artifact-capabilities.ts` and
  `neuroArtifactView.ts`.
- Local reports used run-scoped URLs; synchronized reports read validated cache
  bytes, rewrote declared relative image assets, and rendered `srcDoc`.
- Synchronized files required local caching before viewing. Local files were
  streamed by the backend. SSH outputs already rejoined the local path after
  SFTP download.
- Both run types already shared `SharedRunDetail`, provenance metadata, and run
  history, but artifact toolbars and degraded-state language differed.

## Consolidation

- `CanonicalArtifact` normalizes identity, capability, content access metadata,
  provenance reference, checksum, availability, synchronization, and
  materialization without using origin for viewer selection.
- The legacy cloud capability resolver now delegates extension/scientific
  classification to `classifyNeuroArtifact`.
- `CloudNiivueViewer` is now only a secure cache transport adapter. Rendering is
  delegated to the same `NiivueViewer` and `NeuroImageViewer` as local runs.
- “Cloud Browser” was removed from the researcher-facing workflow. The fallback
  is the artifact browser, with availability expressed separately.

## Qualification

Real local evidence:

- MRIQC participant run 124
- embedded official HTML report opened
- IQM JSON and SVG reportlets remained available
- run provenance and lineage actions remained on the shared run page
- screenshot: `screenshots/local-mriqc-run-124.png`

Mocked/synchronized evidence:

- Origin-independence tests cover NIfTI, HTML, SVG, JSON, TSV, FreeSurfer
  surface geometry, and unsupported files.
- `CloudRunDetail` fixtures cover cached, partially cached, cloud-only, offline,
  report, and viewer-action states.
- Desktop cache tests cover resumable Range download, reuse, path rejection,
  checksum mismatch, and atomic materialization.
- Existing deterministic desktop screenshot:
  `../../screenshots/unified-cloud-workspace/run-7-details-viewer-actions.png`.
- This is not a real authenticated cloud qualification.

## Verification

- Focused viewer suite: 63 passed
- Frontend suite: 468 passed
- Frontend TypeScript and production build: passed
- Desktop suite: 118 passed
- Desktop TypeScript and production build: passed
- Backend suite: 753 passed, 1 skipped
- Backend and frontend Docker builds: passed
- Ruff: no Python files changed by this task
- `git diff --check`: passed

## Remaining limitations

- Cached image bytes currently cross Electron IPC as a `Uint8Array`; very large
  synchronized files would benefit from a future authenticated custom protocol
  with range streaming. Local HTTP viewing already avoids this limitation.
- Cached HTML relative images are supported, but arbitrary report scripts or
  undeclared remote assets remain constrained by the iframe sandbox and cache
  manifest.
- CIFTI, tractography, and AFNI-specific formats remain unsupported.
- Structured JSON/TSV presentation still varies between specialized pipeline
  result panels, although canonical selection is origin-independent.
- A real authenticated workspace is still required to qualify token expiry,
  live network loss, remote deletion, and cloud streaming end-to-end.
