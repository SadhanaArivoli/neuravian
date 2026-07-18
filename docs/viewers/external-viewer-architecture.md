# External Viewer Plugin Architecture

## Responsibility boundary

NeuroForge remains the system of record for projects, datasets, runs, provenance,
methods, and artifact relationships. External viewers are local visualization
backends. They receive only cache-scoped artifact paths and never modify run
outputs.

The built-in NeuroForge Viewer remains the first registered plugin and the
default in every environment.

## Canonical verification

Run the backend suite from a clean checkout on the host:

```bash
./scripts/test-backend.sh
```

Prerequisites are `uv`, `git`, and `jq`. The script uses the locked backend
environment, enters the backend working directory, adds the repository and
backend to `PYTHONPATH`, and removes dataset, database, and data-directory
overrides that would couple tests to a developer or production deployment. A
successful run currently reports `617 passed, 1 skipped`; the skip is an
environment-specific frontend stale-mount guard in the group functional
connectivity tests, while the frontend is verified directly by its unit,
TypeScript, and production-build gates. Tests for tools such as Docker or native
scientific applications must declare and report those dependencies separately.

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

The July 2026 macOS verification workstation detected FreeView 8.0.0 through a
manually configured absolute application path under a versioned FreeSurfer
installation. MRIcroGL was not detected in the standard application, user
application, FreeSurfer, Homebrew, `/usr/local`, or `PATH` locations checked.

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

## Empirical verification status

FreeView 8.0.0 was empirically verified on macOS in July 2026 with the completed
FastSurfer Run 7 preset:

- bias-corrected conformed anatomy (`orig_nu.mgz`);
- subcortical segmentation (`aseg.auto.mgz`);
- FreeSurfer LUT and `0.7` overlay opacity.

The two artifacts were synchronized into the private desktop cache, matched
their manifest byte counts and SHA-256 checksums, passed full geometry
comparison, and were launched with an argument array and `shell: false`.
FreeView remained running, created an on-screen window, and its own screenshot
command rendered the expected anatomical image and categorical segmentation
layers before exiting successfully. Source artifacts were not modified.

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

- Versioned FreeSurfer installations may require a configured absolute FreeView
  executable plus the installation's existing `FREESURFER_HOME` and
  `FS_LICENSE` process environment. NeuroForge does not create, copy, or modify
  a FreeSurfer license.
- MRIcroGL execution remains pending because MRIcroGL was not installed on the
  verification workstation.
- MRIcroGL MGZ support depends on the installed MRIcroGL build.
- Synchronization currently operates at whole-run scope before launch.
- The browser deployment explains desktop synchronization but cannot launch a
  native viewer itself.
- Future ITK-SNAP, FSLeyes, Surfice, Mango, and 3D Slicer integrations require
  new registry entries and empirically verified command builders.
