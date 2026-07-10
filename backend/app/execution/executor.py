"""Abstract Executor interface and RunContext.

DockerExecutor is the only v1 implementation. The interface is designed so
SlurmExecutor / CloudExecutor can be added later without touching service-layer
code — they just need to implement build_command() and run().
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class RunContext:
    run_id: int
    manifest: dict[str, Any]
    params: dict[str, Any]
    dataset_path: str   # container-internal path (e.g. /host-data/bids-examples/ds001)
    output_dir: str     # container-internal path (e.g. /app/data/derivatives/mriqc/1)
    # When set, SSHExecutor runs the job on this remote host instead of locally.
    # Keys: hostname, ssh_port, username, key_path, remote_work_root, docker_host (optional)
    remote_host_cfg: dict[str, Any] | None = field(default=None)


@dataclass
class ResourceWarning:
    level: str   # "warn" | "error"
    message: str


class Executor(ABC):
    """Interface all execution backends must implement."""

    @abstractmethod
    def build_command(self, ctx: RunContext) -> list[str]:
        """Return the full CLI command as a list of strings (for display/preview)."""
        ...

    @abstractmethod
    async def run(
        self,
        ctx: RunContext,
        log_callback: Callable[[str], None],
    ) -> tuple[int, str | None]:
        """
        Execute the job described by ctx.

        log_callback is called (from a thread, via call_soon_threadsafe) for each
        log line as it arrives.

        Returns (exit_code, container_digest_or_None).
        """
        ...

    def check_resources(self, ctx: RunContext) -> list[ResourceWarning]:
        """
        Check host resources before launching. Return list of warnings/errors.
        Empty list means all checks passed. Default implementation is a no-op;
        backends that can perform resource checks should override this.
        """
        return []
