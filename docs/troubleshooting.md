# Troubleshooting Guide

## Start with the recovery message

Run and synchronization errors should identify what failed and retain raw logs.
Record the run ID, pipeline name, workspace, and exact message before retrying.

## Docker or startup failure

1. Confirm Docker is running with `docker info`.
2. Run `docker compose ps` and verify backend health.
3. Inspect `docker compose logs --tail=200 backend frontend`.
4. Rebuild and recreate services after source changes.

Do not delete `data/neuroforge.db` as a routine recovery step. Preserve it and
diagnose the migration or filesystem error first.

## Dataset rejected

Confirm the path is inside `HOST_DATASETS_DIR`, readable by Docker, and points
to the BIDS dataset root containing `dataset_description.json`. NeuroForge does
not rewrite source data. Use validation issue details to fix the source safely.

## Pipeline crash or missing artifact

Open the run and review **What failed**, **Likely cause**, **What to try**, and
the raw log. Confirm that the upstream run succeeded and produced the exact
artifact type required by the next pipeline. For container failures, also check
image availability, disk space, and Docker memory limits.

## Cloud unavailable

Confirm the EC2 instance state, current public hostname, HTTPS health, and saved
credential. A stopped instance can be started from its configured workspace.
If an ephemeral public IP changed, update the public gateway hostname before
retrying. A paused handoff resumes from the first incomplete node.

## Authentication failure

Re-enter the credential for the intended workspace. Do not paste credentials
into logs, screenshots, issue reports, or repository files.

## Viewer unavailable

Synchronize cloud-only artifacts first. Confirm the file exists and is a
supported type. For FreeView or MRIcroGL, install or locate the application and
retry. Geometry mismatch messages protect against misleading overlays and
should not be bypassed.

## Cancelled or interrupted run

Cancelled work remains in history with its provenance. An unexpected shutdown
causes incomplete runs to be marked interrupted after restart. Use **Duplicate
Run** or the recovery action to review parameters before launching again.
