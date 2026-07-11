# NeuroForge

A local-first neuroimaging workflow platform that wraps established tools — dcm2bids, BIDS Validator, MRIQC, FastSurfer, BrainChop, SynthStrip, and Nilearn — into a guided web interface with reproducible run records, artifact-based pipeline chaining, and plain-English error explanations.

---

## Why NeuroForge Exists

Neuroimaging research depends on a collection of powerful but difficult tools. Each one has its own installation path, command-line interface, input conventions, and failure modes. Getting from raw DICOM files to a connectivity matrix means knowing how to install FSL, set up a FreeSurfer license, format a dataset into BIDS, run fMRIPrep on a cluster, copy output files to the right place, and then run Nilearn with the right atlas parameters — none of which communicates with any other step.

Researchers — especially students and those new to neuroimaging — spend substantial time on this coordination work rather than on the scientific questions they are trying to answer.

NeuroForge addresses this by acting as a coordination layer above the existing tools. It does not replace fMRIPrep, MRIQC, or Nilearn. It:

- provides a consistent local interface for launching and monitoring runs
- expresses what each tool accepts, produces, and requires in machine-readable manifests
- chains outputs from one tool directly into the inputs of the next
- logs every command, parameter, version, input, and output in a provenance record
- classifies errors and provides plain-English explanations of what failed and what to try

The current version runs locally on macOS with Docker Compose and targets small research datasets and individual researchers. Remote execution and HPC scheduling are planned but not yet implemented.

---

## What Problems It Solves

**Coordination overhead.** Running BIDS Validator before MRIQC before fMRIPrep requires manually tracking which output goes where, which dataset was validated, and which preprocessing settings were used. NeuroForge handles this with artifact-typed outputs that are automatically surfaced as valid inputs for compatible next steps.

**Reproducibility gaps.** Most neuroimaging workflows are conducted by running commands in a terminal with no persistent record. NeuroForge records every run with its pipeline version, full command, parameters, container image digest, input artifacts, output artifacts, start time, end time, and status — and keeps this audit trail in a local SQLite database.

**Opaque errors.** Neuroimaging tools produce errors that require substantial experience to interpret. A raw `recon-all exited with code 1` is unhelpful to a student. NeuroForge translates known error patterns into plain-English explanations with suggested remediation steps.

**Workflow tracking.** Research workflows accumulate dozens of runs across multiple tools and datasets. NeuroForge provides a unified run list, status tracking, queue management, and the ability to cancel, retry, re-run, or delete runs without leaving the interface.

**Comparison difficulty.** Comparing BrainChop and SynthStrip skull-strips, or comparing connectivity matrices across subjects or preprocessing parameters, normally requires custom Python scripts. NeuroForge's Comparison Studio provides side-by-side visualization, Dice coefficients, Frobenius norms, and difference heatmaps without any additional code.

---

## What Makes It Different

NeuroForge is not a pipeline runner that happens to have a web UI. Several design decisions distinguish it from existing tools:

**Manifest-driven, not hardcoded.** Every pipeline is defined entirely in a YAML manifest in `pipelines/`. The backend has no hardcoded knowledge of what MRIQC accepts or what fMRIPrep produces. Manifests declare typed parameters, accepted artifact types, produced artifact types, compute profiles, container images or native entry points, and known error patterns. Adding a new tool means writing a manifest, not modifying application code.

**Artifact-typed chaining.** Runs emit typed artifacts (`bids_dataset_validated`, `skull_stripped_t1`, `fmriprep_derivatives`, `connectivity_matrix_csv`). The compatibility API queries artifact types to surface valid next steps without any hardcoded pipeline relationships. A Functional Connectivity run knows it needs `fmriprep_derivatives` input; an MRIQC Group run knows it needs `mriqc_report` input — because the manifests say so.

**Lineage-aware comparison.** Every run carries a `source_run_id` that links it to the upstream run it was derived from. The Comparison Studio uses this lineage to classify comparisons as *same-source* (shared upstream BOLD file — a true methodological comparison) or *unverified* (same dataset, no shared lineage — possibly different subjects or sessions). This distinction matters scientifically and is surfaced clearly in the UI.

**Execution queue with recovery.** A lightweight in-process queue runs one heavy job at a time. Queued runs can be cancelled before they start. Running jobs can be cancelled by stopping the Docker container or native process. If the backend restarts during a run, orphaned jobs are detected at startup and marked *interrupted* rather than *failed*, with a Retry button available immediately.

**Methods Studio.** Completed runs can be assembled into a draft methods paragraph that names tools, versions, atlases, and parameters in the format expected by a methods section. This is not AI-generated — it uses the provenance records directly to fill a structured template.

**Analysis Graph.** Every dataset has an analysis graph that visualizes all runs and their artifact dependencies as a directed graph. Clicking any node opens its run detail. This makes the full history of a dataset's processing visible without navigating individual run pages.

**Local-first.** NeuroForge is designed to run on a researcher's laptop without any cloud account, API key, or internet connection (after initial Docker image pulls). Data never leaves the machine unless the user explicitly chooses to send it somewhere.

---

## Current Capabilities

### Conversion

| Tool | What it does | Execution | Compute profile | Status |
|------|-------------|-----------|-----------------|--------|
| dcm2niix | DICOM → NIfTI conversion | Docker (`local-ok`) | `local-ok` | ✓ Verified |
| dcm2bids | DICOM → BIDS dataset via dcm2niix | Docker (`local-ok`) | `local-ok` | ✓ Verified |

The DICOM Wizard provides a guided multi-step interface: scout DICOM series → preview BIDS entity mappings → generate a dcm2bids configuration → launch conversion → auto-register the BIDS output as a new dataset.

### Validation

| Tool | What it does | Execution | Status |
|------|-------------|-----------|--------|
| BIDS Validator | Validates BIDS folder structure and metadata | Docker (`local-ok`) | ✓ Verified |

Validation results appear inline with file-level error and warning detail.

### Quality Control

| Tool | What it does | Execution | Status |
|------|-------------|-----------|--------|
| MRIQC | Per-subject IQM metrics and HTML reports for T1w, T2w, BOLD | Docker (`local-ok`) | ✓ Verified |
| MRIQC Group | Aggregates MRIQC metrics across subjects | Docker (`local-ok`) | ✓ Verified |

### Skull Stripping

| Tool | What it does | Execution | Status |
|------|-------------|-----------|--------|
| BrainChop (MindGrab) | CNN skull-strip; ~21 s on Apple Silicon M-series | Native subprocess | ✓ Verified |
| SynthStrip | FreeSurfer-team skull-strip; any-contrast MRI | Docker (`linux/amd64`) | ⚠ Implemented, slow on Apple Silicon (5–15 min via Rosetta 2) |

### Segmentation

| Tool | What it does | Execution | Status |
|------|-------------|-----------|--------|
| FastSurfer | Deep-learning cortical segmentation and surface reconstruction | Docker (`linux/amd64`) | ⚠ Implemented, slow on Apple Silicon; requires `HOST_UID`/`HOST_GID` |

### Preprocessing

| Tool | What it does | Execution | Status |
|------|-------------|-----------|--------|
| Import fMRIPrep Derivatives | Registers pre-computed fMRIPrep output without re-running | Native | ✓ Verified |
| fMRIPrep | Full fMRI preprocessing pipeline | Docker (`linux/amd64`) | ✗ Manifest exists; not locally safe; use Import instead |

fMRIPrep is not expected to run safely or quickly on a development laptop. The supported local path is to run fMRIPrep on a server or cluster and then import the output directory using the Import fMRIPrep Derivatives pipeline.

### Connectivity

| Tool | What it does | Execution | Status |
|------|-------------|-----------|--------|
| Functional Connectivity | Atlas-based Pearson correlation matrix from fMRIPrep BOLD | Native (Nilearn) | ✓ Verified |

Functional Connectivity requires an Import fMRIPrep Derivatives run as its source. It cannot run fMRIPrep itself. Outputs: connectivity matrix (CSV, NPY), heatmap (PNG), per-ROI statistics (CSV, JSON), time series (TSV), metadata (JSON), and an HTML report.

**Supported atlases:** Schaefer 2018 100-parcel 7-network (default), Schaefer 2018 200-parcel 7-network, AAL 3v2, Harvard-Oxford cortical.

### De-identification

| Tool | What it does | Execution | Status |
|------|-------------|-----------|--------|
| pydeface | Removes facial features from structural NIfTI | Docker (`local-unsafe`) | ✗ Not locally safe; resource-intensive |

### Workflow Management

| Feature | Description |
|---------|-------------|
| Workflow Builder | Visual linear pipeline builder; chains compatible tools based on artifact types |
| Workflow Library | Save, load, export, and import named workflows as JSON |
| Workflow Templates | Pre-defined starting templates (BIDS+QC, fMRI preprocessing, connectivity, skull-strip+segment) |
| Execution Queue | Lightweight in-process queue; one heavy job at a time; position displayed in UI |
| Run Actions | Cancel, Retry, Re-run, Duplicate, Delete from the Runs page and Run Results view |

### Analysis and Visualization

| Feature | Description |
|---------|-------------|
| Analysis Graph | Directed graph of all runs and artifact dependencies for a dataset |
| Artifact Explorer | Browse, preview, and download all artifacts produced by runs on a dataset |
| Comparison Studio | Side-by-side run comparison: skull-strip masks (Dice) or connectivity matrices (Frobenius norm, difference heatmap) |
| ROI Statistics Explorer | Per-ROI voxel counts and time-series statistics from Functional Connectivity runs; searchable, sortable, filterable by network |
| Region Explorer | Sidebar panel showing per-ROI summary stats and strongest connectivity partners |
| Dataset Dashboard | Subject/session/modality overview, run history, and quick-launch links |

### Documentation and Reproducibility

| Feature | Description |
|---------|-------------|
| Methods Studio | Assembles a draft methods paragraph from provenance records; names tools, versions, atlases, parameters |
| Provenance records | Every run records pipeline ID, version, command, parameters, container image, inputs, outputs, timestamps |
| Run lineage | `source_run_id` links downstream runs to their upstream source for verified comparison |

---

## Workflow Examples

### DICOM → BIDS → QC

```
DICOM folder
  └─ dcm2bids (DICOM Wizard)
       └─ BIDS Validator
            └─ MRIQC
                 └─ MRIQC Group Report
```

1. Register a DICOM source folder as a dataset.
2. Open the DICOM Wizard → scout series → generate config → launch dcm2bids.
3. The BIDS output is auto-registered as a new dataset.
4. Run BIDS Validator on the new dataset.
5. Run MRIQC when the dataset is valid.
6. Run MRIQC Group Report to aggregate IQM metrics across subjects.

### Skull-strip and segmentation comparison

```
NIfTI (from dcm2niix or existing)
  ├─ BrainChop  →  FastSurfer
  └─ SynthStrip →  FastSurfer
```

Use the Comparison Studio to compare BrainChop and SynthStrip outputs side-by-side with a Dice coefficient and NIfTI viewer.

### Functional connectivity from fMRIPrep derivatives

```
fMRIPrep output directory (pre-computed)
  └─ Import fMRIPrep Derivatives
       └─ Functional Connectivity (Schaefer 100-ROI)
       └─ Functional Connectivity (AAL 166-ROI)
```

Run Functional Connectivity with different atlas settings. Use the Comparison Studio to compare connectivity matrices with a Frobenius norm and difference heatmap. Use the ROI Statistics Explorer to inspect per-ROI voxel counts and signal statistics.

---

## Architecture

```
Docker Compose
├── nginx  (port 3000)   — serves React build; proxies /api to backend
└── backend (port 8000)  — FastAPI + SQLAlchemy + SQLite + Alembic
     ├── Pipeline registry  — loads YAML manifests from /pipelines at startup
     ├── Artifact registry  — resolves artifact types from manifest produces[] declarations
     ├── Execution queue    — asyncio in-process queue; one heavy job at a time
     ├── Native executor    — subprocess-based execution for Python tools
     ├── Docker executor    — Docker SDK-based execution for containerized tools
     └── Stalled-run detector — periodic check; marks orphaned runs as interrupted
```

### Pipeline registry

Every pipeline is defined by a YAML manifest in `pipelines/`. Manifests declare:

- `id` — stable identifier used in all run records
- `execution.type` — `native` (subprocess) or `docker` (Docker SDK)
- `execution.command` or `container` — the command or image to run
- `compute_profile` — `local-ok`, `local-slow`, or `local-unsafe`
- `accepts[]` — artifact types this pipeline accepts as input, with parameter mapping
- `produces[]` — artifact types this pipeline emits, with filename hints
- `parameters[]` — typed parameter declarations with defaults and validation
- `known_errors[]` — regex patterns matched against stderr for error translation

The backend reads all manifests at startup. No pipeline logic is hardcoded in application code.

### Artifact registry

Artifact types are defined in `pipelines/schema/artifact_types.yaml`. Each type has a stable slug, label, description, and expected file extensions. The compatibility API (`GET /api/pipelines/compatible?artifact_type=X`) queries this registry to return pipelines that accept a given artifact type, enabling the UI to surface valid next steps without any hardcoded relationships.

### Execution queue

A module-level asyncio queue (`backend/app/services/execution_queue.py`) processes runs sequentially. One heavy job runs at a time. New runs are appended; the processor pops from the front. Cancel requests set a `cancel_requested` flag on the database row, which the processor checks before dispatch and the executor checks before writing the final status.

A separate stalled-run checker runs every two minutes. If the database shows `status=running` for a run that the processor is not currently executing, the run is marked `interrupted` with a Retry option — distinguishing an uncontrolled shutdown from an intentional failure.

### Provenance and lineage

Every run record stores: pipeline ID and version, full command, parameters JSON, container image digest (when applicable), input artifact paths, output directory, start and end timestamps, exit code, status, resource warnings, and a structured audit trail of `ProvenanceEvent` rows. The `source_run_id` field links a run to the upstream run it was derived from, enabling the Analysis Graph and Comparison Studio to reconstruct processing histories.

---

## Known Limitations

**Apple Silicon — per-pipeline emulation status.** Pipelines using `linux/amd64` Docker images run through Rosetta 2 emulation on Apple Silicon. Empirical statuses differ by pipeline:

- **SynthStrip**: locally verified and functional; slow under emulation (5–15 min per subject).
- **FastSurfer**: runs locally (`local-slow`); full performance benchmarking pending — expect runtimes significantly longer than on native x86_64.
- **fMRIPrep**: `local-unsafe` — ANTs non-linear registration under Rosetta 2 / QEMU produces unreliable results and causes excessive memory consumption on laptop hardware. Use Import fMRIPrep Derivatives instead.
- **pydeface**: `local-unsafe` / unverified — FLIRT-based registration under Rosetta 2 has not been validated to produce correct defacing masks.

`local-ok` pipelines (MRIQC, dcm2bids, BrainChop, Functional Connectivity) run natively on Apple Silicon and are not affected by emulation.

**No remote or HPC execution yet.** All execution is local Docker or native subprocess. Remote SSH execution infrastructure exists in the codebase (`RemoteHosts` settings page, SSH executor module) but is not yet connected to the run creation flow. When remote execution is implemented, it will dispatch only to infrastructure explicitly configured and controlled by the researcher (SSH targets, SLURM clusters, or self-hosted compute nodes) — NeuroForge will not route data through any third-party cloud service automatically.

**Workflow execution state is session-bound.** Named workflows are backend-persisted through the Workflow Library: they are stored in SQLite, managed through a CRUD API, and support JSON import/export, schema versioning, and template promotion — all of which survive page reloads and browser restarts. However, *active workflow execution* — the currently running sequence of steps — is held in frontend state. If the page is closed while a workflow is executing, the execution sequence is lost. Individual run records for steps that completed before the page closed persist in the database and can be viewed in the Runs page.

**No multi-user support.** NeuroForge is a single-user local application. There is no authentication, role-based access, or collaboration feature.

**Planned pipelines not yet implemented:**

| Pipeline | Status |
|----------|--------|
| XCP-D (post-processing) | Planned |
| QSIPrep (diffusion preprocessing) | Planned |
| MRtrix3 (tractography) | Planned |
| Seed-based connectivity | Planned |
| Structural connectomics | Planned |
| Group-level statistics | Planned |

---

## Local Setup

### Requirements

- Docker Desktop (8 GB memory allocation recommended)
- Git

### Quick start

```bash
git clone https://github.com/SadhanaArivoli/neuroforge.git
cd neuroforge
cp .env.example .env   # edit HOST_DATASETS_DIR to your datasets folder
docker compose up
```

Open:
- UI: `http://localhost:3000`
- API docs: `http://localhost:8000/docs`

### Environment variables

```dotenv
# Path on your host machine mounted read-only at /host-data inside the backend container
HOST_DATASETS_DIR=/Users/yourname/Documents

# Required for pipelines that write files with host file ownership (e.g. FastSurfer)
HOST_UID=
HOST_GID=
```

```bash
export HOST_UID=$(id -u)
export HOST_GID=$(id -g)
```

### Development

Backend (Python 3.12, uv):

```bash
cd backend
uv sync --extra dev
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
```

Frontend (Node, Vite):

```bash
cd frontend
npm install
npm run dev   # http://localhost:5173
```

### Tests

```bash
# Backend
cd backend && uv run pytest

# Frontend
cd frontend && npm test && npm run build
```

GitHub Actions runs backend pytest, frontend type-checking, and frontend tests on every push.

### Deploy frontend to Docker

After editing frontend source:

```bash
cd frontend
npm run build
docker exec neuroforge-frontend-1 rm -rf /usr/share/nginx/html/assets
docker cp dist/. neuroforge-frontend-1:/usr/share/nginx/html/
docker exec neuroforge-frontend-1 nginx -s reload
```

---

## Repository Structure

```
neuroforge/
├── backend/
│   ├── app/
│   │   ├── api/           — FastAPI route handlers
│   │   ├── core/          — database, settings, path utilities
│   │   ├── execution/     — Docker executor, native executor, SSH executor
│   │   ├── models/        — SQLAlchemy ORM models
│   │   ├── services/      — run service, pipeline service, execution queue
│   │   └── tools/         — native Python pipeline entry points
│   ├── alembic/           — database migration versions
│   ├── data/              — SQLite database, derivatives, fixtures
│   └── tests/
├── frontend/
│   └── src/
│       ├── api/           — API client and type definitions
│       ├── components/    — shared primitives and domain components
│       ├── hooks/         — data-fetching hooks
│       ├── lib/           — pure logic (methods engine, workflow persistence, etc.)
│       └── pages/         — one file per route
├── pipelines/
│   ├── schema/            — artifact_types.yaml, manifest.schema.json
│   └── *.yaml             — one manifest per pipeline
└── docker-compose.yml
```

---

## Architecture Document

See [`docs/architecture/neuroimaging-platform-architecture.md`](docs/architecture/neuroimaging-platform-architecture.md) for the original architecture plan, data model, and development roadmap that informed the initial implementation.
