from __future__ import annotations

import hashlib
import json
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
from verification.fixtures.prepare_fixture import (
    FixtureError,
    prepare,
    validate,
)


def _write_fixture(root: Path, manifest_path: Path) -> None:
    files = {
        "dataset_description.json": json.dumps(
            {"Name": "Test", "DatasetDOI": "test-doi", "License": "CC0"}
        ).encode(),
        "sub-01/anat/sub-01_T1w.nii.gz": None,
        "sub-01/func/sub-01_task-test_bold.nii.gz": None,
    }
    root.mkdir()
    (root / "sub-01/anat").mkdir(parents=True)
    (root / "sub-01/func").mkdir(parents=True)
    nib.save(
        nib.Nifti1Image(np.zeros((2, 3, 4), dtype=np.int16), np.eye(4)),
        root / "sub-01/anat/sub-01_T1w.nii.gz",
    )
    nib.save(
        nib.Nifti1Image(np.zeros((2, 3, 4, 2), dtype=np.int16), np.eye(4)),
        root / "sub-01/func/sub-01_task-test_bold.nii.gz",
    )
    (root / "dataset_description.json").write_bytes(files["dataset_description.json"])
    entries = []
    for relative in files:
        data = (root / relative).read_bytes()
        entries.append(
            {
                "path": relative,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
    manifest_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "fixture_id": "test",
                "source": {"doi": "test-doi", "license": "CC0"},
                "transfer": {
                    "file_count": len(entries),
                    "total_bytes": sum(item["bytes"] for item in entries),
                },
                "files": entries,
            }
        )
    )


def test_prepare_copies_and_revalidates_fixture(tmp_path: Path) -> None:
    source = tmp_path / "source"
    manifest = tmp_path / "manifest.json"
    _write_fixture(source, manifest)

    result = prepare(source, tmp_path / "output", manifest)

    assert result["status"] == "prepared"
    assert result["file_count"] == 3
    assert len(result["images"]) == 2


def test_validation_rejects_changed_input(tmp_path: Path) -> None:
    source = tmp_path / "source"
    manifest = tmp_path / "manifest.json"
    _write_fixture(source, manifest)
    (source / "dataset_description.json").write_text("altered")

    with pytest.raises(FixtureError, match="Size mismatch|Checksum mismatch"):
        validate(source, manifest)


def test_dry_run_does_not_create_output(tmp_path: Path) -> None:
    source = tmp_path / "source"
    manifest = tmp_path / "manifest.json"
    output = tmp_path / "output"
    _write_fixture(source, manifest)

    result = prepare(source, output, manifest, dry_run=True)

    assert result["status"] == "dry-run-valid"
    assert not output.exists()
