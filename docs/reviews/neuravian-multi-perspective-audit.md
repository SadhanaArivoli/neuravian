# Neuravian Multi-Perspective Audit

**Version audited:** v0.1.0-alpha (commit `88be5e0`)
**Audit date:** 2026-07-13
**Scope:** Full repository — source code, documentation, manifests, tests, Docker setup, plugin SDK, UI pages, and runtime behavior as observed from code analysis.

---

## Executive Summary

Neuravian is a technically ambitious local-first neuroimaging research platform that succeeds at its core premise: connecting existing tools through a unified, reproducibility-first workspace. The manifest-driven architecture, artifact-typed chaining, provenance records, and Methods Studio are genuinely differentiating features that existing tools do not offer. The engineering is careful in most areas — path traversal protection, lazy initialization, stalled-run recovery, and plugin isolation are all handled thoughtfully.

For an alpha release targeting neuroimaging researchers, Neuravian is substantially functional. The 20 core pipelines cover a coherent subset of a real fMRI workflow. The test suite (537 backend, 279 frontend) provides meaningful coverage of the execution layer, manifest loading, and pure logic. The documentation is thorough for an alpha project.

The platform also has real limitations a reviewer must name honestly. No authentication exists. The Docker socket is mounted, giving anyone who can reach the backend full control of the host Docker daemon. Functional connectivity pipelines use hardcoded confound columns with no user control. The seed connectivity tool selects seeds by numeric index rather than by name. The methods engine cannot capture atlas download dates or Nilearn cache state. Several UX flows require users to know neuroimaging internals to avoid mistakes. The SSH remote execution feature is wired up in the settings UI but not connected to actual run creation. The statistics pipeline performs cluster labelling without any inference — this must be stated unambiguously at every point where users see cluster tables.

**Overall verdict:** Ready for supervised pilot use by a technically capable lab with experienced oversight. Not yet ready for unsupervised use by beginners or for deployment on shared or networked machines. Several medium-engineering issues should be addressed before v1.0, but none block the alpha.

---

## Perspective 1 — Neuroimaging Researcher

### Evaluation

**Pipeline coverage.** Twenty core pipelines span the fMRI workflow from DICOM conversion through functional connectivity and graph analysis. Coverage is coherent: if your work is resting-state fMRI on a dataset already in fMRIPrep derivatives, Neuravian covers nearly all descriptive analyses locally. For task-based fMRI, EEG, diffusion, ASL, MRSI, or T2*-based quantitative imaging, there is no coverage in this release, and the platform does not pretend otherwise.

**Confound handling (scientific concern, High).** The functional connectivity pipeline (`backend/app/tools/functional_connectivity.py:L44`) uses a hardcoded `CONFOUND_COLUMNS` list (`trans_x/y/z`, `rot_x/y/z`, `white_matter`, `csf`, `global_signal`) with no manifest parameter to override this strategy. The `confounds.py` module defines a proper parametric strategy system (`motion6`, `motion6_wm_csf`, `motion6_wm_csf_global`, `none`), but `functional_connectivity.py` does not use it. The ALFF, ReHo, and seed-based tools use the strategy-based system. This inconsistency means users running FC with datasets that lack `white_matter` or `csf` confound columns will silently drop those regressors without a warning visible in the UI.

**Seed ROI selection by index (usability/science concern, Medium).** The seed-based connectivity pipeline requires users to specify the seed as a 1-based integer index into the atlas parcellation. Users must know the Schaefer parcel numbering scheme to use this correctly. A partial mitigation is the manifest help text, but no lookup table or name-to-index resolution is provided. An experienced user will work around this; a student will likely pick the wrong ROI.

**Atlas version and download state.** Nilearn atlases are downloaded at runtime to a cache directory. The provenance record captures the atlas ID and Nilearn version, but not the atlas file checksum or download date. If Nilearn updates an atlas between runs, the provenance record cannot distinguish those runs. This is an accepted limitation of using runtime-fetched atlases but should be stated explicitly.

**Statistical Map Explorer limitations.** The cluster labelling tool correctly implements 6-connectivity component analysis and computes per-cluster statistics. The implementation note "no random field theory, no permutation testing, no inferential statistics" is accurate and appropriate. However, the HTML report produced by the tool (`statistical_map_explorer.py:_HTML_TEMPLATE`) and the cluster table in the frontend do not display a visible warning that cluster sizes and peaks are descriptive, not corrected for multiple comparisons. A researcher who presents these tables in a paper without understanding this distinction could cause review problems.

**ALFF/fALFF and ReHo.** These are correctly implemented descriptive measures. The KCC formula used in ReHo (`regional_homogeneity.py:L48`) matches the Zang et al. 2004 definition. ALFF uses rfft with proper Nyquist checking. The default frequency band (0.01–0.1 Hz) is appropriate for resting-state. These analyses work without GLM infrastructure, which is a sound decision for an alpha.

**Group Functional Connectivity.** The tool computes a simple mean and standard deviation across input connectivity matrices. There is no weighting by subject quality or run length, no Fisher z-averaging (correlations are averaged as raw Pearson r, which is technically incorrect for means of correlation matrices — the proper approach is Fisher z-transform before averaging then inverse transform). This should be noted as a limitation, not a blocking issue, but users should be warned.

**Methods and citations.** The Methods Studio generates template-filled paragraphs that are factually grounded in the provenance record. This is the correct approach. Citations in `citationRegistry.ts` include DOIs and RRIDs for major tools. The atlas citation text (`atlas_citation` in the FC tool output) is stored as a human-readable string rather than a structured citation object, which means it cannot be exported to BibTeX directly.

**Strongest scientific capabilities:**
- Artifact-typed chaining that prevents connecting incompatible pipeline outputs
- Complete per-run provenance with container digest
- Descriptive FC pipeline covering four atlases with appropriate ROI statistics
- ALFF, ReHo, and connectome graph analysis implemented cleanly
- Correct "descriptive only" framing throughout

**Scientific claims needing more cautious wording:**
- Cluster tables should carry a persistent notice that size and peak values are not corrected for multiple comparisons
- Group FC mean should note that Fisher z-averaging is the more correct approach
- Methods Studio should note that atlas file checksums are not captured

**Score: 62/100.** Solid foundation for descriptive fMRI. Real gaps in confound control flexibility, seed ROI selection UX, and statistical interpretation warnings.

---

## Perspective 2 — Lab PI

### Evaluation

**Would I trust a student to use this?** With qualified oversight, yes. The provenance record and command-preview features mean a PI can audit exactly what was run. The run history is persistent and portable. The Methods Studio produces a first-draft methods paragraph that a PI can review and correct. The read-only dataset mount is a strong safety guarantee that prevents students from accidentally overwriting source data.

**Auditability.** Run records include full parameters, command preview, container digest, start/end times, and exit code. A PI reviewing a run 6 months later can see precisely what was executed. The Analysis Graph shows the full lineage of derived artifacts. This is meaningfully better than the typical "I ran it from the terminal" situation.

**Lab standardization.** The workflow template system and manifest-driven pipeline configuration allow a PI to define a standard analysis plan as a named workflow and share it with students. Students can reload the template and fill in dataset-specific parameters. This reduces protocol drift.

**What would make a PI hesitate?**
1. No authentication. Any process on the same machine (or network if ports are exposed) can submit runs, delete datasets, or export reports. In a shared lab computer this is a risk.
2. No audit log of who ran what. Provenance records "what" and "when," but not "who." Multi-researcher labs need this for accountability.
3. The SSH remote execution feature appears in the UI (Remote Hosts settings page) but is not connected to run creation. A PI who reads the README and expects to submit jobs to their HPC will be disappointed.
4. No role separation. All users have equal access to all datasets and all controls including delete.

**Evidence required before adoption:**
- One successful end-to-end run on lab data with results verified against manual MATLAB/Python analysis
- Confirmation that the Docker socket privilege escalation is acceptable under the institution's IT policy
- A review of the Known Limitations section in `docs/releases/v0.1.0-alpha.md`

**Is Neuravian ready for pilot use?** Yes, with one researcher who understands the limitations and can supervise initial use. Not ready for unmonitored student deployment.

**Why would a PI adopt this?**
- Reduces the "I can't reproduce my student's analysis" problem
- Methods paragraph generation saves 30–60 minutes per manuscript
- Read-only dataset protection eliminates a class of accidents

**Score: 68/100.** The provenance and reproducibility features are exactly what a PI needs. Lack of authentication and incomplete remote execution are meaningful gaps.

---

## Perspective 3 — Graduate Student / Beginner

### Evaluation

**Installation.** The four-command setup (`git clone`, `cp .env`, `docker compose up`) is significantly simpler than installing FSL, FreeSurfer, or fMRIPrep individually. The main friction point is Docker Desktop (requires an Apple Developer account on some hardware) and the `.env` setup — users who do not understand what `HOST_DATASETS_DIR` means will mount the wrong path and be confused when their datasets don't appear. The quickstart guide (`docs/quickstart.md`) covers this step but assumes the user knows where their datasets live.

**Onboarding.** The four-step onboarding overlay appears on first visit and explains the Dataset → Pipeline → Run → Artifact flow. It is light but sufficient. A student who clicks through it will understand the basic structure.

**Terminology.** Several terms will confuse beginners:
- "Artifact" means a typed pipeline output in Neuravian, but students may interpret it as a data artifact (unwanted signal). The help text does not explain the Neuravian-specific meaning on first encounter.
- "Compute profile: local-unsafe" is meaningful to a developer but opaque to a student. The badge labels ("Cloud recommended") are better, but new users will wonder why a pipeline they see listed is labeled this way.
- "fMRIPrep derivatives" as an artifact type — students who have not run fMRIPrep will not know what this means or why it is required by FC pipelines.
- The "Run Next" card label and help text are clear. This is well-implemented.

**Parameter clarity.** Each pipeline's parameter form includes help text, default values, and type validation. The atlas selection dropdown in the FC pipeline shows display names ("Schaefer 2018, 100 parcels, 7 networks") rather than internal IDs. The `advanced: true` parameter hiding reduces clutter for beginners. The FreeSurfer license file requirement for fMRIPrep is explained with registration link and expected timeline.

**Error messages.** The `known_errors[]` system provides plain-English translations for the most common failure patterns. A student who gets a "No fMRIPrep preprocessed BOLD files were found" error will see an explanation and a suggested fix in the run detail page. This is a genuine improvement over raw stderr output.

**Places where a user could launch the wrong analysis:**
- FC pipeline: a student who forgets to select the right subject filter will use the first BOLD file found alphabetically, with no warning that filtering was omitted
- Statistical Map Explorer: a student who loads a seed connectivity z-map without understanding what z-values are might threshold it at 0.3 (thinking of r-values) and misinterpret the result
- Group FC: a student who feeds connectivity matrices from subjects with different preprocessing (different confound strategies, different resolutions) will get a mean matrix that mixes methodologies, with no warning

**Tasks that still require terminal knowledge:**
- Setting `HOST_UID`/`HOST_GID` environment variables for FastSurfer (explained in `.env.example`, but students unfamiliar with shell profiles will not know how to do this persistently)
- Debugging Docker build failures
- Adding a plugin (requires writing YAML and creating a directory structure)

**Score: 58/100.** Much better onboarding than raw CLI tools, but several terms and concepts require neuroimaging knowledge the platform doesn't teach. Tutorials help but are long.

---

## Perspective 4 — Experienced Neuroimaging Analyst

### Evaluation

**Control over parameters.** All pipeline parameters are surfaced through the form interface with help text. Advanced parameters are hidden by default but toggleable. The `command_preview` field in the run record shows the exact command that was or will be executed. This is the right approach — experts can verify what is being run without reading source code.

**Accessing raw outputs.** Every run has a structured output directory. The file-serving API (`/api/runs/{id}/files/{path}`) allows direct file access. The Download All endpoint produces a ZIP of the entire output directory. Expert users can mount the `./data` directory directly and access files without going through the UI. This is correct.

**Reproducibility for experts.** The provenance export (YAML format, downloadable from Methods Studio) is genuinely useful. It includes `container_image`, `container_digest`, `params`, and `command_preview`. An expert can reconstruct any run from this record. The one gap is that Nilearn-fetched atlas files are not checksummed, so atlas file identity is not verifiable from the export alone.

**Interoperability.** Output formats are standard: NIfTI for volumetric data, CSV/TSV for matrices and time series, JSON for metadata, HTML for reports. A user who wants to load the connectivity matrix in R, MATLAB, or Python can do so directly from the output directory. The `.npy` format for matrices is Python-specific but not a barrier.

**Does Neuravian get in the way?** Mostly no. The sequential execution queue is the biggest limitation — an expert running ALFF on 30 subjects serially will find this painful. The in-process queue has no parallelism flag. This is by design for the alpha but will become a barrier for real-scale analysis.

**Plugin architecture usefulness.** The plugin architecture is genuinely sound. A developer who writes a Python tool can expose it through Neuravian's provenance and artifact system by creating a YAML manifest and a backend directory. The `image-statistics` plugin is a complete working example. An expert who wants to integrate a custom tool can do so without forking the core codebase.

**SSH remote execution.** The settings page and API for remote hosts exist. The models and schema are in place. But running a pipeline via SSH is not wired into the run creation flow — the executor selection always defaults to Docker or native based on the manifest. An expert expecting to route pipelines to an HPC cluster will find this non-functional.

**Score: 71/100.** Good transparency, standard output formats, and a plugin system that genuinely works. Sequential execution and incomplete remote execution are the main frustrations for expert use.

---

## Perspective 5 — Research Software Engineer

### Architecture Audit

**Overall architecture.** Clean separation between FastAPI API layer, service layer, execution layer, and tool implementations. The manifest-driven design is architecturally sound and avoids the common pattern of hardcoded pipeline logic in application code.

**Critical architectural concerns:**

**Docker socket privilege (High).** Mounting `/var/run/docker.sock` in `docker-compose.yml` gives the backend container full control of the host Docker daemon. Any code running in the backend container — including plugin executables — can start arbitrary containers on the host with any volume mounts, environment variables, or capabilities. This is a known Docker-outside-of-Docker risk. The current single-user local-first use case makes this acceptable, but it must not be deployed on shared machines without additional controls.

**Module-level mutable state (High).** Several modules maintain significant mutable module-level state:
- `execution_queue.py`: `_queue: list`, `_running_run_id`, `_processor_started`, `_stalled_checker`
- `docker_executor.py`: `_MOUNTS: dict | None`, `_active_containers: dict[int, str]`
- `native_executor.py`: `_active_native_procs: dict[int, Popen]`
- `plugin_loader.py`: `_plugins: list`, `_plugin_manifests: dict`, `_loaded: bool`
- `run.py`: `_log_buffers: dict`, `_subscribers: dict`, `_progress_state: dict`
- `pipeline.py`: `_registry: dict | None`
- `artifact_registry.py`: `_artifact_types_cache: dict | None`

For a single-process single-worker deployment this is functional, but these caches create hidden coupling between tests (partially addressed by `reset_for_testing()` in `plugin_loader.py` but not universally applied), and the `_MOUNTS` cache in `docker_executor.py` is never invalidated — if Docker state changes (volumes remounted) the path translation will be stale.

**`_log_buffers` memory leak (Medium).** `run.py:_log_buffers` grows unbounded — every log line from every run is stored in memory for the process lifetime. For a long-running server that processes hundreds of runs, this will accumulate meaningful memory. There is no eviction policy.

**Execution queue not persistent (Medium).** The in-memory queue (`execution_queue.py:_queue`) is lost on restart. Runs in `queued` status in the DB after restart will be detected by the stalled checker and marked `interrupted`, not re-queued. This is safe but means a restart during a queue of 10 jobs requires the user to manually retry all 10.

**`seed_based_connectivity.py` imports from `functional_connectivity.py` (Medium).** `seed_based_connectivity.py` imports `_select_bold`, `_load_confounds`, `_load_atlas`, and `ATLAS_REGISTRY` from `functional_connectivity.py`. This creates a tool-to-tool dependency that means changes to the FC module's private API can silently break the seed tool. These shared functions should be extracted to a separate `_bids_utils.py` or `_atlas_utils.py` module.

**`ReHo` and `ALFF` also import from `functional_connectivity.py`** (`_entity`, `_matching_confounds`). Same coupling concern. Three tools depend on private internals of a fourth. This is the most significant modularity debt in the codebase.

**Confound handling inconsistency (High).** `functional_connectivity.py` uses hardcoded `CONFOUND_COLUMNS` (line 44). The `confounds.py` module provides a parametric strategy system. `alff_falff.py`, `regional_homogeneity.py`, and `seed_based_connectivity.py` use `confounds.select_confounds()`. The FC pipeline does not. This is inconsistent and means the FC tool has no `confound_strategy` parameter, no warning when confound columns are missing, and no control for the user.

**Report generation in background thread, not task queue (Medium).** `reports.py:_generate_report()` runs in a `threading.Thread`. This is outside the execution queue, so report generation and pipeline runs can overlap without coordination. The report thread uses its own `SessionLocal()` context, which is correct, but two concurrent heavy workloads competing for Python GIL and CPU resources may cause problems.

**No request-rate limiting.** A user can submit unlimited runs to the queue. The queue will drain them sequentially, but a misfired loop could queue thousands of runs with no protection.

**Good engineering decisions:**
- Path traversal protection via `Path.relative_to()` in all file-serving endpoints (`runs.py:L329`, `datasets.py:L130`, reports)
- Lazy `_get_svc()` in `api/pipelines.py` prevents the lifespan ordering bug
- Stalled-run recovery on startup (`recover_interrupted_runs`)
- Plugin validation with JSON Schema before any plugin code executes
- `reset_for_testing()` in plugin_loader for test isolation
- `from_host_path`/`to_host_path` for Docker-in-Docker path translation

**Database.** 12 Alembic migration files, all sequenced correctly. No explicit indices on foreign key columns (`run.dataset_id`, `artifact.run_id`). For an alpha with small datasets this is not a problem, but at scale queries like "list all runs for a dataset" will be slow without indices.

**Score: 66/100.** Clean architecture, good separation of concerns, solid path-safety. Module-level state, tool coupling, and confound inconsistency are real maintenance risks.

---

## Perspective 6 — Open-Source Maintainer

### Evaluation

**Contributor experience.** `CONTRIBUTING.md` is clear and specific: development setup, running tests, how to add a pipeline (5 steps), commit style, and explicit prohibitions (no weakening tests, no LLM-generated methods prose). This is better than most alpha projects.

**Issue templates.** Three templates: bug report, feature request, and pipeline manifest. The pipeline manifest template is particularly well-designed — it asks for execution type, artifact type slugs, compute profile, and Apple Silicon status. A contributor filling this out will provide the information a maintainer actually needs.

**Could an external contributor successfully add a plugin?** Yes. The `plugins/image-statistics/` directory is a complete working example. `docs/plugin-tutorial.md` walks through every step with code. The JSON Schema validates the manifest at startup and produces actionable error messages. The plugin ID conflict detection prevents namespace collisions.

**Could they run tests without help?** Yes, with Python 3.12 and uv installed. `uv sync --extra dev && uv run pytest` works. Frontend tests require Node 20 but the steps are standard.

**Are contribution boundaries clear?** Mostly. The manifest schema enforces structure. CODEOWNERS assigns review requirements for core pipeline manifests and the execution layer. The prohibition on adding AI-generated scientific content is explicit. What is less clear: when should a new pipeline be a core pipeline vs. a plugin? There is no documented guidance on this decision.

**What would discourage contributors?**
1. No GitHub Discussions (mentioned as "if enabled" in the release notes — it is not enabled yet). Issue tracker is the only async communication channel.
2. Sequential CI: tests, type check, and build run sequentially; a fast backend test suite takes ~30 seconds, but the CI YAML could parallelize frontend and backend.
3. The PR template is detailed, which is correct, but the backend test requirement ("pytest coverage") may deter contributors who are not Python developers.
4. No documented way to run Neuravian locally against a mock dataset for UI development without running the full Docker setup.

**Release process.** The CHANGELOG is maintained. CITATION.cff is valid and will be indexed by GitHub's citation system. Release notes are structured and factual. The tag-based release process is documented. Semantic versioning is followed (0.1.0-alpha).

**Score: 72/100.** Solid contributor documentation for an alpha. The plugin system genuinely enables external contributions without forking. Lack of Discussions and unclear core-vs-plugin guidance are gaps.

---

## Perspective 7 — Privacy / Security Reviewer

### Audit

**Local-first claims.** Accurate and verifiable. Docker Compose runs entirely locally. The backend binds to `0.0.0.0:8000` inside the container, which is proxied by nginx on port 3000. There is no telemetry, no external API dependency (except for Nilearn atlas downloads on first run), and no account creation. The claim is honest.

**Path traversal protection.** Consistently applied:
- `GET /api/runs/{id}/files/{path}` (`runs.py:L316`): `requested.relative_to(output_root)` raises `ValueError` → 403
- `GET /api/datasets/{id}/files/{path}` (`datasets.py:L128`): same pattern
- `GET /api/datasets/{id}/reports/{id}/view` (`reports.py`): HTML served from a Neuravian-generated file; the path comes from the DB record, not the URL, so traversal is not possible

**Docker socket (High).** `/var/run/docker.sock` is mounted in the backend container (`docker-compose.yml:L24`). This is required for Docker-in-Docker pipeline execution. However, it grants anyone who can submit a run request (i.e., anyone who can reach the backend) the ability to run arbitrary containers on the host with arbitrary volume mounts. On a single-user local machine this is acceptable. On a shared machine or with any network exposure, this is a significant privilege escalation path. The SECURITY.md notes that Neuravian "is not intended to be exposed to the public internet" — this is the correct warning, but it should be repeated more prominently in the deployment instructions.

**No authentication (High).** The backend accepts all API requests without authentication. If `localhost:3000` is accessible on a shared network (e.g., a lab iMac, a university VPN), any user on that network can submit runs, access all datasets, read all provenance records, and trigger PDF generation (Playwright/Chromium subprocess). This is clearly stated in the Known Limitations section but should be in a visible warning banner in the UI when the backend is detected as potentially network-accessible.

**HOST_UID/HOST_GID default to 0 (Medium).** `docker-compose.yml:L34-35` defaults `HOST_UID` and `HOST_GID` to 0. FastSurfer containers started with `run_as_host_user: true` will run as root on the host system if the user does not set these variables. The `.env.example` explains this but does not make it mandatory.

**Plugin executable trust (Medium).** Plugin backends are executables that run inside the backend container (as root). A plugin provided by an untrusted source could exfiltrate data, modify the SQLite database, or contact external servers. There is no sandbox, signature verification, or capability restriction. The documentation does not explicitly warn users that plugins must be trusted. This should be added to `docs/plugin-development.md`.

**CORS configuration.** `settings.cors_origins` allows `localhost:3000`, `localhost:5173`, and `frontend:3000`. Not a wildcard. Correct for the intended deployment.

**Dataset mount is read-only.** Confirmed in `docker-compose.yml:L15` (`:ro`). Source data cannot be modified by any Neuravian operation.

**Log files.** Logs are written to `./data/logs/{run_id}.log`. These may contain full file paths (including absolute paths to dataset files), command strings, and error messages. Paths are host-side paths that reveal the user's directory structure. This is not a leak outside the machine but should be noted if log files are ever shared for debugging.

**External URLs.** The FC pipeline downloads Nilearn atlases from GitHub/OSF on first run. The backend makes this outbound connection. No other external network requests are made by core features.

**Score: 64/100.** Local-first claims are honest. Docker socket exposure and lack of authentication are real risks in non-single-user scenarios. Path traversal protection is implemented correctly throughout.

---

## Perspective 8 — Reproducibility Reviewer

### Evaluation

**Built-in pipelines (Docker).** Each Docker run records: image name and tag, `RepoDigests` (docker content-addressable digest), full command, all parameters, start/end timestamps, exit code. The digest captures the exact image content, enabling byte-identical container replay. This is excellent reproducibility for Docker pipelines.

**Native Python pipelines.** Records: Nilearn version (from `nilearn.__version__`), scipy version (used in ALFF/ReHo), nibabel version, command string, all parameters, timestamps, exit code. Version capture is good. What is missing: Python version, scipy exact version, numpy exact version (only Nilearn version is explicitly captured in the metadata JSON). The `uv.lock` file in the repository pins all Python dependencies to exact versions, so for runs on the same Docker image this is reproducible. For local dev runs (outside Docker), dependency versions depend on the researcher's environment.

**Imported derivatives.** The "Import fMRIPrep Derivatives" pipeline records the path to the derivatives directory. It does not record a checksum of the directory contents. If the derivatives are modified after import, the provenance record cannot detect this. This is a known limitation of path-based provenance.

**Atlas provenance gap (Medium).** Nilearn atlases are downloaded at runtime from GitHub/OSF. The atlas file is cached locally. The provenance record captures `atlas_id`, `atlas_display_name`, `atlas_version` (e.g., "3v2" for AAL), and `atlas_source` URL. It does not capture the file checksum of the downloaded atlas. If Nilearn updates an atlas file at the same URL, two runs that appear identical in the provenance record may have used different atlas files.

**Plugin pipelines (Medium).** Plugin metadata (`plugin.yaml`) includes `version` and `id`. The run record captures these via the pipeline's `display_name`. However, plugin executables are not checksummed. A plugin update (changing the executable) without a version bump in `plugin.yaml` would be invisible in the provenance record.

**Workflow lineage.** `source_run_id` links derived runs to upstream runs. The Analysis Graph visualizes this. The provenance export (YAML) includes the `lineage` field. This is sufficient to reconstruct the full processing DAG.

**Methods Studio as reproducibility document.** The generated paragraph correctly states: tool name, version, atlas, correlation method, library versions. Missing: Python version, confound columns used (the FC tool uses hardcoded columns not a named strategy — so the methods paragraph cannot state what confounds were regressed). The confound strategy used in ALFF/ReHo/Seed is recorded via the `confound_strategy` parameter, which is better.

**Reproducibility scores by pipeline type:**

| Pipeline type | Score | Notes |
|---|---|---|
| Docker pipelines (MRIQC, fMRIPrep, FastSurfer, SynthStrip) | 88/100 | Container digest captured; full command recorded |
| Native Python (FC, ALFF, ReHo, Seed, Graph) | 76/100 | Library versions captured; atlas checksum missing; Python/numpy versions not in record |
| Import derivatives | 54/100 | Path only; no directory checksum; upstream run is external |
| Plugin pipelines | 68/100 | Plugin version captured; executable not checksummed |

**Overall reproducibility score: 73/100.**

---

## Perspective 9 — UX / Product Reviewer

### Evaluation

**Information architecture.** The sidebar (Datasets → Pipelines → Runs → Workflows → Library → Analysis tools → Publications) follows a roughly logical research workflow. The "Analysis tools" section (Datasets → [id] → Graph, Dashboard, Artifacts, Methods, Reports) is accessed through dataset navigation, which is correct but not immediately discoverable. A new user who navigates to a dataset may not notice the in-page sub-navigation tabs for these features.

**Sidebar navigation.** The sidebar includes "Remote Hosts" as a top-level item, but remote execution is not functional. Showing a non-functional top-level nav item creates a misleading impression. Users who click it and fill in SSH credentials will not be able to use them in practice.

**Consistency.** The visual design is consistent (dark theme, Tailwind utility classes, accent color). Button styles, status badges, and empty states follow a recognizable pattern. The two-character category icons (CV, QC, CN, etc.) in the workflow graph are functional but require a legend that is absent.

**Run Next card.** Well-implemented and clearly labeled. The pipeline list shows compute profile badges and the artifact type being consumed. The "Configure →" button navigates to the Pipelines page with the correct pipeline pre-selected and the artifact path pre-filled. This is one of the strongest UX features.

**Pages that feel overloaded:**
- `RunDetail` — shows logs, results, provenance, resource warnings, Run Next, metadata panel, and artifact download all on one page. For complex pipelines (fMRIPrep) with long logs and many output files, this page becomes unwieldy.
- `MethodsStudio` — shows methods paragraph, software table, parameter appendix, citation list, reproducibility concerns, provenance export, and workflow diagram on a single page with multiple download options. First-time users may not know where to start.

**Blank states.** `EmptyState` component is consistently used across pages. The Pipeline page empty state when no pipelines load (rare but possible) is handled. The Artifact Explorer empty state when no successful runs exist is clear. Good.

**Accessibility.** Most interactive elements lack explicit `aria-label` attributes. The two-character category icons in the Analysis Graph have no accessible names. The matrix preview canvas in Artifact Explorer has no alt text beyond "connectivity matrix preview." Focus management on modal dialogs is not verified. These are medium-severity accessibility gaps, not blocking for an alpha.

**Responsiveness.** The Tailwind grid/flex layout handles narrow viewports for most pages. The matrix heatmap canvas in ArtifactExplorer may overflow on narrow screens. The Analysis Graph (ReactFlow) is designed for desktop use — no touch interaction is expected.

**Score: 65/100.** Coherent information architecture and good Run Next UX. Non-functional sidebar items, overloaded detail pages, and missing accessibility attributes are medium-severity issues.

---

## Perspective 10 — Brainlife / FSL / Nilearn User Comparison

### Honest Comparison

**Brainlife (cloud-based app marketplace)**
- Brainlife provides cloud compute, version-pinned containerized apps, and a reproducibility record similar to Neuravian's.
- Where Neuravian is weaker: no compute scaling, no community app marketplace, no cloud storage.
- Where Neuravian adds value: runs entirely locally with no data upload; no cloud account required; no cost; dataset remains on the researcher's machine.
- Why use Neuravian alongside: local data residency requirements; institutions without Brainlife access; offline work.
- Why use Brainlife instead: for compute-heavy jobs; for institutions with Brainlife allocations; for community-contributed apps.

**FSL (command-line suite)**
- FSL provides BET, FEAT, FSL-GLM, MELODIC, FDT, and more — a full structural and functional pipeline.
- Where Neuravian is weaker: no GLM (first-level or second-level), no ICA, no diffusion, no FEAT-equivalent.
- Where Neuravian adds value: wraps FSL tools (SynthStrip via Docker) with provenance logging and error translation; coordinates FSL outputs with downstream analyses.
- Neuravian does not duplicate FSL algorithms; it depends on them.
- Why use Neuravian alongside FSL: to log FSL runs, manage outputs, and chain them to Nilearn-based connectivity.
- Why use FSL directly: for full feature access, scripting flexibility, and when GUI simplification is not needed.

**MRIQC (standalone quality control)**
- Neuravian wraps MRIQC and integrates its output into the artifact system. For users who only need MRIQC, installing it directly is simpler.
- Where Neuravian adds value: MRIQC runs tracked in the same workspace as FC, Comparison Studio can compare IQMs across preprocessing choices, and MRIQC feeds the workflow chain.

**fMRIPrep**
- Neuravian wraps fMRIPrep via Docker (same container as fMRIPrep users would pull directly) and adds Import Derivatives as an alternative entry point.
- The local-unsafe label for Apple Silicon is honest and appropriate.
- An experienced fMRIPrep user gains provenance tracking, artifact chaining, and Methods Studio output. They do not gain any preprocessing capability beyond what fMRIPrep itself provides.

**Nilearn**
- Neuravian wraps Nilearn's atlas-based connectivity pipeline and adds a parameter form, atlas management, and artifact-typed outputs.
- An experienced Nilearn user loses flexibility (e.g., bandpass filtering, ICA, decoding) but gains GUI, provenance, and publication integration.
- Neuravian is appropriate for Nilearn users who want reproducibility without scripting overhead.

**QSIPrep / MRtrix3 / AFNI / SPM**
- Not integrated. Neuravian does not compete with these tools in their core domains.

---

## Perspective 11 — Early Adopter Walk-Through

### Friction Points

**1. Discovering the repository.** README is clear and well-organized. The problem statement is compelling. The comparison table is honest. One concern: the README does not include a quick "what Neuravian is NOT" section, so a user who wants FSL FEAT will start installing before realizing it's not there.

**2. Understanding the README.** Architecture section with Mermaid diagram renders correctly on GitHub. Pipeline tables with compute profiles are easy to scan. Known Limitations section is easy to find.

**3. Installation.** The `.env.example` contains example values (`HOST_DATASETS_DIR=/Users/yourname/Documents`) that users may copy directly. Users whose home directory is not `/Users/yourname` will get a path that does not exist, causing the dataset import to silently show no datasets. This is the #1 first-run frustration point.

**4. Opening the app.** First visit shows the Welcome page with onboarding overlay. Clear and functional.

**5. Importing data.** Requires knowing the path to a BIDS dataset. The path must be within `HOST_DATASETS_DIR`. Users whose datasets are not under this directory must reconfigure `.env` and restart Docker. No in-app error explains this — the dataset list is simply empty.

**6. Launching a pipeline.** The pipeline form is intuitive. The atlas dropdown is clearly labeled. The `fmriprep-dir` field requires a file path that is not obvious for a first-time user (where is the Import fMRIPrep Derivatives output stored?).

**7. Interpreting results.** The FC pipeline results page is well-structured. The ROI statistics table is readable. The connectivity matrix heatmap renders correctly. The interpretation note ("This report computes descriptive connectivity only") is present but small.

**8. Generating methods.** The Methods Studio page is functional but overwhelming on first visit. A user who just ran one FC pipeline sees 5 tabs and 8 download buttons. A "Quick Copy" button for the methods paragraph would reduce friction significantly.

**9. Creating a report.** Study Report Studio generates a comprehensive HTML report. The PDF export (Playwright/Chromium) works but takes 20–30 seconds with no progress indicator visible to the user.

**10. Adding a plugin.** The plugin tutorial is complete. A developer with basic Python experience can follow it successfully. The only friction is that restarting Docker is required to load new plugins — there is no hot-reload.

**Score: 63/100.** The installation, first-run dataset discovery, and Methods Studio UX are the biggest friction points.

---

## Perspective 12 — Publication / Methods Reviewer

### Evaluation

**Generated methods wording.** The Methods Studio generates factually grounded paragraphs that correctly state tool names, versions, atlases, and correlation methods. The prose is grammatically correct and in journal-appropriate register. The explicit disclaimer at the bottom of each generated section ("All values are derived from logged provenance records. Please review and expand before submitting.") is appropriate.

**Citations.** The citation registry (`citationRegistry.ts` and `report_engine.py:_CITATIONS`) includes DOIs and journal information for MRIQC, fMRIPrep, FastSurfer, SynthStrip, Nilearn, AAL, Schaefer 2018, and others. These match the primary papers. Harvard-Oxford atlas citation is listed as "Desikan et al. 2006; FSL Harvard-Oxford atlas" — the Desikan-Killiany paper is for FreeSurfer parcellation, not the Harvard-Oxford atlas; the correct primary citation is Frazier et al. 2005 / Makris et al. 2006 / Desikan et al. 2006 depending on the version used. This is a factual error in the citation registry.

**Software versions in methods.** The methods paragraph captures Nilearn version. It does not capture Python version, scipy version, or NumPy version. For a computational paper this gap is acceptable (only the primary tool version is typically required), but for a methods supplement these would be useful.

**Parameter tables.** The parameter appendix lists all non-default parameters used across runs. This is correct and useful for a supplement. Default parameters are omitted, which is appropriate (they can be inferred from the version). However, for the FC pipeline, the confound columns used are not listed as a parameter — they are hardcoded and therefore not in the run record.

**Study report content.** The study report includes: pipeline summary, methods paragraphs, citation list, artifact inventory, quality metrics, and cluster analysis results. The HTML is well-structured and renders correctly in both light and dark mode. The PDF export (Playwright) produces a legible A4 document.

**Report comparison.** The comparison feature shows structural differences between two report versions. This is useful for tracking protocol evolution.

**Potential to mislead a paper reviewer:**
- The cluster tables from Statistical Map Explorer show peak values, cluster sizes, and MNI coordinates without an explicit note that these are not corrected for multiple comparisons. A reviewer who does not read the methods section carefully could misinterpret these as FWE/FDR-corrected clusters.
- The Harvard-Oxford atlas citation error could be caught by a careful reviewer.
- The methods paragraph does not state that global signal regression was included as a confound in FC (it is hardcoded, not a named parameter), which is a methodologically significant omission given ongoing debate about GSR.

**Score: 67/100.** Good foundation for methods generation. The GSR omission in FC methods, Harvard-Oxford citation error, and absent cluster correction warnings are the priority fixes.

---

## Scorecard

| Dimension | Score | Rationale |
|---|---|---|
| Scientific maturity | 62 | Correct algorithms, limited confound control, no inference |
| Engineering maturity | 66 | Clean architecture, module-level state debt, tool coupling |
| Usability | 63 | Better than CLI tools, terminology gaps, dataset discovery friction |
| Reproducibility | 73 | Excellent Docker provenance, native atlas gap, no dir checksums |
| Privacy posture | 68 | Local-first claims accurate, Docker socket risk, no auth |
| Contributor readiness | 72 | Good docs, working plugin system, no Discussions |
| Documentation | 74 | Comprehensive for alpha, tutorial is thorough |
| Public-alpha readiness | 71 | Functional for supervised single-user research use |
| Lab-pilot readiness | 68 | Needs auth or access controls for shared machines |
| Production readiness | 38 | No auth, sequential queue, incomplete remote execution |

**Overall platform score: 66/100**

---

## Top 10 Strengths

1. **Manifest-driven pipeline registry.** No pipeline logic is hardcoded in application code. Adding a tool means writing YAML. This is the right abstraction for a platform that will grow.

2. **Artifact-typed chaining.** `accepts[]`/`produces[]` declarations create a typed graph of compatible pipeline connections. The "Run Next" feature derives from this automatically — no rules table, no hardcoded relationships.

3. **Complete Docker provenance including container digest.** `RepoDigests` capture means Docker-based runs are bit-reproducible, not just tag-reproducible. This is better than most neuroimaging workflow managers.

4. **Methods Studio from provenance.** Template-filled methods paragraphs generated from the audit trail, not from AI. The "not recorded" sentinel when data is absent is the correct approach.

5. **Read-only dataset mounts.** Source data cannot be modified by any Neuravian operation. This is a strong safety guarantee that eliminates an entire class of user accidents.

6. **Run Next UX.** One-click launch of compatible downstream pipelines with artifact path pre-filled. This is the most effective onboarding feature in the platform — it shows new users what is possible without requiring them to know the pipeline graph.

7. **Plugin SDK with complete working example.** `plugins/image-statistics/` demonstrates every SDK feature. `docs/plugin-tutorial.md` walks through a new plugin step by step. External contributors can extend the platform without forking.

8. **Stalled-run recovery.** Runs left in "running" state after a crash are detected on restart and marked "interrupted" with a Retry button. This is a small feature that has a large quality-of-life effect.

9. **Path traversal protection.** Consistently applied across all file-serving endpoints using Python `Path.relative_to()`. This is implemented correctly throughout.

10. **Sequential, auditable execution queue.** Each run runs to completion before the next starts. Combined with a queue status endpoint and cancel support, this makes the execution state always deterministic and observable.

---

## Top 10 Risks

1. **Docker socket privilege escalation.** Any code reaching the backend — including plugin executables — can run arbitrary Docker containers on the host. Not for deployment on shared or networked machines.

2. **No authentication.** All API endpoints are accessible without credentials. A network-exposed deployment is fully open to any user on the network.

3. **Hardcoded confound columns in FC pipeline.** Users cannot control confound regression in the main connectivity pipeline. Global signal regression status is not recorded in provenance or methods output.

4. **Module-level state in execution layer.** `_log_buffers`, `_MOUNTS`, `_registry`, and plugin state are all module-level. Memory growth in `_log_buffers` is unbounded. Stale `_MOUNTS` cache could cause silent path translation errors.

5. **Tool-to-tool coupling through imports.** Three tools (`seed_based_connectivity`, `alff_falff`, `regional_homogeneity`) import private functions from `functional_connectivity.py`. Changes to FC internals silently break the other three.

6. **SSH remote execution not functional.** The settings page and database models exist but no run creation path uses the SSH executor. Users who configure remote hosts for HPC submission will find it does not work.

7. **Statistical cluster tables without inference warning.** Cluster size and peak values in the Statistical Map Explorer output could be misread as corrected for multiple comparisons. The warning exists in the run results panel but not in exported HTML cluster reports prominently enough.

8. **Harvard-Oxford atlas citation error.** The citation registry attributes the Harvard-Oxford cortical atlas to Desikan et al. 2006 (a FreeSurfer parcellation paper). This factual error propagates to exported citation lists.

9. **HOST_UID/HOST_GID defaults to 0.** FastSurfer containers start as host root if the user does not configure these variables, which is the default in `docker-compose.yml`.

10. **No rate limiting on run creation.** Unlimited runs can be submitted to the queue. No throttle or concurrency limit per dataset or user.

---

## Critical Issues (require fix before public alpha)

No issues classified as Critical were found. Path traversal protection is implemented. No data loss path was identified. The application runs correctly in the verified configuration.

---

## High Issues (fix recommended before or shortly after public alpha)

### H1: Harvard-Oxford atlas citation error
- **Perspective:** Publication / Methods Reviewer
- **File:** `frontend/src/lib/citationRegistry.ts`, `backend/app/services/report_engine.py:_CITATIONS`
- **Why it matters:** The exported citation list incorrectly attributes the Harvard-Oxford cortical atlas. This is a factual error that could appear in a submitted manuscript.
- **Evidence:** `citation: "Desikan et al. 2006; FSL Harvard-Oxford atlas"` — Desikan et al. 2006 describes FreeSurfer's aparc parcellation, not the Harvard-Oxford atlas.
- **Recommended fix:** Replace with the correct citations: Frazier et al. 2005 (doi:10.1016/j.biopsych.2004.08.025) and Makris et al. 2006 (doi:10.1016/j.neuroimage.2005.09.024) for the two halves of the atlas.
- **Blocks public alpha:** No (factual error, not a safety issue). **Blocks lab use:** No. **Blocks v1.0:** Yes.

### H2: Confound columns hardcoded in FC pipeline with no user control
- **Perspective:** Neuroimaging Researcher, Research Software Engineer
- **File:** `backend/app/tools/functional_connectivity.py:L44`
- **Why it matters:** Users cannot control confound regression strategy. Global signal regression is silently applied and not captured in methods output. Silent failure when confound columns are missing.
- **Evidence:** `CONFOUND_COLUMNS = ["trans_x", ..., "global_signal"]` — hardcoded list with no manifest parameter.
- **Recommended fix:** Add a `confound-strategy` parameter to the FC manifest and tool, using the existing `confounds.py` strategy system. This is a Medium-scope change.
- **Blocks public alpha:** No. **Blocks lab use:** No, but should be disclosed. **Blocks v1.0:** Yes.

### H3: Docker socket privilege escalation not documented for deployment
- **Perspective:** Privacy / Security Reviewer
- **File:** `docker-compose.yml:L24`, `SECURITY.md`
- **Why it matters:** Docker socket mount grants full host Docker daemon access. This is acceptable for single-user local use but dangerous on shared machines.
- **Evidence:** `- /var/run/docker.sock:/var/run/docker.sock`
- **Recommended fix:** Add a visible warning to `README.md` Local Setup section: "Neuravian mounts the Docker socket. Do not expose ports 3000 or 8000 to external networks. This deployment is designed for single-user local use only."
- **Blocks public alpha:** No (already documented in SECURITY.md). **Blocks production:** Yes.

### H4: Cluster tables lack inference warning in exported HTML
- **Perspective:** Publication / Methods Reviewer, Neuroimaging Researcher
- **File:** `backend/app/tools/statistical_map_explorer.py:_HTML_TEMPLATE`
- **Why it matters:** Users who export the cluster report HTML for a paper may present cluster sizes as inferential findings.
- **Evidence:** The cluster report HTML does not contain a visible warning that cluster statistics are not corrected for multiple comparisons.
- **Recommended fix:** Add a prominent warning box to the cluster report HTML: "These results are not corrected for multiple comparisons. Cluster sizes and peak values are descriptive. Do not interpret as statistically thresholded."
- **Blocks public alpha:** No. **Blocks lab use:** Depends on oversight. **Blocks v1.0:** Yes.

### H5: Tool-to-tool coupling through private imports
- **Perspective:** Research Software Engineer
- **File:** `backend/app/tools/seed_based_connectivity.py`, `alff_falff.py`, `regional_homogeneity.py`
- **Why it matters:** Changes to `functional_connectivity.py` internals silently break three other tools.
- **Evidence:** `from app.tools.functional_connectivity import _select_bold, _load_confounds, _load_atlas, ATLAS_REGISTRY`
- **Recommended fix:** Extract shared functions into `backend/app/tools/_bids_utils.py` and `_atlas_utils.py`.
- **Blocks public alpha:** No. **Blocks v1.0:** Yes.

---

## Medium Issues (report; fix before v1.0)

| ID | Issue | File | Impact |
|---|---|---|---|
| M1 | `_log_buffers` unbounded memory growth | `run.py` | Memory leak on long-running server |
| M2 | No database indices on FK columns | `alembic/versions/` | Query slowdown at scale |
| M3 | Report PDF generation in background thread (not queue) | `reports.py` | Concurrency with pipeline runs |
| M4 | Seed ROI selection by numeric index not by name | `seed-based-connectivity.yaml` | UX error risk for beginners |
| M5 | `_MOUNTS` cache never invalidated | `docker_executor.py` | Stale after Docker state change |
| M6 | `Remote Hosts` sidebar link visible despite non-functional | `Sidebar.tsx` | User confusion |
| M7 | No warning when FC confound columns missing from TSV | `functional_connectivity.py` | Silent analysis change |
| M8 | Plugin executables are not checksummed | `plugin_loader.py` | Plugin update not detectable |
| M9 | Group FC averages raw r-values, not Fisher z | `group_functional_connectivity.py` | Technically incorrect averaging |
| M10 | Atlas file checksums not captured | FC/ALFF/ReHo/Seed tools | Reproducibility gap |

---

## Low Issues

| ID | Issue |
|---|---|
| L1 | Missing `aria-label` on category icons in Analysis Graph |
| L2 | Matrix canvas in ArtifactExplorer has no alt text |
| L3 | CI runs frontend and backend jobs sequentially |
| L4 | No plugin hot-reload (Docker restart required) |
| L5 | `package.json` and `pyproject.toml` version says "0.1.0" not "0.1.0-alpha" |
| L6 | No "Methods Quick Copy" button — the primary action requires 2 clicks and a tab change |
| L7 | `docs/architecture/neuroimaging-platform-architecture.md` is a stale legacy planning document |

---

## Strengths Summary

**Strongest technical decisions:**
- Manifest-driven registry — enables external contribution without application code changes
- `source_run_id` lineage field — enables the Analysis Graph and comparison classification
- Lazy `_get_svc()` in `api/pipelines.py` — correct fix for the lifespan ordering problem
- `relative_to()` path traversal protection — applied consistently throughout

**Strongest scientific integrations:**
- ALFF/fALFF with Nyquist validation and configurable frequency bands
- ReHo with proper KCC formula and neighborhood size options
- MRIQC wrapping with HTML report embedding
- FastSurfer via Docker with host UID passthrough

**Most differentiated features:**
- Artifact-typed Run Next (no comparable feature in FSL, Nilearn, or MRIQC directly)
- Methods Studio generating from provenance records (not LLM)
- Comparison Studio with same-source vs. unverified classification
- Plugin SDK with zero-fork external contribution path

---

## Missing Capability Review

### Must-have before v1.0

| Capability | Notes |
|---|---|
| Confound strategy parameter in FC pipeline | Currently hardcoded; scientifically important |
| Cluster inference warning in HTML export | Factual safety issue |
| Auth or network access control documentation | Required for lab use |
| Fisher z-averaging in Group FC | Technically correct approach |

### Useful but optional

| Capability | Notes |
|---|---|
| First-level GLM (nilearn FirstLevelModel) | High value for task fMRI; medium complexity |
| Bandpass filtering option in FC | Available in Nilearn masker; parameter addition |
| Atlas file checksum in provenance | Reproducibility improvement |
| Run queue parallelism | Low priority for alpha; needed at scale |

### Better as plugins

| Capability | Notes |
|---|---|
| MRSI / spectroscopy | Highly specialized; small user base |
| Custom atlas support | Per-lab variation; plugin architecture suits this |
| AFNI wrappers | Duplication with FSL wrapping; plugin appropriate |
| ROI-based morphometry | Niche enough to be plugin-first |

### Requires x86_64 / VM

| Capability | Notes |
|---|---|
| fMRIPrep on Apple Silicon | Already labeled local-unsafe; correct |
| FSL FEAT full GLM | FLIRT/FEAT are x86 containers under Rosetta 2 |
| ANTs non-linear registration | ANTs via Docker is slow on Apple Silicon |

### Not appropriate for Neuravian (core)

| Capability | Notes |
|---|---|
| Clinical diagnosis tools | Out of scope by design |
| HIPAA-certified storage | Requires external infrastructure |
| Custom deep learning training | Not a research platform goal |
| Multi-user permission system | Planned as future roadmap |

---

## Adoption Barriers

**For individual researchers:**
- Dataset must be within `HOST_DATASETS_DIR` — not immediately obvious from the UI when it fails
- fMRIPrep still requires a FreeSurfer license
- Apple Silicon users face slow pipeline execution for several tools

**For labs:**
- No authentication — requires network isolation for safety
- SSH remote execution is non-functional — HPC users cannot submit jobs
- No audit log of who ran what

**For contributors:**
- No GitHub Discussions
- No documented core-vs-plugin guidance
- Large PR scope (pipeline + test + manifest + README update)

---

## Recommended Next 5 Milestones

### Milestone 1: Scientific Correctness (v0.1.1)
Fix the Harvard-Oxford citation. Add a cluster table inference warning to exported HTML. Add a confound columns disclosure to the FC methods paragraph output. Add Fisher z-averaging to Group FC with a release note.

### Milestone 2: Confound Control (v0.1.2)
Add `confound-strategy` parameter to the FC manifest and tool, backed by `confounds.py`. This surfaces confound choice in methods output, enables user control, and fixes the silent failure on missing columns. Update FC test suite.

### Milestone 3: Modularity Refactor (v0.1.3)
Extract `_select_bold`, `_load_confounds`, `_load_atlas`, `ATLAS_REGISTRY`, `_entity`, and `_matching_confounds` into shared utility modules. Remove cross-tool imports from private namespaces. Add `_log_buffers` eviction policy. Add FK indices to the database via a new migration.

### Milestone 4: Access Controls and Deployment Safety (v0.2.0)
Add a visible network exposure warning to the README and the Welcome page (detect if the API is reachable from a non-localhost origin). Add optional basic HTTP auth behind an env variable. Document Docker socket risk prominently. Clarify that Remote Hosts / SSH execution is not yet functional.

### Milestone 5: Usability Polish (v0.2.1)
Atlas-by-name seed selection in Seed Connectivity. One-click "Copy Methods" on Methods Studio. Dataset import guidance when path is outside HOST_DATASETS_DIR. Progress indicator for PDF report generation. Remove or clearly label the Remote Hosts sidebar item as "coming soon."

---

## Public-Alpha Recommendation

**Ready for public alpha** — with the following conditions:
1. The Harvard-Oxford citation error should be corrected before announcing the release widely (a small factual fix, see H1 above).
2. The cluster table inference warning should be added to exported HTML (H4 above) before the platform is promoted to clinical-adjacent users.
3. The README and SECURITY.md already contain the right language about single-user local use. No additional changes are required for the alpha announcement.

The platform is functional for its stated audience (researchers running resting-state fMRI locally with Apple Silicon Macs) and delivers real value in provenance, artifact chaining, and methods generation.

---

## Lab-Pilot Recommendation

**Ready for supervised lab pilot** — with the following requirements from the adopting lab:
1. The machine running Neuravian must not expose ports 3000 or 8000 to other network users.
2. A technically experienced lab member (postdoc or senior student) should supervise initial use and verify that FC confound strategy matches the lab's preprocessing protocol.
3. fMRIPrep should be run externally (HPC, Brainlife) and results imported via "Import fMRIPrep Derivatives."
4. The cluster table warning issue (H4) should be resolved or users briefed explicitly.

---

## v1.0 Requirements

Before v1.0, the following must be addressed:
1. H1: Harvard-Oxford citation corrected
2. H2: FC confound strategy user-configurable and recorded in provenance
3. H4: Cluster table inference warning in exported reports
4. H5: Tool-to-tool coupling refactored into shared utilities
5. M1: Log buffer eviction policy
6. M6: Remote Hosts sidebar item removed or clearly labeled non-functional
7. M9: Fisher z-averaging in Group FC
8. Authentication option (even basic HTTP auth) for shared-machine deployments
9. At minimum one parallel execution lane in the queue
10. Database FK indices

---

## Positioning Statement

Neuravian is the reproducibility and publication layer for local neuroimaging research — it does not replace FSL, FreeSurfer, or Nilearn, but gives those tools a shared workspace where every run is auditable, every artifact is typed, and every methods section writes itself.

---

## Why Should Someone Use Neuravian?

Because you are tired of not knowing which version of Nilearn generated that connectivity matrix six months ago, and because assembling a methods section from shell history at 11pm before a submission deadline is not a reproducibility strategy.

Neuravian captures what ran, what version, what parameters, what it consumed, and what it produced — at the moment it runs — and turns that record into a navigable analysis history, a typed artifact graph, and a draft methods paragraph. It does not make the science easier. It makes the infrastructure around the science stop absorbing the time the science needs.
