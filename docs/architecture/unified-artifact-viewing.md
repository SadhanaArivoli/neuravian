# Unified artifact viewing

## Previous architecture

```text
Local/SSH run (SSH outputs are downloaded by the executor)
  → /api/runs/{id}/results and /files/{path}
  → RunResults / pipeline-specific result panel
  → NeuroImageViewer, NeuroSurfaceViewer, report iframe, or file list

Cloud workspace run
  → signed artifact manifest
  → desktop WorkspaceReplicationEngine / run cache
  → CloudRunDetail capability table
  → CloudNiivueViewer, cached-report srcDoc reconstruction, external viewer,
    or download-only fallback

Imported derivatives
  → normal local run artifact inventory
  → the local path above
```

The local and cloud paths shared `SharedRunDetail`, but did not share the image
viewer engine or extension registry. Cloud actions were selected partly from
cache/origin state and used “Cloud Browser” terminology. Local content used
run-scoped HTTP URLs; synchronized content used validated desktop IPC reads.
Cloud report assets were materialized as data URLs because cached HTML has no
HTTP base URL. SSH was already normalized to local outputs after SFTP download.

## Canonical contract

`CanonicalArtifact` in `frontend/src/lib/artifactViewing.ts` contains stable
identity, family/role/media hints, size/checksum, source run and provenance,
availability and synchronization state, materialization state, authorized
content URL, and download capability. `normalizeArtifact()` classifies the
artifact with the existing scientific classifier and selects a viewer adapter
from capabilities only:

| Capability | Adapter |
|---|---|
| NIfTI, MGH, MGZ | `neuroimage` |
| FreeSurfer/GIFTI geometry, overlay, annotation | `surface` |
| HTML | `report` |
| SVG, PNG, JPEG | `image` |
| JSON, TSV, CSV, statistics | `structured` |
| Logs/text | `text` |
| Transform or unsupported format | `download` |

Origin never participates in adapter selection. It only changes availability
text and the authorized content-access implementation.

## Content access and security

- Local and SSH-completed artifacts retain `/api/runs/{id}/files/{path}` access,
  including backend containment checks and streaming responses.
- Synchronized artifacts remain inside the desktop run cache. IPC validates
  workspace IDs, run IDs, relative paths, NULs, traversal, and resolved cache
  containment before reading.
- Cloud downloads remain centralized in `WorkspaceReplicationEngine` and
  `run-cache.ts`; viewers do not receive credentials or signed URLs.
- Downloads stream to `.partial` files, resume with Range requests, verify size
  and SHA-256, and atomically rename only after verification. Mismatches never
  become complete cached artifacts.
- The synchronized compatibility transport creates short-lived object URLs and
  immediately delegates rendering to the same `NiivueViewer` /
  `NeuroImageViewer` stack used by local runs. Object URLs are revoked on close.
- HTML reports retain their sandboxed iframe. Relative cached image assets are
  resolved only within the declared artifact manifest and embedded as data URLs;
  traversal references are rejected.

## Caching and performance

The synchronization engine reuses files only when size and SHA-256 match, avoids
duplicate downloads, supports interrupted-transfer continuation, and never
marks partial data complete. Imaging data is still lazy-loaded when the viewer
opens. Cached desktop artifacts currently cross IPC as a `Uint8Array`; this is a
known large-file limitation, but the refactor does not add another copy or a
second rendering engine. Local HTTP viewing retains browser streaming/range
behavior where supported.

## Degraded states

Transport state is normalized to: Available locally, Available from workspace,
Streaming from workspace, Synchronizing, or Temporarily unavailable. The shared
viewer transport reports a restart/reconnect/synchronize recovery action when
the secure reader is missing or a cached artifact cannot be read. A checksum
mismatch fails synchronization and leaves only the partial file.

## Compatibility

Existing run routes, report URLs, artifact IDs, cache layout, preload channel,
external-viewer launches, provenance links, and synchronization APIs remain
unchanged. `CloudNiivueViewer` remains as a compatibility transport component,
but it no longer implements a viewer engine.

## Current support and limitations

Supported: NIfTI, MGH/MGZ, FreeSurfer surfaces and associated overlays,
FreeSurfer annotations when paired with geometry, HTML, SVG, PNG/JPEG, JSON,
TSV/CSV, statistics, and text/log files. Transforms and unknown formats use the
consistent metadata/download fallback. CIFTI, tractography, and AFNI-specific
formats remain unsupported. No real authenticated cloud workspace was available
for qualification; cloud-origin behavior is covered with deterministic desktop
bridge and workspace fixtures.
