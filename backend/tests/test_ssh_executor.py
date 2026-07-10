"""Unit tests for ssh_executor — pure helpers only (no SSH connections)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.execution.executor import RunContext
from app.execution.ssh_executor import (
    _build_remote_docker_cmd,
    _sftp_makedirs,
    run_preflight,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

MINIMAL_MANIFEST = {
    "id": "bids-validator",
    "display_name": "BIDS Validator",
    "container": {"image": "bids/validator", "tag": "1.14.13", "engine": "docker"},
    "execution": {"type": "docker"},
    "dataset_positional": True,
    "parameters": [],
    "max_runtime_hours": 1.0,
    "known_errors": [],
}

FC_MANIFEST = {
    "id": "functional-connectivity",
    "display_name": "Functional Connectivity",
    "container": {"image": "ghcr.io/neuroforge/functional-connectivity", "tag": "0.1.0"},
    "execution": {"type": "docker"},
    "dataset_positional": True,
    "parameters": [
        {"name": "atlas", "type": "string", "default": "schaefer100", "internal": False},
        {"name": "n-jobs", "type": "integer", "default": 1, "internal": False},
        {"name": "debug", "type": "boolean", "default": False, "internal": False},
    ],
    "max_runtime_hours": 0.5,
    "known_errors": [],
}

MOUNTED_MANIFEST = {
    "id": "fmriprep",
    "display_name": "fMRIPrep",
    "container": {"image": "nipreps/fmriprep", "tag": "24.0.0"},
    "execution": {"type": "docker"},
    "dataset_positional": True,
    "parameters": [
        {
            "name": "fs-license-file",
            "type": "file_path",
            "mount": True,
            "required": True,
            "internal": False,
        },
    ],
    "known_errors": [],
}

HOST_CFG = {
    "hostname": "10.0.0.1",
    "ssh_port": 22,
    "username": "neuroforge",
    "key_path": "/home/user/.ssh/id_ed25519",
    "remote_work_root": "/scratch/neuroforge",
    "docker_host": None,
}


def _ctx(manifest=None, params=None, run_id=42) -> RunContext:
    return RunContext(
        run_id=run_id,
        manifest=manifest or MINIMAL_MANIFEST,
        params=params or {},
        dataset_path="/app/data/bids-ds001",
        output_dir="/app/data/derivatives/bids-validator/42",
    )


# ── _build_remote_docker_cmd ──────────────────────────────────────────────────


def test_build_command_basic_structure():
    cmd = _build_remote_docker_cmd(
        _ctx(),
        remote_input_dir="/scratch/neuroforge/runs/42/input",
        remote_output_dir="/scratch/neuroforge/runs/42/output",
        mounted_remote_paths={},
        docker_host=None,
    )
    assert cmd[0] == "docker"
    assert "run" in cmd
    assert "--platform" in cmd
    assert "linux/amd64" in cmd
    # Dataset and output volumes
    assert any("/data:ro" in v for v in cmd)
    assert any("/out:rw" in v for v in cmd)
    # Image
    assert "bids/validator:1.14.13" in cmd
    # BIDS positional args
    assert "/data" in cmd
    assert "/out" in cmd


def test_build_command_with_docker_host():
    cmd = _build_remote_docker_cmd(
        _ctx(),
        "/input", "/output", {},
        docker_host="unix:///var/run/docker.sock",
    )
    assert "-H" in cmd
    assert "unix:///var/run/docker.sock" in cmd


def test_build_command_string_param():
    cmd = _build_remote_docker_cmd(
        _ctx(FC_MANIFEST, params={"atlas": "aal"}),
        "/input", "/output", {},
        docker_host=None,
    )
    assert "--atlas" in cmd
    idx = cmd.index("--atlas")
    assert cmd[idx + 1] == "aal"


def test_build_command_boolean_param_true():
    cmd = _build_remote_docker_cmd(
        _ctx(FC_MANIFEST, params={"debug": True}),
        "/input", "/output", {},
        docker_host=None,
    )
    assert "--debug" in cmd


def test_build_command_boolean_param_false():
    cmd = _build_remote_docker_cmd(
        _ctx(FC_MANIFEST, params={"debug": False}),
        "/input", "/output", {},
        docker_host=None,
    )
    assert "--debug" not in cmd


def test_build_command_mounted_param():
    cmd = _build_remote_docker_cmd(
        _ctx(MOUNTED_MANIFEST, params={"fs-license-file": "/home/user/license.txt"}),
        "/input", "/output",
        mounted_remote_paths={"fs-license-file": "/scratch/neuroforge/runs/42/inputs/fs-license-file/license.txt"},
        docker_host=None,
    )
    # Volume mount for the param
    assert any("fs-license-file" in v for v in cmd)
    # CLI flag should use container path
    idx = cmd.index("--fs-license-file")
    assert "/inputs/fs-license-file/license.txt" in cmd[idx + 1]


def test_build_command_no_dataset_positional():
    manifest = dict(MINIMAL_MANIFEST)
    manifest["dataset_positional"] = False
    cmd = _build_remote_docker_cmd(
        _ctx(manifest),
        "/input", "/output", {},
        docker_host=None,
    )
    # No /data positional args — but /out volume should still be mounted
    assert any("/out:rw" in v for v in cmd)
    # /data should not appear as a positional arg (only in volume if positional=True)
    assert "/data" not in cmd


def test_build_command_digest_tag():
    manifest = dict(MINIMAL_MANIFEST)
    manifest["container"] = {"image": "bids/validator", "tag": "sha256:abc123"}
    cmd = _build_remote_docker_cmd(
        _ctx(manifest),
        "/input", "/output", {},
        docker_host=None,
    )
    assert "bids/validator@sha256:abc123" in cmd


# ── Path safety ───────────────────────────────────────────────────────────────


def test_remote_work_root_used_in_shell_quoted_form():
    """Shell command sent over SSH must not allow injection via remote paths."""
    import shlex

    from app.execution.ssh_executor import SSHExecutor

    cfg = dict(HOST_CFG)
    cfg["remote_work_root"] = "/scratch/neuroforge"
    ex = SSHExecutor(cfg)
    ctx = _ctx()
    remote_in, remote_out = ex._remote_dirs(ctx)

    # Both dirs must be safely quoteable
    assert shlex.quote(remote_in) == remote_in or remote_in.startswith("/scratch")
    assert shlex.quote(remote_out) == remote_out or remote_out.startswith("/scratch")
    # Neither should allow shell injection
    assert ";" not in remote_in
    assert "`" not in remote_in


def test_run_id_scopes_dirs():
    from app.execution.ssh_executor import SSHExecutor

    ex = SSHExecutor(HOST_CFG)
    ctx_a = _ctx(run_id=1)
    ctx_b = _ctx(run_id=99)
    in_a, out_a = ex._remote_dirs(ctx_a)
    in_b, out_b = ex._remote_dirs(ctx_b)
    assert in_a != in_b
    assert out_a != out_b
    assert "/runs/1/" in in_a
    assert "/runs/99/" in in_b


# ── Preflight ─────────────────────────────────────────────────────────────────


def test_preflight_connection_failure():
    """When SSH connect fails, preflight returns connected=False with error."""
    with patch("app.execution.ssh_executor._ssh_connect", side_effect=Exception("timeout")):
        result = run_preflight(HOST_CFG)
    assert result.connected is False
    assert any("timeout" in e for e in result.errors)
    assert len(result.checks) == 0


def test_preflight_docker_not_found():
    """When docker returns non-zero, preflight records the error."""
    mock_client = MagicMock()

    def _exec_side(cmd, **_):
        if "uname" in cmd:
            return 0, "arm64", ""
        if "docker version" in cmd:
            return 1, "", "Cannot connect to the Docker daemon"
        if "mkdir" in cmd:
            return 0, "", ""
        if "df" in cmd:
            return 0, "tmpfs 20G 5G 15G 25% /", ""
        return 0, "", ""

    mock_client.exec_command.side_effect = lambda cmd, **kw: _mock_exec(cmd, _exec_side(cmd))

    with patch("app.execution.ssh_executor._ssh_connect", return_value=mock_client), \
         patch("app.execution.ssh_executor._exec", side_effect=lambda c, cmd, **kw: _exec_side(cmd)):
        result = run_preflight(HOST_CFG)

    assert result.connected is True
    docker_check = next((c for c in result.checks if c.name == "docker"), None)
    assert docker_check is not None
    assert docker_check.passed is False
    assert any("Docker" in e for e in result.errors)


def _mock_exec(cmd, ret):
    """Build a paramiko-style (stdin, stdout, stderr) triple from (code, out, err)."""
    code, out, err = ret
    stdin = MagicMock()
    stdout = MagicMock()
    stderr = MagicMock()
    stdout.read.return_value = out.encode()
    stderr.read.return_value = err.encode()
    stdout.channel.recv_exit_status.return_value = code
    return stdin, stdout, stderr


def test_preflight_low_disk_warning():
    """When disk < 10 GB, preflight records a warning but does not error."""
    def fake_exec(client, cmd, timeout=30):
        if "uname" in cmd:
            return 0, "x86_64", ""
        if "docker version" in cmd:
            return 0, "25.0.0", ""
        if "mkdir" in cmd or "touch" in cmd or ".nf_probe" in cmd:
            return 0, "", ""
        if "df" in cmd:
            return 0, "/dev/sda1 100G 95G 3G 97% /", ""
        return 0, "", ""

    with patch("app.execution.ssh_executor._ssh_connect", return_value=MagicMock()), \
         patch("app.execution.ssh_executor._exec", side_effect=fake_exec):
        result = run_preflight(HOST_CFG)

    assert result.connected is True
    assert len(result.errors) == 0
    assert len(result.warnings) > 0
    assert any("3.0 GB" in w for w in result.warnings)
