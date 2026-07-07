"""DockerExecutor — v1 concrete implementation of the Executor interface.

Builds Docker commands from pipeline manifests + user params, runs them via the
Docker SDK for Python (using the host Docker daemon via socket mount), and streams
logs back line-by-line through an async callback.

Path translation: the backend runs inside a Docker container, so dataset and output
paths are container-internal (e.g. /host-data/..., /app/data/...). The Docker daemon
on the host needs HOST paths for volume mounts. We resolve this by introspecting the
current container's own mounts at runtime to find source paths for each volume.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from app.execution.executor import Executor, ResourceWarning, RunContext

log = logging.getLogger(__name__)

# MRIQC-specific resource minimums (apply to any pipeline unless overridden in manifest)
_MIN_RAM_WARN_GB = 6.0
_MIN_DISK_WARN_GB = 5.0


def _is_running_in_docker() -> bool:
    return Path("/.dockerenv").exists()


def _get_container_mounts() -> dict[str, str]:
    """
    Return {container_path: host_source_path} for all mounts on the current container.
    Only meaningful when running inside Docker. Returns empty dict otherwise.
    """
    if not _is_running_in_docker():
        return {}
    try:
        import docker
        import socket

        client = docker.from_env()
        hostname = socket.gethostname()
        container = client.containers.get(hostname)
        mounts = {}
        for m in container.attrs.get("Mounts", []):
            dest = m.get("Destination", "").rstrip("/")
            src = m.get("Source", "")
            if dest and src:
                mounts[dest] = src
        return mounts
    except Exception as exc:
        log.warning("Could not introspect container mounts: %s", exc)
        return {}


_MOUNTS: dict[str, str] | None = None

# run_id → running container ID, so the watchdog can stop it by ID
_active_containers: dict[int, str] = {}


def _resolve_mounts() -> dict[str, str]:
    global _MOUNTS
    if _MOUNTS is None:
        _MOUNTS = _get_container_mounts()
    return _MOUNTS


def to_host_path(container_path: str) -> str:
    """
    Translate a container-internal path to the equivalent host path, so that
    the Docker daemon (running on the host) can use it in volume mounts.

    When not running inside Docker (local dev), the path is already a host path
    and is returned unchanged.
    """
    if not _is_running_in_docker():
        return container_path

    mounts = _resolve_mounts()
    # Find the longest matching mount prefix
    best_dest = ""
    best_src = ""
    for dest, src in mounts.items():
        if (container_path == dest or container_path.startswith(dest + "/")) and len(dest) > len(best_dest):
            best_dest = dest
            best_src = src

    if best_dest:
        relative = container_path[len(best_dest):]
        return best_src + relative

    log.warning("No mount found for container path %s — using as-is", container_path)
    return container_path


@dataclass
class _SdkParams:
    image: str
    command: list[str]
    volumes: dict[str, dict[str, str]]  # {host_path: {"bind": ..., "mode": ...}}
    user: str | None = None  # "uid:gid" when run_as_host_user: true in manifest


class DockerExecutor(Executor):
    """Runs pipeline containers via the Docker SDK for Python."""

    def _build_sdk_params(self, ctx: RunContext) -> _SdkParams:
        manifest = ctx.manifest
        params = ctx.params
        container = manifest["container"]

        dataset_host = to_host_path(ctx.dataset_path)
        output_host = to_host_path(ctx.output_dir)

        # dataset_positional: true (default) → BIDS-style pipelines that take
        # the dataset dir and output dir as positional CLI args (/data /out).
        # false → flag-only pipelines (e.g. FastSurfer) where the dataset is
        # addressed via mount:true params; /data is not mounted or passed.
        dataset_positional: bool = manifest.get("dataset_positional", True)

        volumes: dict[str, dict[str, str]] = {
            output_host: {"bind": "/out", "mode": "rw"},
        }
        if dataset_positional:
            volumes[dataset_host] = {"bind": "/data", "mode": "ro"}

        # work-dir: mount if provided, remap to /work inside the container
        work_dir_val = str(params.get("work-dir", "")).strip()
        if work_dir_val:
            work_dir_host = to_host_path(work_dir_val)
            volumes[work_dir_host] = {"bind": "/work", "mode": "rw"}

        # Generic file_path/directory_path params with mount: true.
        #
        # For each such param, the host path is bind-mounted read-only at
        # /inputs/{param-name}/{basename} and the CLI flag receives that
        # container-internal path instead of the raw host path. This lets
        # manifests declare file inputs (e.g. --fs-license-file) without
        # any per-pipeline special-casing in the executor.
        #
        # Container path scheme: /inputs/{param-name}/{original-basename}
        # e.g. /Users/me/freesurfer/license.txt
        #   → mounted at /inputs/fs-license-file/license.txt
        #   → --fs-license-file /inputs/fs-license-file/license.txt
        _mounted_paths: dict[str, str] = {}  # param name → container path
        for p in manifest["parameters"]:
            if not p.get("mount"):
                continue
            name = p["name"]
            raw = str(params.get(name) or p.get("default") or "").strip()
            if not raw:
                continue
            # Relative paths cannot be bind-mounted by Docker (it interprets them
            # as named volumes). Resolve against the dataset directory — the most
            # natural anchor when a user types a path like "sub-01/anat/T1w.nii.gz"
            # while browsing their dataset.
            if not Path(raw).is_absolute():
                raw = str(Path(ctx.dataset_path) / raw)
            host_path = to_host_path(raw)
            basename = Path(raw).name
            container_path = f"/inputs/{name}/{basename}"
            volumes[host_path] = {"bind": container_path, "mode": "ro"}
            _mounted_paths[name] = container_path
            log.debug(
                "Mounting %s → %s for param %r", host_path, container_path, name
            )

        # Build the tool command (everything after the image name).
        # BIDS-layout pipelines start with the fixed positional pair /data /out;
        # flag-only pipelines (dataset_positional: false) start with an empty list.
        cmd: list[str] = ["/data", "/out"] if dataset_positional else []

        # Positional parameters (sorted by positional_index)
        positionals = sorted(
            [p for p in manifest["parameters"] if p.get("positional_index") is not None],
            key=lambda p: p["positional_index"],
        )
        for p in positionals:
            val = params.get(p["name"])
            if not val and val != 0:
                val = p.get("default")
            if val is not None and val != "":
                cmd.append(str(val))

        # Flag parameters
        for p in manifest["parameters"]:
            if p.get("positional_index") is not None:
                continue  # already handled above

            name = p["name"]
            ptype = p["type"]

            # work-dir is handled via volume mount above; remap CLI flag to /work
            if name == "work-dir":
                if work_dir_val:
                    cmd += ["--work-dir", "/work"]
                continue

            # mount: true params use the container-internal path, already computed above
            if name in _mounted_paths:
                cmd += [f"--{name}", _mounted_paths[name]]
                continue

            raw_val = params.get(name)

            if ptype == "boolean":
                # Emit --flag only if explicitly true; false = omit entirely
                effective = raw_val if raw_val is not None else p.get("default", False)
                if effective is True or effective == "true":
                    cmd.append(f"--{name}")

            elif ptype == "multiselect":
                val = raw_val if raw_val is not None else p.get("default", [])
                if val:
                    cmd += [f"--{name}"] + list(val)

            elif p.get("multiple"):
                # String param that accepts space-separated repeated values
                val = str(raw_val or "").strip()
                if not val:
                    val = str(p.get("default", "")).strip()
                if val:
                    cmd += [f"--{name}"] + val.split()

            else:
                val = raw_val
                if val is None or val == "":
                    val = p.get("default")
                if val is not None and val != "":
                    cmd += [f"--{name}", str(val)]

        # run_as_host_user: true → pass the host UID:GID to the spawned container.
        # Required by images that refuse to run as an arbitrary non-root user
        # (e.g. FastSurfer's run_fastsurfer.sh checks the caller's identity).
        # Defaults to false so MRIQC/fMRIPrep are unaffected.
        #
        # os.getuid()/getgid() cannot be used here: the backend container runs as
        # root (no USER in Dockerfile), so those always return 0. Instead we read
        # HOST_UID/HOST_GID, which docker-compose.yml injects from the calling
        # shell at compose-up time (${HOST_UID} / ${HOST_GID}).
        user: str | None = None
        if manifest.get("run_as_host_user"):
            import os
            host_uid = os.environ.get("HOST_UID", "").strip()
            host_gid = os.environ.get("HOST_GID", "").strip()
            if host_uid and host_gid and host_uid != "0":
                user = f"{host_uid}:{host_gid}"
            else:
                log.warning(
                    "run_as_host_user=true but HOST_UID=%r HOST_GID=%r — "
                    "ensure HOST_UID and HOST_GID are set in the environment "
                    "before running 'docker compose up'. Skipping -u flag.",
                    host_uid, host_gid,
                )

        return _SdkParams(
            image=f"{container['image']}:{container['tag']}",
            command=cmd,
            volumes=volumes,
            user=user,
        )

    def build_command(self, ctx: RunContext) -> list[str]:
        """Full CLI representation — used for command_preview display."""
        sdk = self._build_sdk_params(ctx)
        cli = ["docker", "run", "--rm"]
        if sdk.user is not None:
            cli += ["-u", sdk.user]
        for host_path, bind in sdk.volumes.items():
            mode = bind.get("mode", "rw")
            cli += ["-v", f"{host_path}:{bind['bind']}:{mode}"]
        cli.append(sdk.image)
        cli.extend(sdk.command)
        return cli

    async def run(
        self,
        ctx: RunContext,
        log_callback: Callable[[str], None],
    ) -> tuple[int, str | None]:
        import docker

        sdk = self._build_sdk_params(ctx)
        client = docker.from_env()

        loop = asyncio.get_event_loop()
        exit_code = 1
        digest: str | None = None

        def _run_sync() -> None:
            nonlocal exit_code, digest

            log.info("Starting container %s for run %d", sdk.image, ctx.run_id)
            run_kwargs: dict = dict(
                command=sdk.command,
                volumes=sdk.volumes,
                detach=True,
                remove=False,  # we remove after capturing exit code
                labels={"neuroforge_run_id": str(ctx.run_id)},
                # Force x86_64 emulation on Apple Silicon so that amd64-only
                # images (fMRIPrep, FastSurfer cpu builds) don't fail with a
                # "no matching manifest for linux/arm64" 404 at pull time.
                platform="linux/amd64",
            )
            if sdk.user is not None:
                run_kwargs["user"] = sdk.user
            container = client.containers.run(sdk.image, **run_kwargs)
            _active_containers[ctx.run_id] = container.id

            # Capture image digest for provenance
            try:
                img = client.images.get(sdk.image)
                repo_digests = img.attrs.get("RepoDigests", [])
                if repo_digests:
                    digest = repo_digests[0]
            except Exception:
                pass

            # Stream logs line-by-line back to the async callback
            for chunk in container.logs(stream=True, follow=True):
                raw = chunk.decode("utf-8", errors="replace")
                for line in raw.splitlines():
                    stripped = line.rstrip()
                    if stripped:
                        loop.call_soon_threadsafe(log_callback, stripped)

            result = container.wait()
            nonlocal_exit_code = result.get("StatusCode", 1)

            try:
                container.remove()
            except Exception:
                pass

            nonlocal exit_code
            exit_code = nonlocal_exit_code

        max_hours: float | None = ctx.manifest.get("max_runtime_hours")

        async def _watchdog() -> None:
            assert max_hours is not None
            await asyncio.sleep(max_hours * 3600)
            cid = _active_containers.get(ctx.run_id)
            if cid:
                log.warning("Run %d exceeded max runtime of %.1fh — stopping container %s", ctx.run_id, max_hours, cid[:12])
                try:
                    client.containers.get(cid).stop(timeout=30)
                except Exception:
                    pass
            loop.call_soon_threadsafe(
                log_callback,
                f"[neuroforge] Run stopped automatically after {max_hours:.0f}h maximum runtime.",
            )

        watchdog: asyncio.Task | None = asyncio.ensure_future(_watchdog()) if max_hours else None
        try:
            await loop.run_in_executor(None, _run_sync)
        finally:
            if watchdog:
                watchdog.cancel()
            _active_containers.pop(ctx.run_id, None)

        return exit_code, digest

    def check_resources(self, ctx: RunContext) -> list[ResourceWarning]:
        warnings: list[ResourceWarning] = []
        try:
            import platform

            import psutil

            # Architecture mismatch: x86_64 image on ARM host (Apple Silicon)
            host_arch = platform.machine().lower()
            if host_arch in ("arm64", "aarch64"):
                try:
                    client_tmp = __import__("docker").from_env()
                    img_info = client_tmp.images.get(
                        f"{ctx.manifest['container']['image']}:{ctx.manifest['container']['tag']}"
                    )
                    img_arch = img_info.attrs.get("Architecture", "")
                    if img_arch == "amd64":
                        warnings.append(ResourceWarning(
                            level="warn",
                            message=(
                                f"This pipeline image ({ctx.manifest['container']['image']}:{ctx.manifest['container']['tag']}) "
                                "is x86_64 only and will run under Rosetta 2 emulation on your Apple Silicon Mac. "
                                "Expect 5-10× slower processing and higher memory usage than native. "
                                "Keep nprocs=1 and omp-nthreads=1 to avoid memory exhaustion. "
                                "A single T1w subject will take approximately 30-90 minutes."
                            ),
                        ))
                except Exception:
                    pass

            # RAM check
            available_gb = psutil.virtual_memory().available / (1024 ** 3)
            if available_gb < _MIN_RAM_WARN_GB:
                warnings.append(ResourceWarning(
                    level="warn",
                    message=(
                        f"Only {available_gb:.1f} GB RAM available. "
                        f"MRIQC recommends at least {_MIN_RAM_WARN_GB:.0f} GB free. "
                        "The run may be slow or fail on larger datasets."
                    ),
                ))

            # Disk check (check the output dir's filesystem)
            output_parent = Path(ctx.output_dir).parent
            output_parent.mkdir(parents=True, exist_ok=True)
            free_gb = psutil.disk_usage(str(output_parent)).free / (1024 ** 3)
            if free_gb < _MIN_DISK_WARN_GB:
                warnings.append(ResourceWarning(
                    level="warn",
                    message=(
                        f"Only {free_gb:.1f} GB disk space available. "
                        f"MRIQC outputs require at least {_MIN_DISK_WARN_GB:.0f} GB. "
                        "The run may fail partway through."
                    ),
                ))
        except ImportError:
            log.warning("psutil not installed; skipping resource pre-check")
        except Exception as exc:
            log.warning("Resource pre-check failed: %s", exc)

        return warnings


def translate_errors(
    log_text: str,
    known_errors: list[dict[str, str]],
) -> str | None:
    """
    Scan log_text against the manifest's known_errors patterns.
    Returns the first match's plain-language explanation, or None if no match.
    """
    for entry in known_errors:
        pattern = entry.get("pattern", "")
        if not pattern:
            continue
        try:
            if re.search(pattern, log_text, re.IGNORECASE | re.MULTILINE):
                explanation = entry.get("explanation", "")
                fix_hint = entry.get("fix_hint", "")
                if fix_hint:
                    return f"{explanation}\n\nSuggested fix: {fix_hint}"
                return explanation
        except re.error:
            log.warning("Invalid regex in known_errors: %r", pattern)
    return None
