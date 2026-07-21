# Frequently Asked Questions

---

## Installation and setup

### Docker says "port 3000 is already in use"

Another process is using port 3000. Either stop it, or change the frontend port in `docker-compose.yml`:

```yaml
frontend:
  ports:
    - "3001:3000"   # change left side only
```

### The backend container exits immediately

Check the logs:

```bash
docker compose logs backend
```

Common causes:
- **SQLite migration failed** — preserve `data/neuroforge.db`, capture the
  migration error, and confirm the current Alembic revision. Restore from a
  backup or request support; do not delete the database as a routine fix.
- **Bad `.env` file** — verify that `HOST_DATASETS_DIR` exists on your machine.
- **Permission denied on Docker socket** — your user must be in the `docker` group (Linux) or Docker Desktop must be running (macOS/Windows).

### I do not see my datasets in NeuroForge

`HOST_DATASETS_DIR` in `.env` must be the directory *containing* your BIDS folders, not a BIDS folder itself.

Example: if your dataset is at `/Users/alice/research/my-study/`, set:

```
HOST_DATASETS_DIR=/Users/alice/research
```

Then in NeuroForge, create a dataset with path `/Users/alice/research/my-study`.

---

## Pipelines and runs

### A pipeline fails immediately with "command not found"

The tool's Docker image has not been pulled yet, or the native executable is missing from PATH.

- **Docker pipelines (MRIQC, FastSurfer, etc.):** the image is pulled automatically on first run. If pull fails, check your internet connection and Docker Hub access.
- **Native pipelines:** this should not happen with built-in pipelines. If you see it for a plugin, verify that the `backend/` directory contains an executable file with a matching name and `chmod +x`.

### fMRIPrep fails or produces bad results on Apple Silicon {#fmriprep-apple-silicon}

fMRIPrep runs the `linux/amd64` Docker image under Rosetta 2 on Apple Silicon. ANTs non-linear registration (used internally by fMRIPrep) is known to produce unreliable outputs and excessive memory consumption under this emulation layer.

**Recommended approach on Apple Silicon:** run fMRIPrep on a Linux machine or HPC cluster, then use **Import fMRIPrep Derivatives** to register the results in NeuroForge.

### A run is stuck at "running" after a restart

When NeuroForge shuts down unexpectedly (e.g. `docker compose down` while a run is executing), the run record is left in `running` state. On the next startup, the stalled-run detector marks these as `interrupted`.

If you see an `interrupted` run, you can re-run it from the run detail page.

### Can I run multiple pipelines simultaneously?

Not yet. The execution queue is sequential by design. One job runs at a time.

This is a deliberate choice for a laptop-first deployment: most neuroimaging tools are CPU- and memory-intensive, and running them in parallel would cause resource contention.

Parallel execution is on the roadmap for v0.2.

### How do I cancel a running job?

Open **Runs** → find the running run → click **Cancel**. The cancel sends a `SIGTERM` to the subprocess or stops the Docker container.

---

## Artifacts and data

### Where are my analysis outputs stored?

All derivatives are written to `./data/derivatives/<pipeline-id>/<run-id>/` on the host, relative to the repository root. This directory is mounted into the backend container at `/app/data/`.

Your source datasets (in `HOST_DATASETS_DIR`) are mounted read-only. NeuroForge never writes to them.

### How do I delete outputs from a run?

Open **Runs** → run detail page → **Delete Run**. This removes the run record and all associated artifacts from the database. The output files in `data/derivatives/` are not deleted automatically — remove them manually if you need to reclaim disk space.

### Can I import existing analysis outputs that were not produced by NeuroForge?

Yes, for supported derivative formats. Use:
- **Import fMRIPrep Derivatives** — for fMRIPrep outputs
- **NIfTI Inspector** — to register and inspect any NIfTI file directly

For other formats, a plugin can import and register arbitrary file types.

---

## Reproducibility

### What exactly is logged in the provenance record?

Every run records:
- Pipeline ID and display name
- Tool version (from manifest or runtime detection)
- Docker image and digest (for containerized tools)
- Full command executed
- All parameters (including defaults)
- Input artifact IDs and file paths
- Output artifact IDs and file paths
- Start time, end time, and wall-clock duration
- Exit code, stdout, and stderr

This record is permanent and cannot be edited after the run completes.

### How do I generate a methods section?

Open your dataset → **Reports** → **Methods Studio** → **Generate Methods**. The output is a draft methods paragraph filled from the provenance records of all runs on the dataset.

The text names tools, versions, atlases, parameters, and confound strategies in methods-section prose. It is a template-filled draft — review and edit before submission.

### Can I export the provenance record?

Yes. From the run detail page, expand **Provenance record** to see the full JSON. You can copy it or use the export button to download it.

---

## Plugins

### Where do I install a plugin?

Put the plugin directory in `plugins/` at the repository root, or set the `NEUROFORGE_PLUGINS_DIRS` environment variable to point at one or more directories containing plugin directories.

### My plugin shows as "error" in the Plugins page

Open `docker compose logs backend | grep plugin` — the error message is logged there. Common causes:
- Missing required field in `plugin.yaml`
- `category` using a hyphen instead of underscore (use `quality_control`, not `quality-control`)
- Pipeline ID conflicts with a core pipeline

### Can a plugin override a core pipeline?

No. If a plugin defines a pipeline ID that conflicts with a core pipeline, the plugin fails to load with an error. Rename the pipeline in your plugin.

### Can I disable a plugin without removing it?

Yes. Set `enabled: false` in `plugin.yaml`. The plugin is discovered but its pipelines and artifact types are not registered.

---

## Data privacy

### Does NeuroForge send my data anywhere?

NeuroForge is local-first. No data is uploaded unless you explicitly configure
a cloud workspace and confirm a workflow handoff. The handoff transfers only
manifest-verified inputs required by the remote node.

### Is NeuroForge HIPAA-compliant?

NeuroForge is research software, not a certified clinical system. It does not implement access controls, audit logging to an external system, encryption at rest, or any other regulatory compliance feature. Do not use it to process identifiable patient data in a clinical or regulated context without independent security review.

For research use with de-identified data, NeuroForge's local-first design (no network egress by default) is a reasonable starting point. Add pydeface to your pipeline to remove facial features before analysis if needed.

---

## Development

### How do I run tests?

```bash
# Backend
cd backend
uv run pytest

# Frontend
cd frontend
npx tsc --noEmit
npx vitest run
npx vite build
```

### How do I add a new pipeline?

Write a YAML file in `pipelines/` following the manifest schema (`pipelines/schema/manifest.schema.json`). See any existing manifest for structure. No application code changes are required.

### How do I contribute?

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the development setup, test requirements, and pull request checklist.
