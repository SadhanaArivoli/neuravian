# NeuroForge

NeuroForge is a local-first neuroimaging workflow workbench that helps users import datasets, run manifest-driven pipelines, inspect results, and chain compatible outputs without leaving a guided web UI.

## Why NeuroForge Exists

Neuroimaging tools are powerful, but they are often hard to install, configure, connect, and debug. NeuroForge does not replace tools such as dcm2bids, BIDS Validator, MRIQC, fMRIPrep, FastSurfer, or pydeface. It wraps them with a clearer local interface, reproducible run records, safer path handling, and beginner-friendly workflow guidance.

The current focus is local execution for research workflows: dataset registration, BIDS validation, DICOM-to-BIDS conversion, QC, run provenance, artifact compatibility, and simple pipeline chaining.

## Core Features

- Local web UI with FastAPI backend, React frontend, SQLite storage, and Docker Compose setup.
- Dataset registration for BIDS datasets and DICOM source folders.
- Dataset indexing for subjects, sessions, datatypes, tasks, suffixes, and validation status.
- BIDS validation with friendly issue summaries and raw validator access.
- Manifest-driven pipeline registry with typed parameters, inputs, outputs, known errors, artifact types, and compute profiles.
- Guided dcm2bids wizard for scouting DICOM series, generating mapping config, launching dcm2bids, and auto-registering successful BIDS outputs as datasets.
- Pipeline execution through Docker containers or native backend subprocesses, depending on the manifest.
- Run detail pages with status, logs, command preview, provenance, result files, metadata, and lineage.
- "Run Next" compatibility flow based on produced and accepted artifact types.
- Visual Workflow Builder V1 for a frontend-only, linear workflow chain.

## Supported Pipelines

Pipeline support is defined by YAML manifests in `pipelines/`. Relationships are not hardcoded; compatibility is derived from each pipeline's declared `accepts` and `produces` artifact types.

| Pipeline | Purpose | Input | Execution | Compute profile | Current notes |
|---|---|---|---|---|---|
| dcm2bids | Convert mapped DICOM series into a BIDS dataset | DICOM directory plus dcm2bids config | Docker | `local-ok` | Integrated with the DICOM Mapping Wizard; successful outputs can auto-register as datasets. |
| dcm2niix | Convert raw DICOMs to NIfTI/BIDS-like outputs | DICOM directory | Docker | `local-ok` | Lightweight conversion path for NIfTI-oriented workflows. |
| BIDS Validator | Validate BIDS structure and metadata | BIDS dataset | Docker | `local-ok` | Recommended before MRIQC or fMRIPrep; failed run status can simply mean the dataset has BIDS errors. |
| MRIQC | Generate MRI quality-control metrics and reports | BIDS dataset | Docker | `local-ok` | Intended local QC path after BIDS validation. |
| BrainChop (MindGrab skull-strip) | Skull-strip structural NIfTI images | Structural NIfTI | Native subprocess | `local-ok` | Runs through the native executor rather than a Docker pipeline container. 21 s on Apple Silicon (no emulation). |
| SynthStrip | Skull-strip any-contrast MRI (T1w, T2w, FLAIR, DWI b0, etc.) | Structural NIfTI | Docker | `local-slow` | FreeSurfer-team 3D CNN. linux/amd64 image; 5–15 min on Apple Silicon via Rosetta 2 emulation. |
| FastSurfer | Segmentation and surface reconstruction | T1w NIfTI | Docker | `local-slow` | Can run locally, but expect substantial runtime; requires host UID/GID setup. |
| fMRIPrep | fMRI preprocessing derivatives and reports | BIDS dataset | Docker | `local-unsafe` | Manifest exists, but this is not considered locally safe for ordinary laptop use. |
| pydeface | Deface structural MRI for data sharing | Structural NIfTI | Docker | `local-unsafe` | Manifest exists, but this is not considered locally safe yet. |

## Compute Profiles

Compute profiles are manifest metadata used by the UI to set expectations before a run:

| Profile | Meaning |
|---|---|
| `local-ok` | Expected to run reasonably on a local development machine for small test data. |
| `local-slow` | Can run locally, but may take a long time or need extra setup/resources. |
| `local-unsafe` | Available as a manifest, but not recommended for local execution yet; may be too heavy, fragile, or unsafe for a laptop workflow. |

These labels do not provide scheduling or cloud execution. They are warnings and UI guidance only.

## DICOM -> BIDS -> QC Workflow

A typical current workflow is:

1. Register or select a DICOM source folder.
2. Open the DICOM Mapping Wizard.
3. Scout DICOM series and review suggested BIDS mappings.
4. Generate the dcm2bids config and launch dcm2bids.
5. Let NeuroForge auto-register the successful dcm2bids output as a dataset.
6. Run BIDS Validator on the registered BIDS dataset.
7. Use Run Next or Workflow Builder V1 to continue to MRIQC when the dataset is valid.
8. Inspect run logs, metadata, provenance, result files, and lineage.

## Visual Workflow Builder V1

The Visual Workflow Builder is available at `/workflows/new`.

Current V1 behavior:

- Starts from an existing dataset or a completed run.
- Shows a simple horizontal node canvas.
- Adds compatible next steps through `/api/pipelines/compatible`.
- Uses manifest-declared artifact types rather than hardcoded pipeline relationships.
- Runs nodes sequentially, one at a time.
- Stops when a node fails.
- Links completed or failed nodes to their run detail pages.
- Uses registered dataset IDs from upstream run metadata when available.

V1 does not support saved templates, backend workflow tables, DAGs, drag/drop editing, parallel scheduling, cloud execution, or HPC execution.

## Screenshots

No screenshots are committed yet. Suggested README slots:

- `docs/screenshots/datasets.png` - dataset list and validation summary.
- `docs/screenshots/dicom-wizard.png` - DICOM Mapping Wizard review step.
- `docs/screenshots/run-detail.png` - run logs, metadata, and results.
- `docs/screenshots/workflow-builder.png` - Visual Workflow Builder V1 canvas.

## Local Setup

### Docker Compose

Requirements:

- Docker Desktop
- Git

```bash
git clone https://github.com/SadhanaArivoli/neuroforge.git
cd neuroforge
cp .env.example .env
```

Edit `.env`:

```bash
# Directory containing datasets you want NeuroForge to read.
HOST_DATASETS_DIR=/Users/yourname/Documents

# Recommended for tools that need host file ownership, such as FastSurfer.
HOST_UID=
HOST_GID=
```

For `HOST_UID` and `HOST_GID`, add these to your shell profile or export them before running Compose:

```bash
export HOST_UID=$(id -u)
export HOST_GID=$(id -g)
```

Start the app:

```bash
docker compose up
```

Open:

- Frontend: `http://localhost:3000`
- Backend API docs: `http://localhost:8000/docs`

Datasets under `HOST_DATASETS_DIR` are mounted read-only at `/host-data`; NeuroForge translates normal host paths entered in the UI.

### Local Development

Backend:

```bash
cd backend
uv sync --extra dev
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server runs at `http://localhost:5173` and proxies API requests to the backend.

### Tests

Backend:

```bash
cd backend
uv run pytest
```

Frontend:

```bash
cd frontend
npm test
npm run build
```

GitHub Actions currently runs backend pytest plus frontend type-checking and tests.

## Current Limitations

- NeuroForge is a local research tool, not a clinical application.
- No cloud execution, HPC scheduler, multi-user collaboration, or role-based permissions.
- Workflow Builder V1 is frontend-only and linear; no saved templates, DAGs, or parallel execution.
- fMRIPrep and pydeface manifests exist, but they are marked `local-unsafe` and should not be treated as laptop-safe workflows.
- FastSurfer is marked `local-slow` and may require significant runtime plus host UID/GID setup.
- Pipeline support depends on local Docker availability and the external tool images or native commands.
- Error explanations are helpful summaries, not exhaustive scientific or clinical validation.
- Screenshots and end-user documentation are still incomplete.

## Roadmap

Near-term:

- Add committed screenshots and a short demo workflow guide.
- Improve dataset and run documentation for new users.
- Expand safe end-to-end verification around dcm2bids, BIDS Validator, and MRIQC.
- Add more focused frontend tests for Workflow Builder V1.
- Continue improving friendly error explanations and recovery steps.

Later:

- Saved workflow templates.
- Backend workflow run records.
- Richer artifact browser and result viewers.
- Better provenance export for methods sections.
- Optional Docker image management and setup checks.
- Cloud or HPC execution design after the local foundation is stable.

## Architecture

See [`docs/architecture/neuroimaging-platform-architecture.md`](docs/architecture/neuroimaging-platform-architecture.md) for the broader architecture plan, schema direction, plugin/manifest design, and development roadmap.
