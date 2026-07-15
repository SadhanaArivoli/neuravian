from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.dataset_paths import (
    DatasetPathConfigurationError,
    DatasetPathError,
    DatasetPathOutsideRootError,
    DatasetPathResolver,
    dataset_path_resolver,
)


def test_host_and_backend_forms_resolve_to_same_relative_path(tmp_path):
    host_root = tmp_path / "datasets"
    dataset = host_root / "x86-minimal-bids"
    dataset.mkdir(parents=True)
    resolver = DatasetPathResolver(host_root, "/host-data")

    from_host = resolver.resolve(dataset)
    from_backend = resolver.resolve("/host-data/x86-minimal-bids")

    assert from_host == from_backend
    assert from_backend.backend == Path("/host-data/x86-minimal-bids")
    assert from_backend.host == dataset


def test_path_normalization_preserves_spaces_and_unicode(tmp_path):
    host_root = tmp_path / "datasets"
    dataset = host_root / "Study One" / "sub-α"
    dataset.mkdir(parents=True)
    resolver = DatasetPathResolver(host_root, "/host-data")

    result = resolver.resolve("/host-data//Study One/./sub-α")

    assert result.relative == Path("Study One/sub-α")
    assert result.host == dataset


@pytest.mark.parametrize(
    "unsafe",
    [
        "/host-data/../etc/passwd",
        "/host-data/%2e%2e/etc/passwd",
        "/host-data/%252e%252e/etc/passwd",
    ],
)
def test_traversal_and_encoded_traversal_are_rejected(tmp_path, unsafe):
    host_root = tmp_path / "datasets"
    host_root.mkdir()
    resolver = DatasetPathResolver(host_root, "/host-data")

    with pytest.raises(DatasetPathError, match="traversal"):
        resolver.resolve(unsafe)


def test_symlink_escape_is_rejected(tmp_path):
    host_root = tmp_path / "datasets"
    outside = tmp_path / "private"
    host_root.mkdir()
    outside.mkdir()
    (host_root / "escape").symlink_to(outside, target_is_directory=True)
    resolver = DatasetPathResolver(host_root, "/host-data")

    with pytest.raises(DatasetPathError, match="outside"):
        resolver.resolve(host_root / "escape" / "study")


def test_outside_root_is_rejected(tmp_path):
    host_root = tmp_path / "datasets"
    host_root.mkdir()
    resolver = DatasetPathResolver(host_root, "/host-data")

    with pytest.raises(DatasetPathOutsideRootError):
        resolver.resolve(tmp_path / "other-study")


def test_try_resolve_returns_none_only_for_unrelated_paths(tmp_path):
    host_root = tmp_path / "datasets"
    host_root.mkdir()
    resolver = DatasetPathResolver(host_root, "/host-data")

    assert resolver.try_resolve("/opt/freesurfer/license.txt") is None
    with pytest.raises(DatasetPathError):
        resolver.try_resolve("/host-data/%2e%2e/license.txt")


def test_incomplete_configuration_has_clear_error():
    with patch("app.services.dataset_paths.settings") as mock_settings:
        mock_settings.host_datasets_mount = None
        mock_settings.backend_datasets_mount = "/host-data"
        with pytest.raises(
            DatasetPathConfigurationError, match="HOST_DATASETS_MOUNT"
        ):
            dataset_path_resolver()


def test_root_configuration_is_rejected():
    with pytest.raises(DatasetPathConfigurationError, match="scoped"):
        DatasetPathResolver("/", "/host-data")
