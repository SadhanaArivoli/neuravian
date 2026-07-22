# Neuravian (working name): Architecture & Product Plan
*A guided, modular orchestration layer for open-source neuroimaging tools*

---

## 1. Problem Statement

Neuroimaging research depends on a powerful but fragmented ecosystem of free tools (FSL, FreeSurfer, ANTs, AFNI, fMRIPrep, MRIQC, FastSurfer, QSIPrep, MRtrix3, DIPY, Nilearn). Each is excellent at its job, but together they create a steep, error-prone workflow:

- **Installation hell**: conflicting dependencies, different package managers (conda, Singularity, FSL's own installer, FreeSurfer license files), OS-specific quirks (especially Apple Silicon).
- **Glue-code burden**: moving outputs from one tool into the input format of the next is manual, undocumented, and different in every lab.
- **Opaque failures**: tools fail with cryptic logs (e.g., a malformed BIDS field causing a fMRIPrep crash 40 minutes into a run) that beginners can't interpret.
- **No unified provenance**: tracking *which version* of each tool, *which parameters*, and *which container* produced a given output is usually done ad hoc (or not at all), hurting reproducibility.
- **High onboarding cost**: new grad students often spend months learning command-line workflows before they can do actual science.
- **No scaling path**: students start on a laptop, but labs need Docker/HPC/cloud later, and migrating workflows is painful.

**The gap**: there is no free, open-source, beginner-friendly *orchestration and explanation layer* that sits on top of the existing toolchain — something that does for neuroimaging what VS Code + extensions did for software development, or what Galaxy did for bioinformatics pipelines.

---

## 2. Existing Tools/Platforms & Gap Analysis

| Tool/Platform | What it does well | Where it falls short |
|---|---|---|
| **fMRIPrep / QSIPrep / MRIQC** (NiPreps) | Best-practice, "glass box" preprocessing pipelines; huge credibility in the field | Still command-line/Docker-first; no GUI; users must already understand BIDS, containers, and the outputs |
| **FSL / FreeSurfer / AFNI / ANTs / MRtrix3** | Gold-standard individual algorithms | Each has its own CLI, install method, license process (FreeSurfer), and output conventions; no shared interface |
| **Nilearn / DIPY** | Excellent Python libraries for analysis/ML on neuroimaging data | Library, not an application — requires coding ability |
| **Brainlife.io** | Cloud-based, visual pipeline platform, reproducible, citable | Requires uploading data to the cloud (problematic for PHI/clinical data), less suited to "start on your laptop," less beginner-tutorial-oriented, not something you self-host trivially |
| **QMENTA, Flywheel** | Polished clinical/research platforms | Commercial/paid, not open-source, vendor lock-in |
| **C-PAC, fMRIPrep-docker GUI wrappers** | Some GUI convenience | Narrow scope (single pipeline), not a general orchestration layer |
| **Galaxy (bioinformatics)** | Proven model: GUI + workflow engine + tool wrapping + provenance | Not neuroimaging-specific; heavy to self-host; not optimized for imaging visualization |
| **LONI Pipeline, BrainVISA** | Older visual pipeline builders | Largely unmaintained or niche adoption; dated UX; weak BIDS/container-native support |

**What this project does differently:**
1. **Local-first, privacy-respecting** by default (data never has to leave the user's machine), with optional scale-out — unlike cloud-only platforms.
2. **A teaching layer, not just a runner**: explains *why* a step exists, what its parameters mean, and what went wrong in plain language — closer to a tutor than a pipeline executor.
3. **Wraps, never reimplements**: every actual computation is delegated to the validated original tool (via its official Docker/Singularity container or conda package), so scientific validity is inherited, not reinvented.
4. **Modern engineering**: typed APIs, plugin architecture, automatic provenance/versioning, BIDS-native, designed for incremental scaling (laptop → Docker → HPC/cloud) instead of being built cloud-first or CLI-only.
5. **Open source and self-hostable**, so a lab or student isn't locked into a vendor.

---

## 3. User Personas

1. **Maya, first-year neuroscience PhD student** — knows Python a little, has never used the terminal seriously, just got her first BIDS dataset, terrified of fMRIPrep's documentation.
2. **Dr. Osei, PI running a mid-size lab** — needs reproducibility for grant compliance and onboarding new students faster; wants to standardize pipelines across the lab without writing custom bash scripts every time.
3. **Sam, research software engineer / lab "tool person"** — currently maintains a pile of shell scripts and Slurm submission templates; wants a platform to reduce their personal maintenance burden and let trainees self-serve.
4. **Dr. Lindqvist, clinical researcher** (later-stage persona) — needs QC dashboards and audit trails for semi-clinical use; cares deeply about data security/privacy; not a v1 target, but the architecture shouldn't paint this out.
5. **Undergraduate RA, Jordan** — just needs to run MRIQC on a new batch of scans and get a clear pass/fail without understanding the internals.

---

## 4. MVP Feature List (v1)

Scope deliberately narrow and achievable by a single capable student developer over ~6–9 months part-time.

- **BIDS dataset import & validation** (wrap the official `bids-validator`), with friendly error explanations.
- **Dataset browser**: visualize folder structure, subjects/sessions, basic metadata, and a few key images (via a lightweight in-browser NIfTI viewer).
- **Pipeline runner for 2–3 well-chosen tools to start**: MRIQC (QC, relatively self-contained) and fMRIPrep (the highest-value, hardest-to-run tool). FreeSurfer/FastSurfer as a stretch goal.
- **Guided run wizard**: pick dataset → pick pipeline → set key parameters (with sane defaults and inline explanations) → review the exact command/container that will run → execute.
- **Execution via Docker** (the most realistic path for a Mac-first v1; see §12).
- **Live log streaming with plain-language error translation** for the most common failure modes (missing license file, malformed BIDS entity, out-of-memory, missing field map, etc.).
- **Provenance log per run**: tool name + version + container digest, parameters, dataset snapshot hash, timestamps, environment info — stored automatically, no extra user effort.
- **Local SQLite-backed project/run history** (no server required for solo use).
- **Basic results viewer**: QC report embedding (MRIQC/fMRIPrep already generate HTML reports — just surface them well), plus simple image viewers for key outputs.
- **One-command local install** (a single setup script / Docker Compose bundle) for the platform itself.
- **Minimal but real documentation** explaining what each pipeline does, in plain language, linked contextually in the UI.

**Explicitly out of MVP**: plugin marketplace, AI assistant, multi-user accounts, cloud/HPC execution, clinical features, FreeSurfer (license friction) unless time allows, custom pipeline builder (drag-and-drop DAG), authentication/roles.

---

## 5. Delayed / Later-Phase Features

- **Plugin system with third-party/community pipelines** (v1 supports only built-in, hardcoded integrations; plugin *architecture* is designed early but not exposed).
- **AI assistant** (local LLM-based help, see §17) — valuable but a distraction from getting the core orchestration right.
- **Cloud/HPC execution backends** (AWS, Slurm/HPC connectors) — design the execution abstraction now, implement later.
- **Multi-user / lab accounts, role-based access control, audit logs for compliance** — needed before any clinical claim, irrelevant for a solo student/lab use case at first.
- **Visual pipeline/DAG builder** (chaining custom pipelines beyond the built-ins) — complex UI/engineering investment.
- **FastSurfer, QSIPrep, MRtrix3, DIPY/Nilearn analysis modules** — add incrementally once the orchestration core is proven on fMRIPrep/MRIQC.
- **Dataset-sharing / OpenNeuro integration, federated/multi-site support.**
- **Clinical-grade security certifications (HIPAA-aligned hosting, encryption-at-rest enforcement, BAAs)** — needed only once clinical persona is targeted.

---

## 6. Recommended Tech Stack (free/open-source only)

**Backend**
- **Python 3.12** + **FastAPI** (async, typed, great OpenAPI docs generation — important since this is itself a teaching tool)
- **SQLite** for v1 local storage; designed via an ORM (**SQLAlchemy** + **Alembic** migrations) so swapping to **PostgreSQL** later is a config change, not a rewrite
- **Docker SDK for Python** to manage containerized tool execution
- **Celery** *or* a simpler **APScheduler/async task queue** for job management (start simple: a local job queue table + background worker process; avoid Celery+Redis complexity in v1 unless needed)
- **Pydantic** for schema validation of pipeline configs/manifests
- **bids-validator** (Node-based, run as a subprocess or via its Docker image) for BIDS checks
- **pybids** (Python) for programmatic BIDS querying

**Frontend**
- **React + TypeScript**, **Vite** for build tooling
- **Tailwind CSS** for styling (pairs well with a clean, modern "VS Code-like" aesthetic)
- **TanStack Query** for server state/data fetching
- **Niivue** (free, open-source, actively maintained WebGL NIfTI viewer — purpose-built for exactly this) for in-browser image viewing
- **React Flow** (free tier) — reserved for the *future* visual pipeline builder, not needed in v1

**Execution / Tool Integration**
- **Docker** (and Docker Compose) as the primary containerization layer — official NiPreps images (`nipreps/fmriprep`, `nipreps/mriqc`) already exist and are the right integration point
- **Apptainer/Singularity** support deferred to the HPC phase (§9/§12)

**DevOps / Quality**
- **GitHub Actions** (free for public repos) for CI
- **pytest** for backend tests, **Vitest** for frontend tests
- **Ruff + mypy** for Python linting/typing
- **Docker Compose** for local dev environment reproducibility

**AI assistant (later phase)**
- A locally-runnable open model (e.g., via **Ollama**) — see §17

All of the above are free and open-source; the only "cost" is compute/storage the user already has.

---

## 7. System Architecture (text diagram)

```
                        ┌─────────────────────────────────────────┐
                        │              Frontend (SPA)              │
                        │  React + TS + Niivue + TanStack Query    │
                        │  - Dataset browser   - Run wizard        │
                        │  - Log/console view  - Results viewer    │
                        └───────────────────┬───────────────────────┘
                                            │ REST/WebSocket (FastAPI)
                        ┌───────────────────▼───────────────────────┐
                        │                Backend API                │
                        │  FastAPI app: auth (later), datasets,     │
                        │  pipelines, runs, provenance endpoints    │
                        └─────────┬─────────────────┬───────────────┘
                                  │                  │
                ┌─────────────────▼──────┐  ┌────────▼─────────────────┐
                │   Dataset Service        │  │     Pipeline Registry     │
                │  - BIDS validation        │  │  - YAML/JSON manifests   │
                │  - pybids indexing        │  │    per tool (fMRIPrep,   │
                │  - metadata extraction    │  │    MRIQC, ...)           │
                └─────────────────┬─────────┘  └────────┬──────────────┘
                                  │                       │
                        ┌─────────▼───────────────────────▼───────────┐
                        │            Execution Orchestrator            │
                        │  - Builds container command from manifest    │
                        │    + user params                              │
                        │  - Job queue (local worker; pluggable for    │
                        │    Docker / Slurm / cloud later)              │
                        │  - Streams logs back via WebSocket            │
                        │  - Error-translation layer (regex/pattern     │
                        │    matching on known failure signatures)      │
                        └─────────┬──────────────────────┬─────────────┘
                                  │                        │
                  ┌───────────────▼───────┐   ┌────────────▼───────────┐
                  │   Docker Engine        │   │   Provenance Store      │
                  │  (runs official        │   │  SQLite: run metadata,  │
                  │  fMRIPrep/MRIQC/etc.   │   │  tool versions, params, │
                  │  containers unmodified)│   │  dataset hash, timing   │
                  └────────────────────────┘   └─────────────────────────┘
                                  │
                        ┌─────────▼─────────┐
                        │  Local Filesystem   │
                        │  BIDS dataset +     │
                        │  derivatives/        │
                        └─────────────────────┘
```

Key principle: **the orchestrator never reimplements algorithms** — it only constructs correct container invocations, manages execution, and translates the results back into something a beginner can read.

---

## 8. Frontend Architecture

- **SPA** with route-based code-splitting: `Datasets`, `Pipelines`, `Runs`, `Run Detail (live console)`, `Results`, `Settings`.
- **State**: server state via TanStack Query (cache run status, dataset metadata); minimal local UI state via React context — avoid pulling in Redux for a v1 of this scope.
- **Real-time updates**: WebSocket connection per active run for streaming logs/progress; falls back to polling if WS unavailable.
- **Component layers**:
  - *Primitives* (buttons, inputs, panels) — Tailwind-based design system, consistent with the "developer tool" aesthetic (think VS Code/Linear, not a clinical EHR).
  - *Domain components* (DatasetTree, PipelineCard, ParamForm generated from the pipeline manifest schema, ConsoleLogViewer, NiivueViewer wrapper).
  - *Pages* compose domain components.
- **Param forms are schema-driven**: each pipeline manifest declares its parameters (type, default, help text, validation), and the frontend renders a form automatically — this is what makes adding a new tool later mostly a backend/manifest task, not a frontend rewrite.
- **Accessibility & beginner-friendliness**: inline tooltips/help icons everywhere a CLI flag would normally appear unexplained; a "What will actually run?" preview showing the literal Docker command before execution, for users who want to learn the underlying CLI.

---

## 9. Backend Architecture

- **FastAPI app** organized by domain module: `datasets/`, `pipelines/`, `runs/`, `provenance/`, `core/` (config, db session, container client).
- **Layered design**:
  - **API layer** (routers): thin, handles HTTP/WS, validation via Pydantic schemas.
  - **Service layer**: business logic (e.g., `DatasetService.validate_bids()`, `RunService.start_run()`).
  - **Execution layer**: abstracted `Executor` interface with a `DockerExecutor` implementation in v1; designed so `SlurmExecutor`/`CloudExecutor` can be added later without touching service-layer code.
  - **Persistence layer**: SQLAlchemy models + repository-style access, isolating ORM details from services.
- **Pipeline manifests** are the core extensibility mechanism (see §11) — the backend reads a manifest (YAML/JSON) describing how to invoke a tool's container, what parameters exist, what output files to expect, and what known error patterns look like. Adding fMRIPrep vs. MRIQC is "write a manifest," not "write new code," wherever possible.
- **Background execution**: a simple worker process (could literally be `asyncio` background tasks + a `runs` status table for v1; upgrade to Celery/RQ only if/when concurrency needs justify the complexity).
- **WebSocket gateway** streams container stdout/stderr lines to the frontend in real time, also persisting full logs to disk for later review.

---

## 10. Local Storage / Database Plan

- **SQLite** (file-based, zero-config) for v1 — perfectly adequate for single-user/local-lab scale, and trivially backed up (it's just a file).
- **Schema (high level)**:
  - `datasets` (id, path, BIDS version, validation status, indexed metadata, hash/snapshot)
  - `pipelines` (id, name, version, manifest reference)
  - `runs` (id, dataset_id, pipeline_id, pipeline_version, container_digest, params_json, status, started_at, finished_at)
  - `run_logs` (run_id, log file path, error_signatures_detected)
  - `provenance_events` (run_id, event_type, payload_json, timestamp) — append-only, for a full audit trail
- **Large binary data** (images, derivatives) stays **on disk in BIDS/derivatives folder structure** — never duplicated into the database; the DB only stores paths/hashes/metadata. This keeps the DB small and keeps data portable/inspectable outside the app.
- **Migration path**: SQLAlchemy + Alembic from day one so moving to PostgreSQL (for multi-user/lab server mode later) is a configuration change plus a migration run, not a redesign.

---

## 11. Plugin System Design

Even though plugins aren't *exposed* in v1, design the manifest format now so it becomes the plugin format later with minimal change.

**Pipeline Manifest (conceptual schema, YAML)**:
```yaml
id: fmriprep
display_name: "fMRIPrep"
description: "Robust preprocessing pipeline for fMRI data"
homepage: "https://fmriprep.org"
container:
  image: "nipreps/fmriprep"
  tag: "24.1.1"          # pinned, user-upgradable
  engine: docker          # docker | singularity (later)
inputs:
  - bids_dataset
outputs:
  - derivatives/fmriprep
parameters:
  - name: fs-license-file
    type: file_path
    required: true
    help: "FreeSurfer license file - see [docs link]"
  - name: output-spaces
    type: multiselect
    options: [MNI152NLin2009cAsym, T1w, fsaverage]
    default: [MNI152NLin2009cAsym]
    help: "Which spaces to resample outputs into"
known_errors:
  - pattern: "license.*not.*valid"
    explanation: "Your FreeSurfer license file is missing or invalid."
    fix_hint: "Upload a valid license.txt in Settings > Licenses."
command_template: >
  docker run --rm -v {dataset_path}:/data:ro -v {output_path}:/out
  nipreps/fmriprep:{tag} /data /out participant {extra_args}
```
- **Plugin loading** (future): the backend scans a `plugins/` directory (or a registry URL later) for manifests + optional Python hook files implementing custom pre/post-processing or custom UI hints.
- **Sandboxing**: since plugins ultimately just describe container invocations, the security surface is naturally limited — no plugin runs arbitrary code on the host outside its declared container, which is a deliberate, important safety property to preserve.
- **Versioning**: manifests are versioned independently of the platform itself, so updating "the fMRIPrep integration" doesn't require a platform release.

---

## 12. Pipeline Execution Strategy

- **v1: local Docker only.** This is the right call for a Mac-first, student-buildable v1 — it avoids Singularity/Apptainer (Linux-centric, harder on macOS) and avoids HPC scheduler integration complexity entirely.
- **Execution flow**: manifest + user params → `Executor.build_command()` → `Executor.run()` (spawns container, mounts dataset read-only, mounts output dir, streams logs) → on completion, validate expected outputs exist → write provenance record.
- **Resource awareness**: before launching, check available RAM/disk against the tool's documented minimums (e.g., fMRIPrep typically wants 8GB+ free) and warn the user proactively rather than letting it fail 30 minutes in.
- **Abstraction for future backends**: `Executor` is an interface (`run(manifest, params, dataset) -> Run`); `DockerExecutor` is the only v1 implementation, but the interface anticipates `SlurmExecutor` (submits `sbatch` jobs, polls status) and `CloudExecutor` (e.g., AWS Batch) for later phases — the UI and database layer don't need to know which executor ran a job.
- **Idempotency/resumability**: leverage each tool's own resume/working-directory conventions (e.g., fMRIPrep's `--work-dir`) so re-running a failed job doesn't always restart from zero.

---

## 13. Integrating Tools Without Copying or Replacing Them

The guiding rule: **the platform is a command-builder, container-runner, and log-translator — never a reimplementation.**

- **fMRIPrep, MRIQC, QSIPrep**: use the official NiPreps Docker images verbatim, pinned by tag/digest. The platform's "integration work" is purely: manifest authoring, parameter UI, and output discovery (knowing where each tool puts its HTML report and key derivatives so the results viewer can surface them).
- **FreeSurfer / FastSurfer**: same pattern, but with explicit handling of FreeSurfer's license-file requirement (a common beginner failure point) — the platform should have a dedicated "Licenses" settings page that explains how to get the free academic license and validates the file before any FreeSurfer-dependent run is allowed to start.
- **FSL / ANTs / AFNI**: integrate either via their official containers where available, or via a pinned conda/Neurodocker-built image the project maintains *as a thin wrapper only* (no algorithm code, just environment packaging) when no official container exists.
- **Nilearn / DIPY**: these are Python libraries, not CLI tools — integration here looks different: small, well-tested platform-authored scripts that call these libraries for specific, scoped analyses (e.g., a QC plot, an ROI extraction), clearly labeled in the UI as "platform-authored analysis using Nilearn," so users understand what's a third-party validated pipeline vs. a platform convenience script.
- **No forking, no vendoring of source code.** Tool versions are referenced by container tag/digest; updating an integration means bumping a manifest's tag, not touching tool source.

---

## 14. Handling Updates When External Tools Change

- **Pin every tool to a specific container tag/digest** in its manifest — never `:latest`. Reproducibility requires that a "run" always be re-creatable.
- **Update workflow**: a maintainer (or automated CI job) periodically checks for new releases of integrated tools (via Docker Hub/GitHub release APIs), opens a PR bumping the manifest version, and CI runs a smoke test (a tiny synthetic/sample BIDS dataset) against the new container before merge.
- **User-facing update model**: users see "fMRIPrep 24.1.1 → 24.2.0 available" with release notes link; updating is opt-in per-project, and old provenance records keep referencing the exact version actually used — so a user can keep using an older pinned version for an ongoing study while testing the new one separately.
- **Breaking-change handling**: if a manifest's parameter schema changes between tool versions (flags renamed/removed), the manifest format supports a `deprecated_params` mapping so the platform can warn users and auto-migrate simple cases instead of silently failing.

---

## 15. BIDS Validation & Dataset Import

- **Import flow**: user points the app at a local folder → platform runs the official **bids-validator** (via its Docker image or npm package, run as a subprocess) → results parsed and shown in a friendly, categorized UI (errors vs. warnings vs. info) instead of a raw JSON/CLI dump.
- **pybids** used server-side to index the dataset (subjects, sessions, modalities, task names) for the dataset browser and to pre-fill pipeline parameter defaults (e.g., detecting available output spaces, fieldmaps present/absent).
- **Common-issue detection layer**: beyond raw validator output, pattern-match the most frequent beginner mistakes (wrong filename entity order, missing `.json` sidecar, mismatched `IntendedFor` fields) and explain each in plain language with a suggested fix — this is a major differentiator from just shelling out to the validator and dumping its output.
- **Non-destructive import**: the platform never modifies the original dataset in place; derivatives go into a separate `derivatives/` tree per BIDS convention, and any "fix" the platform suggests is applied to a copy or requires explicit user confirmation.

---

## 16. Designing Helpful Error Messages for Beginners

Three-layer error model:
1. **Raw log** — always available, for power users/debugging (full stdout/stderr, never hidden).
2. **Pattern-matched explanation** — a maintained library of regex/string patterns mapped to plain-language causes + fix steps (the `known_errors` block in manifests, §11). Start with the ~15–20 most common failure modes per tool (license issues, missing fieldmaps, out-of-memory, permission errors, disk space, malformed BIDS entities) — this list should be built empirically from NeuroStars forum posts and GitHub issues for each tool.
3. **"I'm stuck" escalation** — a button that packages the relevant log excerpt + run config (with any PHI-risk paths redacted) into a pre-filled NeuroStars/GitHub-issue template, since these communities are the actual experts and the platform shouldn't pretend to replace them.

Design principle: **never show a raw traceback as the primary message** — show the plain-language explanation first, with "show full log" as a secondary, always-available action.

---

## 17. AI Assistant Without Paid API Dependency

- **Default: fully optional, fully local.** Integrate with **Ollama** (free, open-source, runs local models like Llama 3 or Mistral derivatives on the user's machine) as the default backend, so there's zero dependency on a paid API and no data ever leaves the machine — important given the data sensitivity in §18.
- **Scope the assistant narrowly** rather than building a general chatbot: it should be a context-aware helper that (a) explains the current error/log, (b) explains a parameter the user is hovering over, (c) summarizes a QC report. This is achievable with retrieval over the platform's own docs + manifest help text + the tool's official documentation, rather than needing a huge general-purpose model.
- **Pluggable backend**: an `LLMProvider` interface, with `OllamaProvider` as the default and an optional `AnthropicProvider`/other API-based provider for users who *choose* to bring their own API key — never required, always opt-in, clearly labeled regarding any data sent off-device.
- **This is correctly deferred to a later phase** (§5) — get the deterministic, pattern-matched error explanations (§16) working first; that alone resolves most beginner confusion, and the AI layer is additive polish, not core functionality.

---

## 18. Security & Privacy Considerations for Medical Imaging Data

- **Local-first by default**: v1 processes data entirely on the user's machine; no data transmitted anywhere unless the user explicitly enables a cloud/AI feature.
- **De-identification awareness**: surface (don't silently assume) whether a dataset has been defaced/de-identified; offer to run an open-source defacing tool (e.g., `pydeface`) as part of import for datasets containing facial structure, with clear warnings if DICOM headers still contain PHI (name, DOB, etc.) before any sharing/export action.
- **No telemetry on imaging data, ever.** If the platform collects any anonymous usage analytics (optional, opt-in), it must be strictly about feature usage, never dataset content or file paths.
- **At-rest considerations**: document that users handling real patient data should use OS-level disk encryption (FileVault on Mac, BitLocker on Windows) — the platform doesn't need to reinvent disk encryption, but should clearly document this responsibility rather than implying false security.
- **Multi-user/clinical mode (later phase)**: when authentication/server mode is added, this is where real requirements kick in — encrypted connections (TLS), role-based access control, audit logging of who accessed what, and explicit non-claim of HIPAA compliance unless formally assessed. **Do not market the v1 as clinical-ready or HIPAA-compliant** — that's a legal/regulatory claim requiring real audit, not an architecture decision.
- **Provenance logs should avoid storing PHI**: store paths and hashes, not patient names/identifiers, by default.

---

## 19. Repository Folder Structure

```
neuravian/
├── backend/
│   ├── app/
│   │   ├── api/                # FastAPI routers (datasets, pipelines, runs, provenance)
│   │   ├── services/            # business logic per domain
│   │   ├── execution/           # Executor interface + DockerExecutor
│   │   ├── models/               # SQLAlchemy models
│   │   ├── schemas/              # Pydantic request/response schemas
│   │   ├── core/                 # config, db session, container client, logging
│   │   └── main.py
│   ├── alembic/                  # DB migrations
│   ├── tests/
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   │   ├── primitives/
│   │   │   └── domain/
│   │   ├── hooks/
│   │   ├── api/                  # generated/typed API client
│   │   └── main.tsx
│   ├── tests/
│   └── package.json
├── pipelines/                     # manifest library (the "plugin" definitions)
│   ├── fmriprep.yaml
│   ├── mriqc.yaml
│   └── schema/                    # JSON schema for manifest validation
├── docs/
│   ├── architecture/              # this document, ADRs
│   ├── user-guide/
│   └── tool-explainers/           # plain-language "what does X do" pages
├── scripts/
│   ├── setup.sh                   # one-command local install
│   └── smoke-test-dataset/        # tiny synthetic BIDS dataset for CI
├── docker-compose.yml
├── .github/workflows/             # CI
└── README.md
```

---

## 20. Development Roadmap (Milestones)

1. **M1 — Project skeleton**: FastAPI + React scaffolding, Docker Compose dev environment, CI pipeline running on every push, SQLite + Alembic wired up.
2. **M2 — BIDS import & validation**: wrap bids-validator, pybids indexing, dataset browser UI (folder tree + metadata), friendly validation error UI.
3. **M3 — Manifest schema & registry**: define and document the pipeline manifest format; build the backend loader/validator for manifests; write the MRIQC manifest first (simplest tool, good first integration target).
4. **M4 — Docker execution engine**: `Executor` interface + `DockerExecutor`; run MRIQC end-to-end from the UI on a small sample dataset; live log streaming via WebSocket.
5. **M5 — Provenance logging**: automatic run metadata capture (versions, params, dataset hash); a "Run History" page showing past runs and their exact configs.
6. **M6 — Error translation layer v1**: build the known-error pattern library for MRIQC failures; plain-language error UI; "show full log" fallback.
7. **M7 — Results viewer**: embed MRIQC's HTML QC reports; integrate Niivue for basic image viewing of a derivative output.
8. **M8 — fMRIPrep integration**: author the fMRIPrep manifest (the hardest one — license handling, fieldmaps, long runtimes, large outputs); resource pre-checks (RAM/disk); resumability via work-dir.
9. **M9 — Param wizard polish**: schema-driven param forms with inline help, "preview the exact command" feature, default presets for common use cases (e.g., "minimal preprocessing," "full anatomical + functional").
10. **M10 — Error translation v2**: expand pattern library specifically for fMRIPrep's common failure modes (license, fieldmap mismatch, OOM, disk space); add the "I'm stuck → pre-filled GitHub/NeuroStars issue" escalation feature.
11. **M11 — Documentation pass**: in-app contextual docs for every pipeline/parameter; a written user guide; tool "explainer" pages (what does fMRIPrep actually do, in plain language).
12. **M12 — Hardening & UX polish**: handle edge cases (corrupt datasets, partial runs, disk-full mid-run), improve onboarding (first-run tutorial using a bundled sample dataset), accessibility pass.
13. **M13 — Beta with real users**: pilot with a small group (a lab, a class) on real (or realistic de-identified) datasets; collect friction points; triage into a backlog.
14. **M14 — FreeSurfer/FastSurfer integration** (stretch, time-permitting): apply the now-proven manifest pattern to a third tool, validating that the architecture generalizes.
15. **M15 — Plugin system exposure & v2 planning**: open the manifest/plugin format for community contribution; begin design work on executor backends beyond local Docker (Slurm/cloud) and the local-AI assistant, informed by real beta feedback.

**Critical realism note**: Milestones 1–7 (a working, validated, well-explained MRIQC workflow with provenance and a results viewer) are the real "is this project viable" test. Resist the urge to start with fMRIPrep — it's the most complex integration (long runtimes, license requirements, huge outputs) and a poor first proof of concept. Prove the orchestration pattern on MRIQC first.

---

## What's realistically too big for v1 (explicit cut list)

- Multi-user accounts/auth/roles
- Cloud or HPC execution
- AI assistant (even local) — nice-to-have, not core
- Plugin marketplace / community contributions
- Visual drag-and-drop pipeline builder
- Clinical compliance claims of any kind
- More than 2–3 integrated tools at launch
- Custom analysis builder beyond pre-built pipelines
- Singularity/Apptainer support (Docker only for v1)

---

## First Prompt for Claude Code

Use this as your opening prompt when you start the actual build in Claude Code. It encodes the architecture above as constraints so the agent doesn't wander into scope creep.

```
I'm building "Neuravian" — a local-first orchestration platform that wraps existing,
validated open-source neuroimaging tools (starting with MRIQC, later fMRIPrep) behind a
modern, beginner-friendly UI. Full architecture doc is at docs/architecture/neuroimaging-platform-architecture.md
— read it first before writing any code.

Hard constraints:
- Never reimplement neuroimaging algorithms. The platform only builds container commands,
  runs them via Docker, and translates logs/output into something a beginner can understand.
- Backend: Python 3.12, FastAPI, SQLAlchemy + Alembic, SQLite for v1.
- Frontend: React + TypeScript + Vite + Tailwind + TanStack Query.
- Execution: Docker SDK for Python, behind an `Executor` interface (DockerExecutor is the
  only v1 implementation — design the interface so Slurm/cloud executors can be added later
  without touching service-layer code).
- Pipelines are defined as YAML manifests (tool, container image+pinned tag, parameters,
  known error patterns) — never hardcode tool invocation logic in app code.
- BIDS validation via the official bids-validator; dataset indexing via pybids.

Milestone 1 (this session): set up the project skeleton only —
- backend/ FastAPI app with a working `/health` endpoint, SQLAlchemy session setup, and an
  initial Alembic migration for the `datasets`, `pipelines`, `runs`, `run_logs`, and
  `provenance_events` tables as described in the architecture doc.
- frontend/ React+TS+Vite+Tailwind app with a basic page shell (sidebar nav: Datasets,
  Pipelines, Runs) that calls the backend's /health endpoint and shows connection status.
- docker-compose.yml that runs backend + frontend together for local dev.
- pipelines/ folder with a schema/ subfolder containing a JSON Schema for the pipeline
  manifest format (don't write any actual pipeline manifests yet — just the schema).
- GitHub Actions CI workflow running backend pytest and frontend vitest on push.
- Write tests for whatever you build. Keep everything minimal and working end-to-end rather
  than fleshing out features — I want to be able to `docker compose up` and see the frontend
  talk to the backend before we add any real functionality.

Ask me clarifying questions before making structural decisions not covered in the
architecture doc (e.g., exact Tailwind config, specific FastAPI project layout choices)
rather than guessing silently.
```

Copy that file path reference (`docs/architecture/...`) once you've actually put this document into your repo, or just paste the whole architecture doc into the repo's `docs/` folder before running this prompt so Claude Code can read it directly.
