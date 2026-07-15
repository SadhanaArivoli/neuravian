from __future__ import annotations

import zipfile
from pathlib import Path

import nibabel as nib
import numpy as np
from verification.x86.collect_evidence import collect
from verification.x86.validate_outputs import validate_fmriprep, validate_pydeface


def test_pydeface_validator_checks_header_and_voxel_change(tmp_path: Path) -> None:
    fixture = tmp_path / "fixture"
    output = tmp_path / "output"
    source_path = fixture / "sub-01/anat/sub-01_T1w.nii.gz"
    source_path.parent.mkdir(parents=True)
    output.mkdir()
    source = np.ones((4, 5, 6), dtype=np.int16)
    result = source.copy()
    result[0] = 0
    nib.save(nib.Nifti1Image(source, np.eye(4)), source_path)
    nib.save(nib.Nifti1Image(result, np.eye(4)), output / "defaced.nii.gz")

    validation = validate_pydeface(fixture, output)

    assert validation["changed_voxels"] == 30
    assert validation["affine_preserved"] is True
    assert len(validation["sha256"]) == 64


def test_fmriprep_validator_checks_derivative_content(tmp_path: Path) -> None:
    func = tmp_path / "sub-01/func"
    func.mkdir(parents=True)
    stem = "sub-01_task-test_space-MNI152NLin2009cAsym"
    nib.save(
        nib.Nifti1Image(np.ones((3, 4, 5, 7), dtype=np.float32), np.eye(4)),
        func / f"{stem}_desc-preproc_bold.nii.gz",
    )
    nib.save(
        nib.Nifti1Image(np.ones((3, 4, 5), dtype=np.uint8), np.eye(4)),
        func / f"{stem}_desc-brain_mask.nii.gz",
    )
    (func / "sub-01_task-test_desc-confounds_timeseries.tsv").write_text(
        "a\tb\tc\td\te\tf\n1\t2\t3\t4\t5\t6\n"
    )
    (func / "sub-01_task-test_desc-confounds_timeseries.json").write_text("{}")
    (tmp_path / "sub-01.html").write_text("report")

    validation = validate_fmriprep(tmp_path)

    assert validation["bold_shape"] == [3, 4, 5, 7]
    assert validation["confounds_columns"] == 6
    assert validation["crash_markers"] == 0


def test_evidence_zip_redacts_subject_and_home_path(tmp_path: Path) -> None:
    evidence = tmp_path / "evidence"
    (evidence / "logs").mkdir(parents=True)
    (evidence / "logs/run.log").write_text(
        "processed sub-01 at /home/researcher/neuroforge\n"
    )
    output = tmp_path / "bundle.zip"

    manifest = collect(evidence, output)

    assert output.is_file()
    assert len(manifest["files"]) >= 2
    with zipfile.ZipFile(output) as archive:
        text = archive.read("logs/run.log").decode()
        assert "sub-01" not in text
        assert "/home/researcher" not in text
        assert "fixture-subject" in text
