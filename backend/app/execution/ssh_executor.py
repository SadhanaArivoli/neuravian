"""SSHExecutor — runs pipeline containers on a remote host via SSH + Docker.

Workflow per run:
  1. SSH connect (paramiko)
  2. mkdir remote staging dirs
  3. SFTP upload: dataset dir → {remote_work_root}/runs/{run_id}/input/
     Also upload any manifest mount: true params
  4. Execute: docker run on remote, streaming stdout/stderr back
  5. SFTP download: {remote_work_root}/runs/{run_id}/output/ → local output_dir
  6. Return exit code

Path safety: all remote paths are constructed from validated components (run_id,
param basename). No user-supplied path is ever interpolated into a shell command
without shlex.quote — preventing command injection.

Private keys are never stored in the database; only the filesystem path is recorded.
The key file must be pre-placed by the administrator.
"""

from __future__ import annotations

import asyncio
import logging
import shlex
import stat
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from app.execution.bids_app_adapter import build_bids_app_plan
from app.execution.executor import Executor, ResourceWarning, RunContext
from app.schemas.remote_host import PreflightCheck, PreflightResult

if TYPE_CHECKING:
    import paramiko

log = logging.getLogger(__name__)

_CONNECT_TIMEOUT_S = 15
_TRANSFER_TIMEOUT_S = 300
_MIN_DISK_WARN_GB = 10.0


def _ssh_connect(cfg: dict[str, Any]) -> "paramiko.SSHClient":
    import paramiko

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())  # type: ignore[no-untyped-call]
    client.connect(
        hostname=cfg["hostname"],
        port=cfg.get("ssh_port", 22),
        username=cfg["username"],
        key_filename=cfg["key_path"],
        timeout=_CONNECT_TIMEOUT_S,
        look_for_keys=False,
        allow_agent=False,
    )
    return client


def _exec(
    client: "paramiko.SSHClient", cmd: str, timeout: float = 30
) -> tuple[int, str, str]:
    """Run a single command; return (exit_code, stdout, stderr)."""
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    return code, out.strip(), err.strip()


# ── SFTP helpers ─────────────────────────────────────────────────────────────


def _sftp_makedirs(sftp: "paramiko.SFTPClient", remote_path: str) -> None:
    """Recursively create remote directories (mkdir -p equivalent)."""
    parts = Path(remote_path).parts
    current = ""
    for part in parts:
        current = str(Path(current) / part) if current else part
        try:
            sftp.stat(current)
        except FileNotFoundError:
            try:
                sftp.mkdir(current)
            except OSError:
                pass  # race: another thread may have created it


def _sftp_put_dir(sftp: "paramiko.SFTPClient", local_dir: str, remote_dir: str) -> None:
    """Recursively upload a local directory tree to a remote path via SFTP."""
    _sftp_makedirs(sftp, remote_dir)
    for entry in sorted(Path(local_dir).iterdir()):
        remote_entry = f"{remote_dir}/{entry.name}"
        if entry.is_symlink():
            continue  # skip symlinks for safety
        if entry.is_dir():
            _sftp_put_dir(sftp, str(entry), remote_entry)
        else:
            sftp.put(str(entry), remote_entry)


def _sftp_get_dir(sftp: "paramiko.SFTPClient", remote_dir: str, local_dir: str) -> None:
    """Recursively download a remote directory tree to a local path via SFTP."""
    Path(local_dir).mkdir(parents=True, exist_ok=True)
    try:
        entries = sftp.listdir_attr(remote_dir)
    except FileNotFoundError:
        log.warning("Remote output dir not found: %s", remote_dir)
        return
    for attr in entries:
        name = attr.filename
        remote_entry = f"{remote_dir}/{name}"
        local_entry = str(Path(local_dir) / name)
        if stat.S_ISDIR(attr.st_mode or 0):
            _sftp_get_dir(sftp, remote_entry, local_entry)
        else:
            sftp.get(remote_entry, local_entry)


# ── Preflight ─────────────────────────────────────────────────────────────────


def run_preflight(cfg: dict[str, Any]) -> PreflightResult:
    """
    SSH into the remote host and run a series of diagnostic checks.
    Returns a structured PreflightResult. Never raises — errors go into result.errors.
    """
    checks: list[PreflightCheck] = []
    errors: list[str] = []
    warnings: list[str] = []

    try:
        client = _ssh_connect(cfg)
    except Exception as exc:
        errors.append(f"SSH connection failed: {exc}")
        return PreflightResult(
            connected=False, checks=checks, errors=errors, warnings=warnings
        )

    try:
        # 1. Architecture
        code, out, _ = _exec(client, "uname -m")
        arch = out if code == 0 else None
        checks.append(PreflightCheck(name="architecture", passed=code == 0, value=arch))

        # 2. Docker daemon
        code, out, err = _exec(
            client, "docker version --format '{{.Server.Version}}'", timeout=15
        )
        docker_ok = code == 0 and bool(out)
        checks.append(
            PreflightCheck(
                name="docker",
                passed=docker_ok,
                value=out if docker_ok else None,
                detail=err if not docker_ok else None,
            )
        )
        if not docker_ok:
            errors.append(f"Docker not available on remote: {err or 'no output'}")

        # 3. Remote work root writable
        root = shlex.quote(cfg["remote_work_root"])
        probe_cmd = f"mkdir -p {root} && touch {root}/.nf_probe && rm {root}/.nf_probe"
        code, _, err = _exec(client, probe_cmd)
        writable = code == 0
        checks.append(
            PreflightCheck(
                name="remote_work_root_writable",
                passed=writable,
                value=cfg["remote_work_root"] if writable else None,
                detail=err if not writable else None,
            )
        )
        if not writable:
            errors.append(f"Remote work root is not writable: {err}")

        # 4. Disk space
        code, out, _ = _exec(client, f"df -BG {root} 2>/dev/null | tail -1")
        disk_free_gb: float | None = None
        disk_passed = False
        if code == 0 and out:
            # df -BG output: Filesystem 1G-blocks Used Available Use% Mounted
            parts = out.split()
            if len(parts) >= 4:
                try:
                    disk_free_gb = float(parts[3].rstrip("G"))
                    disk_passed = True
                except ValueError:
                    pass
        checks.append(
            PreflightCheck(
                name="disk_space_gb",
                passed=disk_passed and (disk_free_gb or 0) >= _MIN_DISK_WARN_GB,
                value=f"{disk_free_gb:.1f} GB free"
                if disk_free_gb is not None
                else None,
            )
        )
        if disk_free_gb is not None and disk_free_gb < _MIN_DISK_WARN_GB:
            warnings.append(
                f"Only {disk_free_gb:.1f} GB free on remote at "
                f"{cfg['remote_work_root']}. Heavy pipelines need at least "
                f"{_MIN_DISK_WARN_GB:.0f} GB."
            )

    finally:
        client.close()

    return PreflightResult(
        connected=True, checks=checks, errors=errors, warnings=warnings
    )


# ── Command builder (mirrors DockerExecutor logic with remote paths) ───────────


def _build_remote_docker_cmd(
    ctx: RunContext,
    remote_input_dir: str,
    remote_output_dir: str,
    mounted_remote_paths: dict[str, str],
    docker_host: str | None,
) -> list[str]:
    """Build a 'docker run' CLI command list using remote-host paths."""
    manifest = ctx.manifest
    params = ctx.params
    container = manifest["container"]

    dataset_positional: bool = manifest.get("dataset_positional", True)
    tag = container["tag"]
    sep = "@" if tag.startswith("sha256:") else ":"
    image = f"{container['image']}{sep}{tag}"

    cli = ["docker"]
    if docker_host:
        cli += ["-H", docker_host]
    cli += ["run", "--rm", "--platform", "linux/amd64"]

    bids_app = (manifest.get("contract") or {}).get("bids_app")
    if bids_app:
        work_name = bids_app.get("work_directory_parameter")
        work_value = str(params.get(work_name, "")) if work_name else ""
        remote_work = remote_output_dir.rstrip("/") + "_work"

        def remote_path(value: str) -> str:
            if work_value and value == work_value:
                return remote_work
            for parameter in manifest.get("parameters", []):
                if str(params.get(parameter["name"], "")) == value:
                    return mounted_remote_paths.get(parameter["name"], value)
            return value

        plan = build_bids_app_plan(
            manifest,
            params,
            dataset_host=remote_input_dir,
            output_host=remote_output_dir,
            host_path=remote_path,
        )
        for source, bind in plan.volumes.items():
            cli += ["-v", f"{source}:{bind['bind']}:{bind['mode']}"]
        for name, value in sorted(plan.environment.items()):
            cli += ["-e", f"{name}={value}"]
        cli.append(image)
        cli.extend(plan.command)
        return cli

    # Volumes
    if dataset_positional:
        cli += ["-v", f"{remote_input_dir}:/data:ro"]
    cli += ["-v", f"{remote_output_dir}:/out:rw"]

    work_dir_val = str(params.get("work-dir", "")).strip()
    if work_dir_val:
        # work-dir on remote: sibling of output dir
        remote_work = remote_output_dir.rstrip("/") + "_work"
        cli += ["-v", f"{remote_work}:/work:rw"]

    for param_name, remote_path in mounted_remote_paths.items():
        container_path = f"/inputs/{param_name}/{Path(remote_path).name}"
        cli += ["-v", f"{remote_path}:{container_path}:ro"]

    cli.append(image)

    # Command arguments — same logic as DockerExecutor._build_sdk_params
    cmd: list[str] = ["/data", "/out"] if dataset_positional else []

    positionals = sorted(
        [
            p
            for p in manifest["parameters"]
            if not p.get("internal") and p.get("positional_index") is not None
        ],
        key=lambda p: p["positional_index"],
    )
    for p in positionals:
        val = params.get(p["name"])
        if not val and val != 0:
            val = p.get("default")
        if val is not None and val != "":
            cmd.append(str(val))

    for p in manifest["parameters"]:
        if (
            p.get("internal")
            or p.get("positional_index") is not None
            or p.get("positional_suffix")
        ):
            continue
        name = p["name"]
        ptype = p["type"]
        flag = p.get("cli_flag") or f"--{name}"

        if name == "work-dir":
            if work_dir_val:
                cmd += ["--work-dir", "/work"]
            continue

        if name in mounted_remote_paths:
            container_path = f"/inputs/{name}/{Path(mounted_remote_paths[name]).name}"
            cmd += [flag, container_path]
            continue

        raw_val = params.get(name)

        if ptype == "boolean":
            effective = raw_val if raw_val is not None else p.get("default", False)
            if effective is True or effective == "true":
                cmd.append(flag)
        elif ptype == "multiselect":
            val = raw_val if raw_val is not None else p.get("default", [])
            if val:
                cmd += [flag] + list(val)
        elif p.get("multiple"):
            val = str(raw_val or "").strip() or str(p.get("default", "")).strip()
            if val:
                cmd += [flag] + val.split()
        else:
            val = raw_val if raw_val is not None and raw_val != "" else p.get("default")
            if val is not None and val != "":
                cmd += [flag, str(val)]

    for p in manifest["parameters"]:
        if p.get("internal") or not p.get("positional_suffix"):
            continue
        name = p["name"]
        if name in mounted_remote_paths:
            container_path = f"/inputs/{name}/{Path(mounted_remote_paths[name]).name}"
            cmd.append(container_path)
        else:
            val = str(params.get(name) or p.get("default") or "").strip()
            if val:
                cmd.append(val)

    cli.extend(cmd)
    return cli


# ── SSHExecutor ───────────────────────────────────────────────────────────────


class SSHExecutor(Executor):
    """
    Executes a Docker-based pipeline on a remote host over SSH.

    host_cfg dict keys:
      hostname, ssh_port, username, key_path, remote_work_root, docker_host (optional)
    """

    def __init__(self, host_cfg: dict[str, Any]) -> None:
        self._cfg = host_cfg

    def _remote_dirs(self, ctx: RunContext) -> tuple[str, str]:
        root = self._cfg["remote_work_root"].rstrip("/")
        rid = ctx.run_id
        return (
            f"{root}/runs/{rid}/input",
            f"{root}/runs/{rid}/output",
        )

    def build_command(self, ctx: RunContext) -> list[str]:
        remote_in, remote_out = self._remote_dirs(ctx)
        return _build_remote_docker_cmd(
            ctx, remote_in, remote_out, {}, self._cfg.get("docker_host")
        )

    async def run(
        self,
        ctx: RunContext,
        log_callback: Callable[[str], None],
    ) -> tuple[int, str | None]:
        loop = asyncio.get_event_loop()

        def _info(msg: str) -> None:
            loop.call_soon_threadsafe(log_callback, f"[neuravian-ssh] {msg}")

        remote_in, remote_out = self._remote_dirs(ctx)

        def _run_sync() -> int:
            client = _ssh_connect(self._cfg)
            try:
                # 1. Create remote dirs
                _info(
                    "Creating remote staging dirs under "
                    f"{self._cfg['remote_work_root']}/runs/{ctx.run_id}/"
                )
                code, _, err = _exec(
                    client,
                    f"mkdir -p {shlex.quote(remote_in)} {shlex.quote(remote_out)}",
                )
                if code != 0:
                    raise RuntimeError(f"Failed to create remote directories: {err}")

                sftp = client.open_sftp()
                try:
                    # 2. Upload dataset
                    _info(f"Uploading dataset to remote: {remote_in}")
                    _sftp_put_dir(sftp, ctx.dataset_path, remote_in)

                    # 3. Upload mount:true params
                    mounted_remote: dict[str, str] = {}
                    for p in ctx.manifest["parameters"]:
                        if p.get("internal") or not p.get("mount"):
                            continue
                        name = p["name"]
                        raw = str(
                            ctx.params.get(name) or p.get("default") or ""
                        ).strip()
                        if not raw:
                            continue
                        if not Path(raw).is_absolute():
                            raw = str(Path(ctx.dataset_path) / raw)
                        # Safety: ensure the path exists and is a file
                        local_p = Path(raw)
                        if not local_p.exists():
                            _info(
                                f"Skipping mount param {name!r}: local path not "
                                f"found: {raw}"
                            )
                            continue
                        root = self._cfg["remote_work_root"].rstrip("/")
                        remote_param_dir = (
                            f"{root}/runs/{ctx.run_id}/inputs/{name}"
                        )
                        remote_param_path = f"{remote_param_dir}/{local_p.name}"
                        _sftp_makedirs(sftp, remote_param_dir)
                        sftp.put(str(local_p), remote_param_path)
                        mounted_remote[name] = remote_param_path
                        _info(f"Uploaded param {name!r} → {remote_param_path}")
                finally:
                    sftp.close()

                # 4. Build and run docker command on remote
                docker_cmd = _build_remote_docker_cmd(
                    ctx,
                    remote_in,
                    remote_out,
                    mounted_remote,
                    self._cfg.get("docker_host"),
                )
                shell_cmd = " ".join(shlex.quote(s) for s in docker_cmd)
                _info(f"Remote command: {shell_cmd}")

                max_hours: float | None = ctx.manifest.get("max_runtime_hours")
                timeout_s = (max_hours * 3600) if max_hours else None

                _, stdout_ch, stderr_ch = client.exec_command(
                    shell_cmd, timeout=timeout_s
                )
                stdout_ch.channel.set_combine_stderr(True)

                for raw in stdout_ch:
                    for line in raw.rstrip("\n").splitlines():
                        stripped = line.rstrip()
                        if stripped:
                            loop.call_soon_threadsafe(log_callback, stripped)

                exit_code = stdout_ch.channel.recv_exit_status()
                _info(f"Remote docker exited with code {exit_code}")

                if exit_code != 0:
                    return exit_code

                # 5. Download output
                _info(f"Downloading output from remote: {remote_out}")
                sftp2 = client.open_sftp()
                try:
                    _sftp_get_dir(sftp2, remote_out, ctx.output_dir)
                finally:
                    sftp2.close()
                _info("Output transfer complete.")

                return 0

            finally:
                client.close()

        try:
            exit_code = await loop.run_in_executor(None, _run_sync)
        except Exception as exc:
            log.exception("SSHExecutor.run failed for run %d: %s", ctx.run_id, exc)
            loop.call_soon_threadsafe(log_callback, f"[neuravian-ssh] Error: {exc}")
            exit_code = 1

        # digest is not available for remote runs
        return exit_code, None

    def check_resources(self, ctx: RunContext) -> list[ResourceWarning]:
        result = run_preflight(self._cfg)
        warnings: list[ResourceWarning] = []
        for err in result.errors:
            warnings.append(ResourceWarning(level="error", message=f"[Remote] {err}"))
        for warn in result.warnings:
            warnings.append(ResourceWarning(level="warn", message=f"[Remote] {warn}"))
        return warnings
