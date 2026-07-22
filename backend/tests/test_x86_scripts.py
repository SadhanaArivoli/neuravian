from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import nibabel as nib
import numpy as np

ROOT = Path(__file__).parents[2]
COMMAND_DIR = ROOT / "verification/x86/commands"
EXPECTED = [
    f"{index:02d}-{name}.sh"
    for index, name in enumerate(
        [
            "system-check",
            "neuravian-health",
            "pydeface-verify",
            "fmriprep-verify",
            "fastsurfer-smoke",
            "fastsurfer-full",
            "output-validation",
            "collect-evidence",
            "stop-and-cleanup",
        ]
    )
]


def test_paid_session_command_set_is_complete_and_valid_shell() -> None:
    assert all((COMMAND_DIR / name).is_file() for name in EXPECTED)
    scripts = [
        ROOT / "scripts/cloud/bootstrap-x86-ubuntu.sh",
        ROOT / "verification/x86/prepull-images.sh",
        ROOT / "verification/x86/transfer-fixture.sh",
        *(COMMAND_DIR / name for name in EXPECTED),
        COMMAND_DIR / "_common.sh",
    ]
    for script in scripts:
        subprocess.run(["bash", "-n", str(script)], check=True)


def test_paid_session_commands_are_strict_and_credential_free() -> None:
    for name in EXPECTED:
        text = (COMMAND_DIR / name).read_text()
        assert "set -euo pipefail" in text
        assert "AWS_ACCESS_KEY" not in text
        assert "/Users/" not in text
    long_commands = "\n".join(
        (COMMAND_DIR / name).read_text() for name in EXPECTED[2:6]
    )
    assert "TIMEOUT" in long_commands or "timeout" in long_commands
    assert "wait_for_run" in long_commands


def test_bootstrap_has_required_safe_arguments() -> None:
    text = (ROOT / "scripts/cloud/bootstrap-x86-ubuntu.sh").read_text()
    for flag in ("--commit", "--fixture-dir", "--prepull", "--dry-run"):
        assert flag in text
    assert "uname -m" in text
    assert "docker.com/linux/ubuntu" in text
    assert "aws " not in text.lower()
    assert "aec1aea247659f43a92a8f2fc39208d15a68914a" in text
    assert "timeout" in text


def _write_transfer_fixture(root: Path, manifest: Path) -> None:
    (root / "sub-01/anat").mkdir(parents=True)
    (root / "sub-01/func").mkdir(parents=True)
    (root / "dataset_description.json").write_text(
        json.dumps(
            {
                "Name": "Transfer test",
                "DatasetDOI": "test-doi",
                "License": "CC0",
            }
        )
    )
    nib.save(
        nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.int16), np.eye(4)),
        root / "sub-01/anat/sub-01_T1w.nii.gz",
    )
    nib.save(
        nib.Nifti1Image(np.zeros((2, 2, 2, 2), dtype=np.int16), np.eye(4)),
        root / "sub-01/func/sub-01_task-test_bold.nii.gz",
    )
    entries = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        data = path.read_bytes()
        entries.append(
            {
                "path": path.relative_to(root).as_posix(),
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
    manifest.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "fixture_id": "transfer-test",
                "source": {"doi": "test-doi", "license": "CC0"},
                "transfer": {
                    "file_count": len(entries),
                    "total_bytes": sum(item["bytes"] for item in entries),
                },
                "files": entries,
            }
        )
    )


def test_fixture_transfer_dry_run_is_resumable_and_manifest_scoped(
    tmp_path: Path,
) -> None:
    source = tmp_path / "fixture"
    manifest = tmp_path / "manifest.json"
    _write_transfer_fixture(source, manifest)
    result = subprocess.run(
        [
            str(ROOT / "verification/x86/transfer-fixture.sh"),
            "--host",
            "ubuntu@example.invalid",
            "--source",
            str(source),
            "--manifest",
            str(manifest),
            "--dry-run",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "--files-from=" in result.stdout
    assert "--append-verify" in result.stdout
    assert "Validated fixture on VM" not in result.stdout
    assert "DRY-RUN:" in result.stdout


def test_fixture_transfer_rejects_changed_source_before_ssh(tmp_path: Path) -> None:
    source = tmp_path / "fixture"
    manifest = tmp_path / "manifest.json"
    _write_transfer_fixture(source, manifest)
    (source / "dataset_description.json").write_text("changed")
    result = subprocess.run(
        [
            str(ROOT / "verification/x86/transfer-fixture.sh"),
            "--host",
            "ubuntu@example.invalid",
            "--source",
            str(source),
            "--manifest",
            str(manifest),
            "--dry-run",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "mismatch" in result.stderr.lower()
