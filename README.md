# NeuroForge

NeuroForge is a local-first neuroimaging workflow workbench that wraps established tools — dcm2bids, BIDS Validator, MRIQC, FastSurfer, fMRIPrep, and others — with a guided web UI, reproducible run records, artifact-based pipeline chaining, and beginner-friendly error explanations.

## Why NeuroForge Exists

Neuroimaging tools are individually powerful but collectively difficult: each has its own installation path, command-line interface, input expectations, and failure mode. NeuroForge does not replace these tools. It wraps them with:

- a consistent local interface for launching and monitoring runs
- manifest-driven pipeline metadata that expresses what each tool accepts, produces, and requires
- artifact-based chaining so outputs from one tool flow cleanly into the next
- provenance records that log every command, parameter, version, input, and output
- beginner-friendly error summaries that explain what failed and what to try next

The current focus is local execution for research workflows on macOS with Apple Silicon, with Docker Compose as the delivery mechanism.

## Architecture

```
Docker Compose
├── nginx  (port 3000)  — reverse-proxy; serves frontend build, proxies /api
├── frontend            — React + TypeScript + Vite, Tailwind CSS
└── backend             — FastAPI + SQLAlchemy + SQLite + Alembic
```

**Manifest-driven pipeline registry** — every pipeline is defined by a YAML manifest in `pipelines/`. Manifests declare typed parameters, accepted artifact types, produced artifact types, compute profiles, container images or native commands, and known errors. The backend loads manifests at startup; no hardcoded pipeline logic lives in application code.

**Artifact registry** — runs emit typed artifacts (e.g. `bids_dataset_validated`, `skull_stripped_t1`, `connectivity_matrix_csv`). The compatibility API (`/api/pipelines/compatible`) queries artifact types to surface valid next steps without hardcoded pipeline relationships.

**Workflow chaining** — the Workflow Builder constructs a linear node graph from compatible artifact types. Each node references a pipeline ID and parameters; the executor runs nodes sequentially and stops on failure.

**Provenance and lineage** — every run records pipeline ID, version, command, parameters, container image (if any), input artifacts, output artifacts, start time, end time, status, and warnings. The `source_run_id` field links downstream runs back to their upstream source, enabling the Pipeline Comparison Studio to classify comparisons as verified (shared source) or unverified (same dataset, unknown lineage).

**Local storage** — SQLite database managed by Alembic migrations. No cloud database or external service required.

## Current Capabilities

### DICOM Wizard
Interactive multi-step wizard at `/dicom-wizard`. Scouts DICOM series, previews suggested BIDS mappings, generates a `dcm2bids` configuration, launches dcm2bids, and auto-registers successful outputs as a new BIDS dataset.

### dcm2bids
Converts mapped DICOM series into a BIDS dataset. Integrated with the DICOM Wizard; also runnable standalone via the Pipelines page.

### BIDS Validator
Validates BIDS folder structure and metadata. Run before MRIQC or fMRIPrep. A failed status means the dataset has BIDS issues — the error summary explains which files are affected.

### MRIQC
Generates MRI quality-control metrics and HTML reports for T1w, T2w, and BOLD images. Intended as the recommended local QC step after BIDS validation.

### MRIQC Group Report
Aggregates individual MRIQC metrics across subjects into a group-level HTML report. Accepts a completed MRIQC run as input.

### BrainChop (MindGrab skull-strip)
Skull-strips structural NIfTI images using a browser-side neural network via native subprocess. Runs without Docker. Fast on Apple Silicon (~21 s on M-series hardware with no emulation).

### SynthStrip
FreeSurfer-team skull-stripping CNN that works on any-contrast MRI (T1w, T2w, FLAIR, DWI b0). Runs via Docker with the linux/amd64 image. Slow on Apple Silicon via Rosetta 2 (5–15 min); marked `local-slow`.

### FastSurfer
Deep-learning cortical segmentation and surface reconstruction. Runs via Docker. Marked `local-slow`; may require substantial runtime plus `HOST_UID`/`HOST_GID` environment variables for correct file ownership.

### pydeface
Defacing for structural MRI to support data sharing. Runs via Docker; marked `local-unsafe` and not recommended for ordinary laptop execution due to resource requirements.

### fMRIPrep
Full fMRI preprocessing pipeline. Manifest exists; marked `local-unsafe`. Not recommended for local laptop use. Does not run safely or quickly on a development machine. Import fMRIPrep derivatives instead (see below).

### Import fMRIPrep Derivatives
Imports pre-computed fMRIPrep derivatives into NeuroForge's artifact registry without re-running the pipeline. This is the supported local path for accessing preprocessed BOLD data when fMRIPrep was run elsewhere.

### Functional Connectivity
Computes Pearson correlation matrices from fMRIPrep-preprocessed BOLD data. Requires an Import fMRIPrep Derivatives run as its source. Outputs a connectivity matrix (`.npy`, `.csv`, heatmap `.png`) and an HTML report. Uses the Schaefer 2018 atlas (100 ROIs, 7 networks) by default.

**Important:** Functional Connectivity cannot run without precomputed fMRIPrep derivatives. It reads pre-processed BOLD files from an fMRIPrep output directory.

### Workflow Builder
Visual linear pipeline builder at `/workflows/new`. Starts from a registered dataset or a completed run. Adds compatible next steps based on artifact types. Runs nodes sequentially; stops on failure. Links completed and failed nodes to their run detail pages.

V1 does not support DAGs, parallel execution, saved templates, backend workflow storage, drag-and-drop editing, or cloud/HPC scheduling.

### Workflow Templates
Pre-defined linear workflow templates available in the Workflow Builder. Current templates:

| Template | Steps |
|---|---|
| BIDS Validation + QC | BIDS Validator → MRIQC → MRIQC Group Report |
| fMRI Preprocessing | BIDS Validator → fMRIPrep |
| Functional Connectivity Analysis | Import fMRIPrep Derivatives → Functional Connectivity |
| NIfTI De-identification | dcm2niix → pydeface |
| Skull Strip + Segmentation | BrainChop → FastSurfer |
| SynthStrip + Segmentation | SynthStrip → FastSurfer |

### Pipeline Comparison Studio
Side-by-side comparison of two pipeline runs at `/compare`. Supports two comparison families:

- **Anatomical** — compares skull-stripped masks from different pipelines (e.g. BrainChop vs SynthStrip). Shows linked NIfTI viewers, geometry table, Dice coefficient, and artifact metadata diff.
- **Connectivity** — compares functional connectivity matrices from two runs. Shows side-by-side heatmaps, difference heatmap, Frobenius norm, and per-run metadata. Classifies comparisons as same-source (identical upstream BOLD file) or cross-subject.

Eligibility is classified as verified (shared `source_run_id`), unverified (same dataset, no lineage), or ineligible (different datasets).

## Pipeline Status

| Pipeline | Category | Compute profile | Local verification | Notes |
|---|---|---|---|---|
| dcm2bids | Conversion | `local-ok` | ✓ Verified | Integrated with DICOM Wizard; auto-registers BIDS output |
| dcm2niix | Conversion | `local-ok` | ✓ Verified | Lightweight DICOM → NIfTI conversion |
| BIDS Validator | Validation | `local-ok` | ✓ Verified | Recommended before MRIQC or fMRIPrep |
| MRIQC | Quality control | `local-ok` | ✓ Verified | Individual-subject QC; produces IQM metrics and HTML reports |
| MRIQC Group Report | Quality control | `local-ok` | ✓ Verified | Aggregates MRIQC metrics across subjects |
| BrainChop | Segmentation | `local-ok` | ✓ Verified | Native; ~21 s on Apple Silicon; no Docker required |
| Import fMRIPrep Derivatives | Preprocessing | `local-ok` | ✓ Verified | Registers pre-computed fMRIPrep output; required for Functional Connectivity |
| Functional Connectivity | Connectivity | `local-ok` | ✓ Verified | Requires fMRIPrep derivatives; Schaefer 100-ROI atlas; ~4–6 s |
| SynthStrip | Segmentation | `local-slow` | ⚠ Implemented | linux/amd64 image; 5–15 min via Rosetta 2 on Apple Silicon |
| FastSurfer | Segmentation | `local-slow` | ⚠ Implemented | Heavy runtime; requires `HOST_UID`/`HOST_GID` setup |
| pydeface | De-identification | `local-unsafe` | ✗ Not locally safe | Manifest exists; not recommended for laptop use |
| fMRIPrep | Preprocessing | `local-unsafe` | ✗ Not locally safe | Manifest exists; not recommended for laptop use; use Import instead |

### Compute profiles

| Profile | Meaning |
|---|---|
| `local-ok` | Expected to run on a local development machine for small test datasets |
| `local-slow` | Runs locally but may be very slow or require extra resource setup |
| `local-unsafe` | Manifest exists; not recommended for local execution; may be too heavy or fragile for a laptop |

These labels are UI guidance only. They do not provide scheduling, resource limiting, or cloud execution.

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
3. Auto-register the BIDS output.
4. Run BIDS Validator on the registered dataset.
5. Run MRIQC when the dataset is valid.
6. Run MRIQC Group Report to aggregate metrics across subjects.

### Structural skull-stripping and segmentation

```
NIfTI (from dcm2niix or existing)
  ├─ BrainChop  →  FastSurfer
  └─ SynthStrip →  FastSurfer
```

Use the Pipeline Comparison Studio to compare BrainChop and SynthStrip outputs side-by-side with Dice coefficient.

### Functional connectivity from fMRIPrep derivatives

```
fMRIPrep output directory (pre-computed)
  └─ Import fMRIPrep Derivatives
       └─ Functional Connectivity
```

Run Functional Connectivity multiple times (different subjects, tasks, or atlas settings) and use the Comparison Studio to compare connectivity matrices with Frobenius norm and difference heatmaps.

## Apple Silicon Limitations

NeuroForge is developed on Apple Silicon (M-series) and most `local-ok` pipelines run natively or through ARM Docker images without emulation.

The following pipelines use linux/amd64 images and run through Rosetta 2 emulation on Apple Silicon, which is significantly slower:

- **SynthStrip** — 5–15 min per volume (vs. < 1 min on x86)
- **FastSurfer** — substantially slower; plan for extended runtimes
- **pydeface** and **fMRIPrep** — not locally safe regardless of architecture

There is no multi-user mode, HPC scheduler, or cloud execution path in the current version.

## Local Setup

### Requirements

- Docker Desktop (with at least 8 GB memory allocation recommended)
- Git

### Quick start

```bash
git clone https://github.com/SadhanaArivoli/neuroforge.git
cd neuroforge
cp .env.example .env   # edit HOST_DATASETS_DIR if needed
docker compose up
```

Open:
- UI: `http://localhost:3000`
- API docs: `http://localhost:8000/docs`

### Environment

```dotenv
# Path to datasets on your host machine (mounted read-only at /host-data)
HOST_DATASETS_DIR=/Users/yourname/Documents

# Required for tools that enforce file ownership (e.g. FastSurfer)
HOST_UID=
HOST_GID=
```

```bash
export HOST_UID=$(id -u)
export HOST_GID=$(id -g)
```

### Development

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
npm run dev   # Vite dev server at http://localhost:5173
```

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

GitHub Actions runs backend pytest plus frontend type-checking and tests on every push.

## Current Limitations

- NeuroForge is a local research tool, not a clinical application. Outputs are not medically validated.
- No cloud execution, HPC scheduler, multi-user collaboration, or role-based permissions.
- Workflow Builder V1 is frontend-only and executes nodes linearly; no DAGs, parallel execution, saved backend templates, or drag-and-drop editing.
- fMRIPrep and pydeface manifests exist but are marked `local-unsafe` and should not be treated as laptop-safe workflows.
- FastSurfer and SynthStrip are `local-slow` and may require extended runtimes on Apple Silicon.
- Functional Connectivity requires pre-computed fMRIPrep derivatives — it cannot run fMRIPrep itself.
- Error explanations are human-readable summaries, not exhaustive scientific or clinical validation.
- No screenshots or end-user tutorial are committed yet.
- Pipeline support depends on local Docker availability and the external tool images or native commands being accessible.

## Roadmap

Near-term:

- Screenshots and a short demo workflow guide.
- Improved dataset and run documentation for new users.
- Expanded end-to-end verification for dcm2bids, BIDS Validator, MRIQC, and Functional Connectivity.
- More focused frontend tests for the Workflow Builder.
- Improved friendly error explanations and recovery steps.

Later:

- Backend workflow run records and saved templates.
- Richer artifact browser and result viewers.
- Provenance export for methods sections.
- Optional Docker image management and setup checks.
- Cloud or HPC execution design after the local foundation is stable.

## Architecture Document

See [`docs/architecture/neuroimaging-platform-architecture.md`](docs/architecture/neuroimaging-platform-architecture.md) for the broader architecture plan, schema direction, plugin/manifest design, and development roadmap.
