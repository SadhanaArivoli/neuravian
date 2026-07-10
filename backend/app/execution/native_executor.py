"""NativeExecutor — runs pipeline tools as subprocesses inside the backend container.

Used for tools distributed via pip (e.g. brainchop) that install as native
aarch64 Linux binaries inside the backend image, avoiding the Rosetta 2 /
qemu-x86_64 emulation that stalls Docker-based x86_64 neuroimaging tools.

Key differences from DockerExecutor:
- No Docker daemon interaction — subprocess in the current process namespace.
- Paths in RunContext are backend-container-internal (e.g. /app/data/...) and
  are used directly — no host↔container translation needed.
- `shutil.which` is used to confirm the tool binary is installed before launch.
- The manifest uses `execution.type: native` and `execution.command` instead of
  `container.image` / `container.tag`.
"""

from __future__ import annotations

import asyncio
import logging
import shlex
import shutil
from pathlib import Path
from typing import Any, Callable

from app.execution.docker_executor import from_host_path
from app.execution.executor import Executor, ResourceWarning, RunContext

log = logging.getLogger(__name__)

# run_id → active Popen, so the cancel endpoint can terminate it
_active_native_procs: dict[int, "subprocess.Popen[str]"] = {}


class NativeExecutor(Executor):
    """Runs pipelines as native subprocesses inside the backend container."""

    def _build_cmd(self, ctx: RunContext) -> list[str]:
        """Build the full subprocess command from the manifest and params."""
        exe = ctx.manifest["execution"]["command"]
        manifest_params: list[dict[str, Any]] = ctx.manifest.get("parameters", [])
        params = ctx.params

        cmd: list[str] = [exe]
        positional_suffix_args: list[str] = []

        for p in manifest_params:
            name = p["name"]
            val = params.get(name)
            if val is None:
                val = p.get("default")
            if val is None:
                continue

            # Resolve {output_dir} placeholder in default values
            if isinstance(val, str) and "{output_dir}" in val:
                val = val.replace("{output_dir}", ctx.output_dir)

            # Translate host paths to backend-container-internal paths
            ptype = p.get("type", "string")
            if ptype in ("file_path", "directory_path") and isinstance(val, str):
                val = from_host_path(val)

            if p.get("positional_suffix"):
                positional_suffix_args.append(str(val))
                continue

            if p.get("positional_index") is not None:
                # Insert at fixed position; handled after loop
                continue

            flag = p.get("cli_flag") or f"--{name}"

            if ptype == "boolean":
                if val is True or str(val).lower() in ("true", "1", "yes"):
                    cmd.append(flag)
            else:
                cmd += [flag, str(val)]

        # Fixed-position positional args (positional_index)
        positional_by_index: list[tuple[int, str]] = []
        for p in manifest_params:
            idx = p.get("positional_index")
            if idx is None:
                continue
            name = p["name"]
            val = params.get(name) or p.get("default")
            if val is not None:
                positional_by_index.append((idx, str(val)))
        for _, v in sorted(positional_by_index):
            cmd.append(v)

        cmd.extend(positional_suffix_args)
        return cmd

    def build_command(self, ctx: RunContext) -> list[str]:
        return self._build_cmd(ctx)

    async def run(
        self,
        ctx: RunContext,
        log_callback: Callable[[str], None],
    ) -> tuple[int, str | None]:
        cmd = self._build_cmd(ctx)
        exe = cmd[0]

        # Confirm binary is available
        if not shutil.which(exe):
            log_callback(
                f"ERROR: '{exe}' not found in PATH. "
                f"This pipeline requires '{exe}' to be installed in the backend image."
            )
            return 1, None

        manifest_out = Path(ctx.output_dir)
        manifest_out.mkdir(parents=True, exist_ok=True)

        log_callback(f"$ {shlex.join(cmd)}")
        log.info("Native run %d: %s", ctx.run_id, shlex.join(cmd))

        max_hours: float = ctx.manifest.get("max_runtime_hours", 2.0)
        timeout_s = max_hours * 3600

        loop = asyncio.get_running_loop()

        def _run_sync() -> int:
            import subprocess
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            _active_native_procs[ctx.run_id] = proc
            assert proc.stdout is not None
            try:
                for line in proc.stdout:
                    line = line.rstrip("\n")
                    loop.call_soon_threadsafe(log_callback, line)
                proc.wait()
            finally:
                _active_native_procs.pop(ctx.run_id, None)
            return proc.returncode

        try:
            exit_code: int = await asyncio.wait_for(
                loop.run_in_executor(None, _run_sync),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            log_callback(
                f"ERROR: Native subprocess exceeded max runtime of {max_hours:.1f}h — killed."
            )
            return 124, None

        return exit_code, None

    def check_resources(self, ctx: RunContext) -> list[ResourceWarning]:
        exe = ctx.manifest["execution"]["command"]
        if not shutil.which(exe):
            return [ResourceWarning(
                level="error",
                message=(
                    f"'{exe}' is not installed in the backend container. "
                    "This is a build-time installation issue — rebuild the backend image."
                ),
            )]
        return []
