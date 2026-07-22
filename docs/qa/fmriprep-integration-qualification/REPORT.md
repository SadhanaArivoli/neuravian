# fMRIPrep integration qualification — 2026-07-21

## Verdict

**Integration verification: PASS. Scientific execution qualification: NOT
EXECUTED. Release readiness: NOT QUALIFIED.**

The official fMRIPrep container, Pipeline Contract v1, generic BIDS App command
planning, local and SSH execution planning, parameter validation, discovery
declarations, progress parsing, cancellation, retry, provenance, runtime-version
capture, and methods/citations are integrated and covered by tests. No complete
fMRIPrep participant run was launched or completed in this environment, so no
scientific output is claimed.

## Official image evidence

- Image: `nipreps/fmriprep@sha256:15cbf8dcd17440d26ff5e80e9f7313f1cb3c54f13673f1ec4aed4465e8e12d77`
- Image OS/architecture: `linux/amd64`
- Runtime-reported version: `fMRIPrep v25.2.5`
- The image was inspected and `--version` and `--help` were actually executed.
- Verified CLI flags include participant/session selection, `--mem`, output
  spaces, skull stripping, FreeSurfer licensing, and work-directory handling.

## Public dataset selected

- OpenNeuro accession: `ds000001`
- Snapshot: `1.0.0`
- DOI: `10.18112/openneuro.ds000001.v1.0.0`
- Local dataset: `openneuro-ds`, 16 participants
- Intended qualification unit: `sub-13`

The same public dataset was previously used for the completed MRIQC
qualification. It contains anatomical and functional BIDS inputs suitable for
fMRIPrep.

## Why execution was not attempted

The real Neuravian preflight blocked launch for three independently measured
reasons:

1. Host architecture is ARM64 while the pinned official image is AMD64. This
   integration is explicitly qualified only on native Linux x86_64 because ANTs
   normalization has stalled under emulation.
2. The backend detected 7.8 GB RAM, below the manifest's 16 GB minimum.
3. No non-empty readable FreeSurfer `license.txt` was available. A placeholder
   path was used only to verify researcher-facing validation.

The UI kept **Start Run** disabled. Bypassing those safety checks would not be a
valid qualification.

Screenshot: `screenshots/preflight-blocked.png`.

## Adapter reuse

No fMRIPrep executor or command builder was created. The manifest uses the same
`build_bids_app_plan` path as MRIQC for:

- `/data /out participant` positional arguments
- read-only dataset mounting
- read-only FreeSurfer license mounting
- writable work and output mounts
- BIDS entity normalization (`sub-`, `ses-`, `task-`)
- booleans, multiselects, defaults, advanced parameters, and CLI flags
- local Docker SDK execution
- remote SSH Docker execution
- deterministic provenance command rendering

Cancellation and retry use the existing run lifecycle. Retry creates a fresh
run with the same recorded parameters. A researcher-supplied work directory is
preserved and remounted, but the integration does not claim automatic resume.

## fMRIPrep-specific declarations

Only manifest-level knowledge was added:

- official image digest and runtime version regex
- researcher-facing basic and advanced parameters
- fMRIPrep log stage patterns
- report, figure, confound/TSV, JSON metadata, and transform globs
- fMRIPrep derivative artifact descriptions
- fMRIPrep methods summary and primary citation
- known fMRIPrep error translations already present in the manifest

## Discovery fixture artifact tree

The manifest discovery test creates this representative tree and verifies every
declared artifact family through the production artifact registry:

```text
sub-13.html
dataset_description.json
sub-13/
├── figures/
│   └── sub-13_task-rest_desc-summary_bold.svg
├── anat/
│   └── sub-13_from-T1w_to-MNI152NLin2009cAsym_mode-image_xfm.h5
└── func/
    ├── sub-13_task-rest_desc-confounds_timeseries.tsv
    └── sub-13_task-rest_desc-confounds_timeseries.json
```

This is automated integration evidence, not scientific execution evidence.

## Executed commands and results

```text
docker image inspect nipreps/fmriprep@sha256:15cbf8dcd17440d26ff5e80e9f7313f1cb3c54f13673f1ec4aed4465e8e12d77
docker run --rm nipreps/fmriprep@sha256:15cbf8dcd17440d26ff5e80e9f7313f1cb3c54f13673f1ec4aed4465e8e12d77 --version
docker run --rm nipreps/fmriprep@sha256:15cbf8dcd17440d26ff5e80e9f7313f1cb3c54f13673f1ec4aed4465e8e12d77 --help
UV_CACHE_DIR=/tmp/neuravian-uv-cache uv run pytest tests/test_bids_app_adapter.py tests/test_pipeline_contract.py tests/test_bids_app_preflight.py tests/test_ssh_bids_app.py -q
UV_CACHE_DIR=/tmp/neuravian-uv-cache uv run pytest -q
npm test -- --run
npm run build
docker compose up -d --build backend frontend
git diff --check
```

Results:

- Focused adapter/contract/cloud/preflight suite: **14 passed**
- Complete backend suite outside the browser sandbox: **744 passed, 10 skipped**
- Frontend: **459 passed**
- Frontend production build: **passed**
- Backend and frontend Docker builds: **passed**
- Rebuilt application API and launch UI: **verified**

## Missing qualification artifacts

There are no completed-run logs, provenance JSON, generated methods, HTML
report, output checksums, or scientific artifact tree for fMRIPrep because no
scientific run completed. Producing synthetic versions and labeling them as
qualification evidence would be misleading.

## Required release qualification

Before calling this pipeline release-ready, execute the exact manifest on a
native Linux x86_64 host with at least 16 GB RAM and a valid FreeSurfer license,
then verify participant completion, cancellation, retry, remote execution,
synchronization, report access, discovered outputs, checksums, provenance,
methods, and citations. Until that occurs, the integration may ship only as
**available but not execution-qualified**.
