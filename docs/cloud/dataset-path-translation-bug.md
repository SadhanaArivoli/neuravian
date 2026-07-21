# Cloud dataset path translation

## Root cause

NeuroForge has three filesystem namespaces during a containerized pipeline run:

| Namespace | Dataset path for the verification fixture | Purpose |
| --- | --- | --- |
| EC2 host | `/srv/neuroforge/datasets/x86-minimal-bids` | Docker bind source |
| Backend container | `/host-data/x86-minimal-bids` | Import, indexing, preflight, and database record |
| Scientific child container | `/data` or `/inputs/bids-dir/x86-minimal-bids` | Tool command argument |

The backend successfully imported the fixture because Compose mounts the host
dataset root at `/host-data`. Run creation then called the generic
`to_host_path()` translator and tested the translated `/srv/...` path with
`Path.exists()` **inside the backend container**. `/srv/...` belongs to the EC2
host namespace and is intentionally not visible there, so the valid dataset was
reported as missing. Conversely, `/host-data/...` is not a valid path when the
Docker daemon evaluates a child-container bind source.

## Canonical path model

Dataset database records remain in the stable backend form under
`BACKEND_DATASETS_MOUNT` (default `/host-data`). `HOST_DATASETS_MOUNT` supplies
the equivalent host root and is populated from Compose's `HOST_DATASETS_DIR`.
`DatasetPathResolver` derives both forms from one relative path beneath those
roots.

The resolver:

- accepts either configured host or backend form;
- normalizes URL-encoded input and path components;
- rejects traversal, outside-root paths, and visible symlink escapes;
- preserves spaces and Unicode;
- fails explicitly if host/backend root configuration is incomplete.

No database migration or dataset re-import is required. Existing records such
as `/host-data/x86-minimal-bids` are already in the canonical form.

## Path flow

1. **Import request** — `DatasetService` accepts a configured host-form or
   backend-form path and resolves it once.
2. **Database record** — the service stores the canonical backend path, for
   example `/host-data/x86-minimal-bids`.
3. **Pipeline form** — the frontend submits the selected record and the logical
   parameter value; it performs no host translation.
4. **Pipeline preflight** — `PreflightService` maps dataset inputs to the backend
   form and checks that backend-visible path.
5. **Run validation** — `RunService` also checks the backend form. It never probes
   the translated host path from inside the backend container.
6. **Docker SDK bind** — `DockerExecutor` resolves the same logical dataset path
   to the configured host form, such as
   `/srv/neuroforge/datasets/x86-minimal-bids`, for the bind source.
7. **Scientific command** — the executor passes only the manifest's child path.
   Positional dataset pipelines receive `/data`; BIDS Validator receives
   `/inputs/bids-dir/x86-minimal-bids`.

Output and work-directory mounts continue to use the generic container-mount
introspection logic. Scientific manifests, commands, dataset contents, numerical
behavior, and output semantics are unchanged.

## Affected code

- `backend/app/services/dataset_paths.py` — canonical secure resolver.
- `backend/app/services/dataset.py` — import normalization and canonical record.
- `backend/app/services/preflight.py` — backend-namespace readability checks.
- `backend/app/services/run.py` — backend-namespace launch validation.
- `backend/app/execution/docker_executor.py` — host bind source and child path.
- `docker-compose.yml` — explicit backend dataset mount configuration.

Local macOS behavior is preserved: a host dataset beneath the configured local
`HOST_DATASETS_DIR` still maps to `/host-data/...`, and non-container local
execution continues to use directly accessible local paths when no translation
is configured.
