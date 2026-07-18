# External Viewer Plugin Architecture

## Responsibility boundary

NeuroForge remains the system of record for projects, datasets, runs, provenance,
methods, and artifact relationships. External viewers are local visualization
backends. They receive only cache-scoped artifact paths and never modify run
outputs.

The built-in NeuroForge Viewer remains the first registered plugin and the
default in every environment.

## Plugin contract

`frontend/src/lib/viewerPlugins.ts` defines the viewer registry and contract:

- stable ID and display name
- supported platforms, scientific roles, and formats
- default installation paths
- local-only versus browser availability
- compatibility checks
- launch-preset and argument-array generation

The initial registry contains NeuroForge Viewer, FreeView, and MRIcroGL. Future
viewers can be added as registry entries without adding viewer-specific branches
to run pages.

## Browser and desktop behavior

In a browser deployment, FreeView and MRIcroGL are disabled with an explanation
that native applications require NeuroForge Desktop. No broken native-launch
button is shown.

In the Electron deployment, the preload bridge exposes only:

- viewer detection
- synchronization by numeric run ID
- launch from a typed, cache-relative preset

It does not expose a general shell, arbitrary filesystem access, arbitrary URLs,
or arbitrary destination directories.

## Installation detection

FreeView and MRIcroGL detection supports reviewed default paths on macOS,
Windows, and Linux. The detection service also accepts a manually configured
absolute executable path. Missing installations produce an unavailable state
and remediation text rather than a failed launch.

## Synchronization and cache

The backend provides a read-only sync manifest for successful runs. Each entry
contains a stable run-scoped artifact ID, relative path, byte count, SHA-256
checksum, download URL, and volume geometry when applicable. Host dataset,
output, license, credential, and absolute path values are removed or redacted.

NeuroForge Desktop stores each run once under its private user-data cache:

```text
run-cache/
  run-7/
    run-metadata.json
    artifacts/
      ...
```

Downloads use `.partial` files and HTTP ranges for resume. A file is reused only
when its size and SHA-256 checksum match. Metadata retains provenance, methods,
reports, artifact IDs, and checksums. Unchanged files are not downloaded again.

## Scientific pairing

Preset pairing is constrained by subject, requested base role, and anatomical
space. Before any multi-volume desktop launch, NeuroForge compares recorded:

- shape
- voxel size
- orientation axis codes
- full affine

A missing or unequal geometry blocks launch. NeuroForge never silently
resamples an artifact.

FreeView presets pass the anatomical base and overlay as separate arguments,
using nearest-neighbor display and the FreeSurfer LUT for categorical
segmentations. Compatible surfaces are passed with `-f`.

MRIcroGL presets pass the anatomical base followed by compatible overlays.
Interpolation and opacity remain explicit preset metadata; support can be
expanded only against empirically verified MRIcroGL command-line behavior.

## Security controls

- Run sync accepts only a positive integer run ID.
- Backend downloads remain scoped to the run output root.
- Traversal, absolute artifact paths, null bytes, and paths outside the cache
  are rejected.
- Child processes use argument arrays with `shell: false`.
- External viewers receive no credentials, FreeSurfer license path, EC2 path,
  dataset host path, or arbitrary directory.
- The cache metadata file is created with mode `0600`.
- Existing TLS and Basic Auth gateway behavior is unchanged.

## Current limitations

- Live FreeView and MRIcroGL execution has not been claimed; it requires those
  applications to be installed on the verification workstation.
- MRIcroGL MGZ support depends on the installed MRIcroGL build.
- Synchronization currently operates at whole-run scope before launch.
- The browser deployment explains desktop synchronization but cannot launch a
  native viewer itself.
- Future ITK-SNAP, FSLeyes, Surfice, Mango, and 3D Slicer integrations require
  new registry entries and empirically verified command builders.
