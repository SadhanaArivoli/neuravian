"""Secure translation between host, backend, and child dataset namespaces.

Dataset records use the backend namespace (``/host-data``). Docker bind mounts
must use the corresponding host namespace, while scientific containers receive
their own child paths (``/data`` or ``/inputs/...``). Keeping these conversions
explicit prevents one namespace from being probed from another.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

from app.core.config import settings


class DatasetPathError(ValueError):
    """Base class for unsafe or untranslatable dataset paths."""


class DatasetPathConfigurationError(DatasetPathError):
    """Raised when dataset namespace configuration is incomplete."""


class DatasetPathOutsideRootError(DatasetPathError):
    """Raised when a path is outside both configured dataset roots."""


@dataclass(frozen=True)
class ResolvedDatasetPath:
    """Equivalent forms of one path within the configured dataset tree."""

    relative: Path
    backend: Path
    host: Path


def _decode_path(value: str | Path) -> Path:
    text = str(value).strip()
    for _ in range(4):
        decoded = unquote(text)
        if decoded == text:
            break
        text = decoded
    if not text or "\x00" in text:
        raise DatasetPathError("Dataset path is empty or contains invalid data.")
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise DatasetPathError("Dataset path must be absolute.")
    return path


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


class DatasetPathResolver:
    """Translate paths without confusing host and backend namespaces."""

    def __init__(self, host_root: str | Path, backend_root: str | Path) -> None:
        self.host_root = _decode_path(host_root)
        self.backend_root = _decode_path(backend_root)
        for label, root in (
            ("host dataset root", self.host_root),
            ("backend dataset root", self.backend_root),
        ):
            if root == Path("/") or ".." in root.parts:
                raise DatasetPathConfigurationError(
                    f"Configured {label} must be a scoped absolute path."
                )

    def try_resolve(self, value: str | Path) -> ResolvedDatasetPath | None:
        """Resolve a dataset path, returning ``None`` for unrelated paths.

        Unsafe paths which lexically begin in a dataset namespace still raise;
        callers must never silently fall back for traversal attempts.
        """
        path = _decode_path(value)
        matching_root: Path | None = None
        for root in sorted(
            (self.backend_root, self.host_root),
            key=lambda item: len(item.parts),
            reverse=True,
        ):
            if _is_within(path, root):
                matching_root = root
                break
        if matching_root is None:
            return None
        if ".." in path.parts:
            raise DatasetPathError("Dataset path traversal is not allowed.")

        relative = path.relative_to(matching_root)
        if relative == Path("."):
            relative = Path()

        # Validate symlinks in whichever namespace is actually visible here.
        # In the backend container /srv/... is intentionally not visible, so a
        # host-form input is checked via its equivalent /host-data/... path.
        host_candidate = self.host_root / relative
        backend_candidate = self.backend_root / relative
        if matching_root == self.host_root and self.host_root.exists():
            visible_root, visible_candidate = self.host_root, host_candidate
        else:
            visible_root, visible_candidate = self.backend_root, backend_candidate
        if visible_root.exists():
            resolved_root = visible_root.resolve()
            resolved_candidate = visible_candidate.resolve(strict=False)
            if not _is_within(resolved_candidate, resolved_root):
                raise DatasetPathError(
                    "Dataset path resolves outside the configured root."
                )
            relative = resolved_candidate.relative_to(resolved_root)
            host_candidate = self.host_root / relative
            backend_candidate = self.backend_root / relative

        return ResolvedDatasetPath(
            relative=relative,
            backend=backend_candidate,
            host=host_candidate,
        )

    def resolve(self, value: str | Path) -> ResolvedDatasetPath:
        resolved = self.try_resolve(value)
        if resolved is None:
            raise DatasetPathOutsideRootError(
                "Dataset path is outside the configured dataset root."
            )
        return resolved


def dataset_path_resolver() -> DatasetPathResolver:
    if (
        not isinstance(settings.host_datasets_mount, str)
        or not settings.host_datasets_mount
    ):
        raise DatasetPathConfigurationError(
            "HOST_DATASETS_MOUNT is required for dataset host-path translation."
        )
    if (
        not isinstance(settings.backend_datasets_mount, str)
        or not settings.backend_datasets_mount
    ):
        raise DatasetPathConfigurationError(
            "BACKEND_DATASETS_MOUNT is required for dataset path translation."
        )
    return DatasetPathResolver(
        settings.host_datasets_mount,
        settings.backend_datasets_mount,
    )


def dataset_translation_configured() -> bool:
    """Return whether both namespace roots are concrete configured strings."""
    return bool(
        isinstance(settings.host_datasets_mount, str)
        and settings.host_datasets_mount
        and isinstance(settings.backend_datasets_mount, str)
        and settings.backend_datasets_mount
    )


def try_resolve_dataset_path(value: str | Path) -> ResolvedDatasetPath | None:
    return dataset_path_resolver().try_resolve(value)


def to_backend_dataset_path(value: str | Path) -> Path:
    return dataset_path_resolver().resolve(value).backend


def to_host_dataset_path(value: str | Path) -> Path:
    return dataset_path_resolver().resolve(value).host


def dataset_relative_path(value: str | Path) -> Path:
    return dataset_path_resolver().resolve(value).relative
