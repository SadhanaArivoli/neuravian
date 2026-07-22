# Neuravian Architecture

This document describes the technical architecture of the Neuravian 0.1.0
Early Access release candidate. Pipeline availability and qualification are
tracked separately in [pipeline-status.md](pipeline-status.md).

---

## System Overview

Neuravian is a local-first web application. Everything runs on the researcher's machine inside Docker Compose. No data leaves the machine unless the researcher explicitly configures remote execution.

```mermaid
graph TB
    Browser["Browser\nhttp://localhost:3000"]

    subgraph Docker["Docker Compose"]
        FE["Frontend Container\nnginx + React SPA"]
        BE["Backend Container\nFastAPI + SQLite"]
        FE -->|"/api/** proxy"| BE
    end

    Browser --> FE

    subgraph Host["Host Machine (read-only mounts)"]
        DS[("~/datasets\n(BIDS data)")]
        PL[("pipelines/\n(YAML manifests)")]
        PG[("plugins/\n(plugin dirs)")]
    end

    BE -->|"read-only"| DS
    BE -->|"read-only"| PL
    BE -->|"read-only"| PG
    BE -->|"read-write"| DB[("data/\nSQLite + derivatives")]
    BE -->|"Docker socket"| Docker2["Sibling containers\n(MRIQC, FastSurfer, etc.)"]
```

---

## Backend

The backend is a FastAPI application (`backend/app/`) with SQLite persistence via SQLAlchemy and Alembic migrations.

### Startup sequence

```mermaid
sequenceDiagram
    participant L as FastAPI lifespan
    participant PL as plugin_loader
    participant PR as pipeline_registry
    participant AR as artifact_registry
    participant EQ as execution_queue

    L->>PL: load_all_plugins()
    PL->>PL: discover plugin dirs
    PL->>PL: validate plugin.yaml (JSON Schema)
    PL->>PR: register plugin pipeline manifests
    PL->>AR: register plugin artifact types
    L->>PR: seed_pipeline_registry(db)
    PR->>PR: load_all_manifests() (core + plugin)
    L->>EQ: start_processor()
    L->>L: recover_interrupted_runs()
```

Plugins are discovered before the pipeline registry is built so plugin pipelines appear in the registry on first request.

### Directory layout

```
backend/app/
├── api/           — FastAPI route handlers (one file per domain)
├── core/          — database session, settings, path utilities
├── execution/     — DockerExecutor, NativeExecutor, SSHExecutor
├── models/        — SQLAlchemy ORM models (Run, Artifact, Dataset, …)
├── services/      — PipelineService, RunService, ExecutionQueue, plugin_loader
└── tools/         — native Python pipeline entry points (Nilearn, nibabel, NetworkX)
```

### Execution model

```mermaid
flowchart LR
    API["POST /api/runs"] --> EQ["ExecutionQueue\n(asyncio queue)"]
    EQ --> |"one at a time"| Runner

    subgraph Runner
        NE["NativeExecutor\n(subprocess)\nPython tools"]
        DE["DockerExecutor\n(Docker SDK)\ncontainerized tools"]
    end

    Runner --> DB[("SQLite\nrun status, logs")]
    Runner --> FS[("data/derivatives/\nartifact files")]
```

The execution queue is sequential by design — one job at a time on a laptop. Future versions may add parallel lanes for tools that are CPU-light.

---

## Pipeline manifests

Every pipeline is declared in a YAML file in `pipelines/`. The backend loads all manifests at startup; no pipeline logic is hardcoded in application code.

```
pipelines/
├── schema/
│   ├── manifest.schema.json    — JSON Schema for pipeline YAML validation
│   ├── artifact_types.yaml     — global vocabulary of typed artifacts
│   └── plugin.schema.json      — JSON Schema for plugin.yaml validation
└── *.yaml                      — one file per pipeline (20 core pipelines)
```

A manifest declares:

| Field | Purpose |
|---|---|
| `id` | Stable identifier used in all run records |
| `display_name` | Human-readable name shown in the UI |
| `execution.type` | `native` (Python subprocess) or `docker` (Docker SDK) |
| `compute_profile` | `local-ok`, `local-slow`, or `local-unsafe` |
| `accepts[]` | Typed artifact slots this pipeline reads |
| `produces[]` | Typed artifact slots this pipeline writes |
| `parameters[]` | Typed parameters with defaults, options, and help text |
| `known_errors[]` | Regex patterns matched against stderr for plain-English error translation |

---

## Artifact lineage

Every run produces typed artifacts registered in the artifact registry. The compatibility API uses declared `accepts[]` types to compute valid next steps.

```mermaid
graph LR
    DICOM["DICOM folder\n(raw)"] -->|dcm2bids| BIDS["bids_dataset"]
    BIDS -->|BIDS Validator| BV["bids_dataset_validated"]
    BIDS -->|MRIQC| MR["mriqc_report_html"]
    BIDS -->|fMRIPrep / Import| FP["fmriprep_derivatives"]
    FP -->|Functional Connectivity| CM["connectivity_matrix_csv"]
    FP -->|Seed-Based Connectivity| SC["seed_connectivity_map_nii"]
    FP -->|ALFF/fALFF| AL["alff_map_nii"]
    FP -->|ReHo| RH["reho_map_nii"]
    SC -->|Statistical Map Explorer| SM["statistical_map_thresholded"]
    CM -->|Group FC| GFC["group_connectivity_matrix_csv"]
    CM -->|Connectome Graph Analysis| CG["connectome_graph_json"]

    NIfTI["nifti_raw"] -->|BrainChop / SynthStrip| SS["nifti_skull_stripped"]
    SS -->|FastSurfer| FS["fastsurfer_output"]
    SS -->|image-statistics plugin| ISJ["image_statistics_json"]
```

---

## Plugin system

```mermaid
flowchart TD
    ENV["NEURAVIAN_PLUGINS_DIRS env"] --> D
    PU["/plugins-user\n(Docker volume)"] --> D
    PC["/plugins\n(baked into image)"] --> D
    LP["repo-root/plugins/\n(local dev)"] --> D

    D["_find_plugin_dirs()"]
    D --> V["validate plugin.yaml\n(JSON Schema)"]
    V --> PM["load pipeline manifests\n(same schema as core)"]
    V --> AT["load artifact_types.yaml"]
    V --> PP["patch PATH with backend/"]
    PM --> R["Pipeline Registry"]
    AT --> AR["Artifact Registry"]
    PP --> NE["NativeExecutor\nshutil.which()"]
```

Plugin directories are scanned in priority order: env var → `/plugins-user` → `/plugins` → local dev. The first directory to define a plugin ID wins; later directories cannot override it.

---

## Frontend

The frontend is a React + TypeScript SPA built with Vite. It communicates exclusively through the `/api` REST interface.

```
frontend/src/
├── api/           — typed API client (fetchXxx functions + TypeScript interfaces)
├── components/
│   ├── primitives/    — Sidebar, layout, shared UI atoms
│   └── domain/        — RunResults, ArtifactPreview, ComparisonStudio, …
├── hooks/         — react-query data-fetching hooks (one per resource type)
├── lib/           — pure logic (methods engine, workflow persistence, statistics helpers)
└── pages/         — one file per route
```

State management: react-query for server state; React `useState`/`useReducer` for ephemeral UI state. No global client-side store.

---

## Data model

```mermaid
erDiagram
    Project {
        int id
        string name
        string description
        string investigators
        string tags
        datetime created_at
    }
    Dataset {
        int id
        string name
        string bids_path
        string source_type
        string bids_status
        datetime created_at
    }
    Run {
        int id
        string pipeline_id
        string status
        json parameters
        string command
        string log_path
        int dataset_id
        int source_run_id
        datetime started_at
        datetime finished_at
    }
    Artifact {
        int id
        string artifact_type
        string label
        string file_path
        int run_id
        int dataset_id
        datetime created_at
    }
    Workflow {
        int id
        string name
        json steps
        int dataset_id
    }

    Project ||--o{ Dataset : "contains"
    Dataset ||--o{ Run : "has"
    Dataset ||--o{ Artifact : "catalogues"
    Run ||--o{ Artifact : "produces"
    Run ||--o| Run : "source_run_id"
```

---

## Study report generation

```mermaid
flowchart LR
    Runs["Run records\n(pipeline_id, params,\nstatus, timestamps)"] --> MS
    Artifacts["Artifact records\n(type, path, size)"] --> MS
    Manifests["Pipeline manifests\n(display_name, citation_keys)"] --> MS

    MS["Methods Studio\n(template engine)"]
    MS --> MP["Methods paragraph\n(plain text)"]
    MS --> CP["Citation list\n(CSL-JSON)"]

    Runs --> SS
    Artifacts --> SS
    SS["Study Report Studio\n(Jinja2 templates)"]
    SS --> PDF["PDF report"]
    SS --> HTML["HTML report"]
    SS --> CMP["Comparison report\n(multi-run)"]
```

The methods paragraph is generated by template filling from provenance records — not by a language model. Every sentence traces directly to a logged field. If the data was not captured at run time, it does not appear in the output.

---

## Deployment

The canonical deployment is Docker Compose:

```
docker compose up
```

| Container | Image | Exposed port |
|---|---|---|
| frontend | nginx + React build | 3000 |
| backend | Python 3.12 + FastAPI | 8000 (internal only) |

The frontend nginx config proxies `/api/**` to `http://backend:8000/api/**`. The browser never talks directly to the backend port.

**Local development** (without Docker):

```bash
# Terminal 1 — backend
cd backend
uv sync --extra dev
uv run alembic upgrade head
uv run uvicorn app.main:app --reload   # http://localhost:8000

# Terminal 2 — frontend
cd frontend
npm install
npm run dev   # http://localhost:5173 (proxies /api to :8000)
```

---

## CI

GitHub Actions runs on every push and pull request:

1. Backend: `uv run pytest` (538 tests)
2. Frontend: `npx tsc --noEmit` + `npx vitest run` (279 tests) + `npx vite build`

See [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
