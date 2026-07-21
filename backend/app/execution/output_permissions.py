"""Secure preparation of Docker bind-mounted pipeline output directories."""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path


class OutputPermissionError(RuntimeError):
    """Raised when a run output directory cannot be prepared safely."""


@dataclass(frozen=True)
class OutputPreparation:
    path: str
    runtime_uid: int | None
    runtime_gid: int | None
    action: str
    mode: int

    def log_line(self) -> str:
        identity = (
            "image-default"
            if self.runtime_uid is None
            else f"{self.runtime_uid}:{self.runtime_gid}"
        )
        return (
            "[neuroforge] Output permissions prepared: "
            f"path={self.path} runtime_user={identity} "
            f"action={self.action} mode={self.mode:04o}"
        )


def _parse_runtime_user(runtime_user: str | None) -> tuple[int, int] | None:
    if runtime_user is None:
        return None
    parts = runtime_user.split(":")
    if len(parts) != 2 or not all(part.isdecimal() for part in parts):
        raise OutputPermissionError(
            "Container runtime user must be a numeric UID:GID pair."
        )
    uid, gid = (int(part) for part in parts)
    return uid, gid


def _ensure_runtime_owner(path: Path, uid: int, gid: int) -> tuple[str, int]:
    """Change only *path* itself; never recurse into historical contents."""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise OutputPermissionError(
            f"Could not securely open run output directory {path}: {exc}"
        ) from exc

    try:
        before = os.fstat(fd)
        action = "already-owned"
        if (before.st_uid, before.st_gid) != (uid, gid):
            os.fchown(fd, uid, gid)
            action = "owner-updated"

        mode = stat.S_IMODE(before.st_mode)
        writable_mode = mode | stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR
        if writable_mode != mode:
            os.fchmod(fd, writable_mode)
            mode = writable_mode
            action = f"{action}+owner-rwx"

        after = os.fstat(fd)
        if (after.st_uid, after.st_gid) != (uid, gid):
            raise OutputPermissionError(
                f"Run output directory ownership verification failed for {path}: "
                f"expected {uid}:{gid}, got {after.st_uid}:{after.st_gid}."
            )
        final_mode = stat.S_IMODE(after.st_mode)
        if final_mode & stat.S_IRWXU != stat.S_IRWXU:
            raise OutputPermissionError(
                f"Run output directory is not owner-writable after preparation: {path}."
            )
        return action, final_mode
    except OSError as exc:
        raise OutputPermissionError(
            f"Could not prepare run output directory {path} for UID:GID {uid}:{gid}: {exc}"
        ) from exc
    finally:
        os.close(fd)


def prepare_output_directory(
    output_dir: str,
    *,
    allowed_root: Path,
    runtime_user: str | None,
) -> OutputPreparation:
    """Create and prepare one run directory without weakening unrelated paths."""
    raw = Path(output_dir)
    if not raw.is_absolute():
        raise OutputPermissionError("Run output directory must be an absolute path.")
    if ".." in raw.parts:
        raise OutputPermissionError("Run output directory traversal is not allowed.")

    try:
        root = allowed_root.resolve(strict=True)
    except OSError as exc:
        raise OutputPermissionError(
            f"Configured derivatives root is unavailable: {allowed_root}."
        ) from exc

    # Resolve existing parents before creating anything. This rejects a parent
    # symlink that would redirect a run outside the configured derivatives root.
    resolved = raw.resolve(strict=False)
    try:
        relative = resolved.relative_to(root)
    except ValueError as exc:
        raise OutputPermissionError(
            f"Run output directory escapes the configured derivatives root: {raw}."
        ) from exc
    if not relative.parts:
        raise OutputPermissionError("The derivatives root itself cannot be used as a run output.")

    cursor = root
    for part in relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise OutputPermissionError(
                f"Symlinks are not allowed in run output paths: {cursor}."
            )

    try:
        resolved.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise OutputPermissionError(
            f"Could not create run output directory {resolved}: {exc}"
        ) from exc
    if not resolved.is_dir() or resolved.is_symlink():
        raise OutputPermissionError(f"Run output path is not a real directory: {resolved}.")

    identity = _parse_runtime_user(runtime_user)
    current = resolved.stat()
    if identity is None:
        return OutputPreparation(
            path=str(resolved),
            runtime_uid=None,
            runtime_gid=None,
            action="unchanged-image-default",
            mode=stat.S_IMODE(current.st_mode),
        )

    uid, gid = identity
    action, mode = _ensure_runtime_owner(resolved, uid, gid)
    return OutputPreparation(
        path=str(resolved),
        runtime_uid=uid,
        runtime_gid=gid,
        action=action,
        mode=mode,
    )
