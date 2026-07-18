# Unified Cloud Workspace and Desktop Client

## Responsibility model

A NeuroForge deployment is the source of truth. NeuroForge Desktop is a rich
client with a small read-through metadata cache and an artifact cache; it does
not create a second scientific database or duplicate projects, datasets, runs,
reports, or provenance.

Each connection profile represents one deployment:

```text
Workspace
  Projects
    Datasets
      Workflows
        Runs
          Reports
          Provenance
          Logs
          Artifact metadata
```

Datasets that have not been assigned to a project remain visible under the
desktop-only `Workspace datasets` grouping. This grouping is presentation state,
not a synthetic server project or copied data.

## Stable remote identity

The backend exposes `GET /api/workspace/identity`. Its opaque UUID is derived
from `NEUROFORGE_SERVER_ID` when configured, otherwise from a one-way digest of
the deployment machine identity. The source value is never returned.

Desktop resource keys use:

```text
<workspace UUID>:<resource type>:<server resource ID>
```

Integer server IDs therefore cannot collide across two NeuroForge deployments.
Changing a profile URL does not change resource identity. If a known profile
answers with a different workspace UUID, synchronization fails closed.

## Connection profiles and credentials

Profiles contain only:

- display name;
- normalized HTTPS server URL;
- OS credential reference;
- last successful server identity;
- last synchronization timestamp;
- connection state.

Username and password are serialized separately, encrypted with Electron
`safeStorage`, and written with mode `0600`. On macOS, `safeStorage` is backed by
the user's Keychain. If OS encryption is unavailable, saving credentials fails.
Credentials are never returned with profile listings, added to URLs, committed,
or logged. Plain HTTP is rejected except for explicit loopback development
workspaces.

## Metadata synchronization

Desktop reuses the existing backward-compatible APIs for projects, project
datasets, datasets, workflows, runs, reports, provenance, results, logs, and
sync manifests. Only the stable workspace identity endpoint was added.

The first synchronization fetches the small object graph and writes one atomic,
mode-`0600` JSON snapshot per profile. The desktop refreshes the active
workspace every 15 seconds. Unchanged artifact contents are not transferred;
sync manifests provide metadata, checksums, and geometry only.

The snapshot contains no server filesystem paths or credentials. Run outputs
remain remote until explicitly requested.

## Project and workflow tree

The desktop-only Workspaces page displays server objects directly:

- project records group their assigned datasets;
- saved workflow state supplies workflow names and pipeline-node hierarchy;
- runs are matched to the workflow's dataset and pipeline nodes;
- unmatched runs remain under Run history;
- reports, provenance, results, logs, parameters, progress, artifact checksums,
  and geometry remain attached to their workspace-scoped run identities.

The current run schema does not store a direct saved-workflow ID. Until that
backward-compatible relationship exists, two saved workflows containing the
same pipeline and dataset can both display the applicable run. No run record is
created or modified by this presentation rule.

## Cache lifecycle

Runs display one of:

- Cloud Only
- Downloading
- Partially Cached
- Fully Cached
- Offline Cached
- Local Only
- Server Unavailable

Artifact caches are partitioned by workspace UUID and run ID:

```text
run-cache/
  <workspace UUID>/
    run-7/
      run-metadata.json
      artifacts/
        sub-01/mri/orig_nu.mgz
        sub-01/mri/aseg.auto.mgz
```

Every cache inspection checks the expected byte count and SHA-256 digest.
Partial downloads use `.partial` files and HTTP Range resume. A previously
downloaded file is reused only after verification.

## Viewer workflow

For the FastSurfer FreeView preset, Desktop requests only:

- `orig_nu.mgz`;
- `aseg.auto.mgz`.

It verifies both checksums and their complete shape, voxel size, orientation,
and affine metadata, then launches FreeView with argument arrays and
`shell: false`. No resampling occurs. Versioned macOS FreeSurfer installations
are detected safely, and only their matching `FREESURFER_HOME` is added to the
viewer process environment. The existing license is neither copied nor
modified.

The same action works offline only when the exact required artifacts are
already verified in cache. Remote-only actions remain disabled.

## Offline behavior

When synchronization fails, Desktop reads the last atomic metadata snapshot:

- projects, datasets, workflows, runs, reports, history, provenance, methods,
  and logs remain visible;
- runs with verified cached artifacts become Offline Cached;
- uncached runs become Server Unavailable;
- cached viewer launches remain available when every preset input is present;
- no remote mutation is attempted.

## Security boundaries

- HTTPS is mandatory outside loopback.
- Server identity changes fail closed.
- Credentials stay in OS-backed encrypted storage.
- Artifact selection is an exact allow-list from the server manifest.
- Absolute paths, traversal, null bytes, and cache escapes are rejected.
- Viewer executables must be absolute reviewed paths.
- Viewer arguments must remain inside the workspace-scoped cache.
- Child processes use `shell: false`.
- No browser authentication, gateway configuration, TLS, Terraform, run,
  dataset, output, provenance, or license behavior is changed.

## Verification

Canonical automated gates:

```bash
./scripts/test-backend.sh
cd frontend && npm test && npx tsc --noEmit && npm run build
cd desktop && npm test && npm run typecheck && npm run build
```

The July 2026 live EC2 verification synchronized dataset 1 and Runs 1–7,
downloaded only the two Run 7 FreeView inputs, reused both on the second launch,
verified their checksums and geometry, launched FreeView 8.0.0, and retained all
metadata plus exact cached-artifact availability during a simulated outage.

## Future multiple-workspace support

The profile, identity, metadata, and artifact paths are already partitioned for
multiple deployments. Future work can add profile ordering, organization
policy, SSO credential providers, incremental server cursors, and a durable
workflow-to-run foreign key without changing the workspace-scoped identity or
cache contracts.
