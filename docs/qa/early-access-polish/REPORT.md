# Early Access release-polish audit

Date: 2026-07-21

## Scope and method

This audit reviewed the running Docker build at `http://localhost:3000`, not only
source code. The Home, Projects, Datasets, Pipelines, Runs, Saved Workflows,
DICOM Wizard, Plugins, Workspaces, Settings, MRIQC run detail, Artifact Explorer,
and Methods Studio routes were inspected through their rendered accessibility
trees. The existing public-dataset MRIQC qualification run (`#124`) was reopened
and its report, metrics, artifacts, provenance, and methods links were checked.

This sprint did not add a pipeline, alter scientific algorithms, redesign the
application, or claim new scientific qualification.

## Improvements made

### Important

- Unified Early Access naming across the welcome page, onboarding, Settings, and
  About surfaces (`Early Access · v0.1.0`).
- Consolidated the navigation language around **Workspaces**, removing the
  redundant Remote Hosts entry while preserving its underlying route and
  behavior.
- Reworded onboarding and first-run guidance around the actual user model:
  Dataset → Pipeline → Run → Artifacts → Report.
- Added recovery behavior to the About dialog when version information cannot be
  loaded.
- Fixed the Compose plugin mounts. The bundled `image-statistics` plugin was
  previously mounted at both `/plugins` and `/plugins-user`, causing the Plugins
  page to show the same plugin as both active and failed. The user-plugin mount
  now uses the dedicated `plugins-user/` directory.
- Corrected the quickstart to use the actual Review & Launch flow, removed the
  unsupported 15-minute end-to-end promise, described realistic MRIQC runtime,
  and corrected the MRIQC artifact type.
- Corrected README statements that still described researcher-managed remote
  execution as future work and accurately bounded fMRIPrep qualification.
- Added a visible qualification disclaimer and a dedicated known-limitations
  document.

### Minor and cosmetic

- Standardized sentence case for primary actions and product labels.
- Improved shared button focus, hover, and disabled states.
- Made the shared page header a semantic `header` element.
- Added consistent `:focus-visible` treatment and reduced-motion behavior.
- Standardized status copy from developer-oriented “Backend connected” to
  researcher-facing “Ready,” while retaining a clear offline state.
- Improved scrollbar and selection styling without changing page layouts.
- Removed a stale BIDS Validator preflight TODO now that shared preflight is in
  place.

## Evidence

- Before Home: [`before-home.png`](before-home.png)
- Before Datasets: [`before-datasets.png`](before-datasets.png)
- Final Home: [`after-home.png`](after-home.png)
- Final Settings: [`after-settings.png`](after-settings.png)
- Fixed Plugins page: [`after-plugins.jpg`](../../screenshots/visual-consistency/after-plugins.jpg)
- Reopened qualified MRIQC run: [`participant-run-124-fixed.png`](../mriqc-execution-qualification/screenshots/participant-run-124-fixed.png)

The MRIQC screenshot is evidence that the previously completed run remains
accessible and readable after the polish changes. It is not evidence of a newly
executed MRIQC run.

## Persona review

### First-time student researcher

The Home page provides two clear starting actions, onboarding uses consistent
terms, and the launch sequence is documented accurately. The pipeline catalog is
still information-dense and assumes basic knowledge of BIDS; contextual help and
the quickstart remain important.

### Research assistant running routine QC

Datasets, runs, logs, MRIQC metrics, HTML report, artifacts, methods, and
provenance are reachable without leaving the application. Raw dataset locations
remain visible where they are operationally useful; installations handling
sensitive paths should use neutral mount names and follow local access controls.

### Lab lead reviewing reproducibility

Run detail exposes status, runtime, artifacts, provenance, and methods. Generated
methods are explicitly drafts and must be scientifically reviewed. Qualification
scope is now easy to find from the README.

### Platform administrator

The Docker build is reproducible, the backend health check gates frontend start,
and bundled versus user plugins are now isolated. Remote workspace behavior still
depends on researcher-managed credentials, network policy, and infrastructure.

## Remaining issues

### Important

- fMRIPrep has adapter and manifest coverage but no completed qualification on
  this Apple Silicon host. It must not be represented as locally qualified.
- Cloud/SSH tests exercise contracts and synchronization logic; they do not
  qualify every researcher-managed remote environment or a new long-running
  scientific execution.

### Minor

- The production build reports three viewer/compression chunks above 500 kB.
  Major routes are already lazy-loaded; further work requires deliberate vendor
  chunking and browser performance measurement rather than a release-week rewrite.
- React test output includes React Router v7 future-flag notices and `act(...)`
  warnings in CloudRunDetail tests. Assertions pass, but the test harness should
  be cleaned up before a React Router upgrade.

### Cosmetic

- The pipeline catalog contains long scientific descriptions and can require
  substantial scrolling. Changing its information hierarchy would be a UI
  redesign and was intentionally left out of this sprint.

## Release recommendation

**Release as a narrowly labeled Early Access build: yes, with limitations.**

The release is suitable for researchers evaluating the local-first workspace and
the qualified local MRIQC participant path. It is not suitable for clinical use,
must not imply scientific validation, and must not market fMRIPrep or arbitrary
cloud execution as qualification-complete. The README and known-limitations page
now make those boundaries explicit.
