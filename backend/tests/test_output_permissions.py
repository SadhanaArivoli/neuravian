from __future__ import annotations

import asyncio
import os
import stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.execution.docker_executor import DockerExecutor
from app.execution.executor import RunContext
from app.execution.output_permissions import (
    OutputPermissionError,
    _ensure_runtime_owner,
    prepare_output_directory,
)
from app.services.pipeline import ManifestError, _load_manifest, _load_schema, get_registry


def _root(tmp_path: Path) -> Path:
    root = tmp_path / "data" / "derivatives"
    root.mkdir(parents=True)
    return root


def _stat(uid: int, gid: int, mode: int = 0o755) -> SimpleNamespace:
    return SimpleNamespace(st_uid=uid, st_gid=gid, st_mode=stat.S_IFDIR | mode)


def test_root_running_container_keeps_existing_output_ownership(tmp_path: Path) -> None:
    root = _root(tmp_path)
    output = root / "bids-validator" / "1"
    output.mkdir(parents=True)
    before = output.stat()

    result = prepare_output_directory(
        str(output), allowed_root=root, runtime_user=None
    )

    after = output.stat()
    assert result.action == "unchanged-image-default"
    assert (after.st_uid, after.st_gid) == (before.st_uid, before.st_gid)


def test_host_user_matching_writable_directory_is_preserved(tmp_path: Path) -> None:
    root = _root(tmp_path)
    output = root / "fastsurfer" / "1"
    output.mkdir(parents=True)

    result = prepare_output_directory(
        str(output),
        allowed_root=root,
        runtime_user=f"{os.getuid()}:{os.getgid()}",
    )

    assert result.action == "already-owned"
    assert result.mode & stat.S_IRWXU == stat.S_IRWXU


def test_initially_root_owned_directory_is_changed_to_host_user() -> None:
    with (
        patch("app.execution.output_permissions.os.open", return_value=7),
        patch(
            "app.execution.output_permissions.os.fstat",
            side_effect=[_stat(0, 0), _stat(1000, 1000)],
        ),
        patch("app.execution.output_permissions.os.fchown") as chown,
        patch("app.execution.output_permissions.os.fchmod") as chmod,
        patch("app.execution.output_permissions.os.close"),
    ):
        action, mode = _ensure_runtime_owner(Path("/safe/run"), 1000, 1000)

    chown.assert_called_once_with(7, 1000, 1000)
    chmod.assert_not_called()
    assert action == "owner-updated"
    assert mode == 0o755


def test_explicit_non_root_uid_gid_is_used_by_executor(tmp_path: Path) -> None:
    manifest = {
        "id": "explicit-user",
        "display_name": "Explicit user",
        "description": "test",
        "container": {"image": "example/tool", "tag": "1.0", "engine": "docker"},
        "inputs": ["bids_dataset"],
        "outputs": ["test"],
        "parameters": [],
        "run_as_user": {"uid": 1234, "gid": 2345},
    }
    ctx = RunContext(1, manifest, {}, str(tmp_path), str(tmp_path / "out"))
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = DockerExecutor()._build_sdk_params(ctx)
    assert sdk.user == "1234:2345"


def test_absent_output_directory_is_created(tmp_path: Path) -> None:
    root = _root(tmp_path)
    output = root / "fastsurfer" / "new"
    result = prepare_output_directory(
        str(output),
        allowed_root=root,
        runtime_user=f"{os.getuid()}:{os.getgid()}",
    )
    assert output.is_dir()
    assert result.path == str(output)


def test_existing_empty_output_directory_is_supported(tmp_path: Path) -> None:
    root = _root(tmp_path)
    output = root / "fastsurfer" / "empty"
    output.mkdir(parents=True)
    result = prepare_output_directory(
        str(output),
        allowed_root=root,
        runtime_user=f"{os.getuid()}:{os.getgid()}",
    )
    assert result.runtime_uid == os.getuid()
    assert list(output.iterdir()) == []


def test_existing_non_empty_directory_is_not_recursively_changed(tmp_path: Path) -> None:
    root = _root(tmp_path)
    output = root / "fastsurfer" / "seeded"
    child = output / "historical.txt"
    output.mkdir(parents=True)
    child.write_text("preserve me")
    child_before = child.stat()

    prepare_output_directory(
        str(output),
        allowed_root=root,
        runtime_user=f"{os.getuid()}:{os.getgid()}",
    )

    child_after = child.stat()
    assert child.read_text() == "preserve me"
    assert (child_after.st_uid, child_after.st_gid, child_after.st_mode) == (
        child_before.st_uid,
        child_before.st_gid,
        child_before.st_mode,
    )


def test_permission_preparation_failure_is_clear_and_blocks_docker(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    output = data_dir / "derivatives" / "fastsurfer" / "7"
    output.mkdir(parents=True)
    manifest = {
        "id": "explicit-user",
        "display_name": "Explicit user",
        "description": "test",
        "container": {"image": "example/tool", "tag": "1.0", "engine": "docker"},
        "inputs": ["bids_dataset"],
        "outputs": ["test"],
        "parameters": [],
        "run_as_user": {"uid": 1234, "gid": 2345},
    }
    ctx = RunContext(7, manifest, {}, str(tmp_path), str(output))
    client = MagicMock()
    with (
        patch("app.execution.docker_executor.settings.data_dir", str(data_dir)),
        patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p),
        patch("app.execution.docker_executor.prepare_output_directory", side_effect=OutputPermissionError("ownership denied")),
        patch("docker.from_env", return_value=client),
        pytest.raises(OutputPermissionError, match="ownership denied"),
    ):
        asyncio.run(DockerExecutor().run(ctx, lambda _line: None))
    client.containers.run.assert_not_called()


def test_output_path_traversal_is_rejected(tmp_path: Path) -> None:
    root = _root(tmp_path)
    with pytest.raises(OutputPermissionError, match="traversal"):
        prepare_output_directory(
            str(root / "fastsurfer" / ".." / "escape"),
            allowed_root=root,
            runtime_user=f"{os.getuid()}:{os.getgid()}",
        )


def test_output_symlink_escape_is_rejected(tmp_path: Path) -> None:
    root = _root(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    link = root / "fastsurfer"
    link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(OutputPermissionError, match="escapes|Symlinks"):
        prepare_output_directory(
            str(link / "7"),
            allowed_root=root,
            runtime_user=f"{os.getuid()}:{os.getgid()}",
        )


def test_existing_artifacts_remain_readable(tmp_path: Path) -> None:
    root = _root(tmp_path)
    output = root / "fastsurfer" / "seeded"
    output.mkdir(parents=True)
    artifact = output / "artifact.nii.gz"
    artifact.write_bytes(b"nifti fixture")
    prepare_output_directory(
        str(output),
        allowed_root=root,
        runtime_user=f"{os.getuid()}:{os.getgid()}",
    )
    assert artifact.read_bytes() == b"nifti fixture"


@pytest.mark.parametrize("pipeline_id", ["bids-validator", "pydeface", "fmriprep"])
def test_existing_root_running_pipelines_remain_unmapped(
    pipeline_id: str, tmp_path: Path
) -> None:
    manifest = get_registry()[pipeline_id]
    ctx = RunContext(1, manifest, {}, str(tmp_path), str(tmp_path / "out"))
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = DockerExecutor()._build_sdk_params(ctx)
    assert sdk.user is None


def test_fastsurfer_output_is_writable_before_container_launch(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    output = data_dir / "derivatives" / "fastsurfer" / "7"
    output.mkdir(parents=True)
    manifest = {
        "id": "fastsurfer-like",
        "display_name": "FastSurfer-like",
        "description": "test",
        "container": {"image": "example/tool", "tag": "1.0", "engine": "docker"},
        "inputs": ["nifti"],
        "outputs": ["fastsurfer"],
        "parameters": [],
        "run_as_user": {"uid": os.getuid(), "gid": os.getgid()},
        "dataset_positional": False,
    }
    ctx = RunContext(7, manifest, {}, str(tmp_path), str(output))
    container = MagicMock(id="container-id")
    container.logs.return_value = iter([])
    container.wait.return_value = {"StatusCode": 0}
    client = MagicMock()

    def assert_writable_before_launch(*_args, **_kwargs):
        assert os.access(output, os.W_OK)
        return container

    client.containers.run.side_effect = assert_writable_before_launch
    client.images.get.side_effect = RuntimeError("digest not needed")
    lines: list[str] = []
    with (
        patch("app.execution.docker_executor.settings.data_dir", str(data_dir)),
        patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p),
        patch("docker.from_env", return_value=client),
    ):
        exit_code, _ = asyncio.run(DockerExecutor().run(ctx, lines.append))
    assert exit_code == 0
    assert any("Output permissions prepared" in line for line in lines)


def test_runtime_user_schema_and_mutual_exclusion(tmp_path: Path) -> None:
    manifest_path = tmp_path / "explicit.yaml"
    manifest_path.write_text(
        """
id: explicit-user
display_name: Explicit user
description: test
container: {image: example/tool, tag: '1.0', engine: docker}
inputs: [nifti]
outputs: [result]
parameters: []
run_as_user: {uid: 1234, gid: 2345}
"""
    )
    loaded = _load_manifest(manifest_path, _load_schema())
    assert loaded["run_as_user"] == {"uid": 1234, "gid": 2345}

    manifest_path.write_text(manifest_path.read_text() + "run_as_host_user: true\n")
    with pytest.raises(ManifestError, match="mutually exclusive"):
        _load_manifest(manifest_path, _load_schema())
