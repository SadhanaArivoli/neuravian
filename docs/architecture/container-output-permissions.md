# Container output permissions

NeuroForge creates a separate derivatives directory for every run and bind-mounts
that directory at `/out`. The backend normally runs as root inside its own
container. Without preparation, a directory created through the backend's data
mount is therefore owned by root on the host.

## Previous behavior and root cause

Root-running pipeline containers could write to those root-owned directories.
Containers launched with `run_as_host_user: true` could not: Docker correctly ran
the tool with the numeric host UID and GID, but `/out` remained `root:root 0755`.
The non-root process could read the directory but could not create results.

## Ownership policy

The Docker executor now prepares only the current run's output directory before
starting a container with an explicit numeric runtime identity:

1. Require an absolute path below the configured derivatives root.
2. Reject `..`, symlinks, and paths that resolve outside that root.
3. Create the run directory if it does not exist.
4. Change the owner of that directory, and only that directory, to the effective
   runtime UID and GID.
5. Preserve its existing group and other access bits while ensuring owner
   read/write/execute access.
6. Re-open without following symlinks and verify the resulting owner and mode.
7. Record the numeric identity, action, and final mode in the execution log.

The executor does not recursively change existing files. Historical outputs,
seeded contents, datasets, and sibling runs retain their original ownership.
The backend artifact collector retains access because it runs as root in the
backend container. The policy does not use world-writable modes.

Containers using the image's default user retain the previous behavior. This is
appropriate for the existing root-running pipelines. An image whose default user
is non-root must declare its runtime identity explicitly so NeuroForge can prepare
the bind mount deterministically.

## Manifest declarations

Use one of these mutually exclusive top-level fields:

```yaml
run_as_host_user: true
```

This reads the deployment-provided numeric `HOST_UID` and `HOST_GID` and passes
that identity to Docker.

For an image that requires a fixed numeric identity, plugin authors may use:

```yaml
run_as_user:
  uid: 1001
  gid: 1001
```

Both values are schema-validated non-negative integers. Usernames, shell
expressions, and manifest-derived path commands are not accepted.

Do not declare either field for a root-running image that already works with the
standard output mount.

## Troubleshooting

Generic deployment examples:

```console
docker exec neuroforge-backend-1 id
docker exec neuroforge-backend-1 printenv HOST_UID HOST_GID
stat -c '%n uid=%u gid=%g mode=%a' /deployment/data/derivatives/tool/run-id
docker inspect pipeline-container --format '{{json .Config.User}} {{json .Mounts}}'
```

The execution log should contain an entry similar to:

```text
[neuroforge] Output permissions prepared: path=/app/data/derivatives/tool/7 runtime_user=1000:1000 action=owner-updated mode=0755
```

If preparation cannot safely create, open, change, or verify the directory,
NeuroForge fails the run before `containers.run()` and records a clear executor
error.

## Limitations

- NeuroForge cannot infer a deterministic numeric identity from an arbitrary
  image username. Non-root images must use `run_as_host_user` or `run_as_user`.
- Existing child files are intentionally not recursively changed. A pipeline
  that must modify seeded files needs a separately reviewed group or copy policy.
- Remote/HPC executors have their own filesystem ownership model; this policy is
  currently applied by the local Docker executor.
