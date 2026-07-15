#!/usr/bin/env python3
"""Validate future native-x86 outputs beyond simple file existence."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Callable

import nibabel as nib
import numpy as np


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _latest_run(run_state: Path, pipeline: str) -> dict[str, Any]:
    marker = run_state / f"{pipeline}.run-id"
    if not marker.is_file():
        raise ValueError(f"Missing run ID marker: {marker}")
    run_id = marker.read_text().strip()
    state = run_state / f"run-{run_id}-latest.json"
    data = json.loads(state.read_text())
    if data.get("status") != "completed":
        raise ValueError(
            f"Run {run_id} status is {data.get('status')!r}, not completed"
        )
    return data


def _readable_nifti(path: Path) -> nib.spatialimages.SpatialImage:
    image = nib.load(path)
    if any(int(value) <= 0 for value in image.shape):
        raise ValueError(f"Invalid dimensions: {path}")
    if not np.isfinite(image.affine).all():
        raise ValueError(f"Non-finite affine: {path}")
    return image


def validate_pydeface(fixture: Path, output: Path) -> dict[str, Any]:
    original_path = fixture / "sub-01/anat/sub-01_T1w.nii.gz"
    result_path = output / "defaced.nii.gz"
    original = _readable_nifti(original_path)
    result = _readable_nifti(result_path)
    if original.shape != result.shape:
        raise ValueError("Defaced dimensions do not match the source")
    if not np.allclose(original.affine, result.affine, rtol=0, atol=1e-5):
        raise ValueError("Defaced affine does not match the source")
    source_data = np.asarray(original.dataobj)
    result_data = np.asarray(result.dataobj)
    changed = int(np.count_nonzero(source_data != result_data))
    nonzero = int(np.count_nonzero(result_data))
    if changed == 0 or nonzero == 0 or not np.isfinite(result_data).all():
        raise ValueError("Defaced output is identical, empty, or non-finite")
    return {
        "output": str(result_path),
        "shape": list(result.shape),
        "affine_preserved": True,
        "changed_voxels": changed,
        "nonzero_voxels": nonzero,
        "sha256": _sha256(result_path),
    }


def _one(root: Path, pattern: str) -> Path:
    matches = sorted(root.rglob(pattern))
    if not matches:
        raise ValueError(f"Expected output not found: {pattern}")
    return matches[0]


def validate_fmriprep(output: Path) -> dict[str, Any]:
    preproc = _one(output, "*_desc-preproc_bold.nii.gz")
    mask = _one(output, "*_desc-brain_mask.nii.gz")
    confounds_tsv = _one(output, "*_desc-confounds_timeseries.tsv")
    confounds_json = _one(output, "*_desc-confounds_timeseries.json")
    report = _one(output, "*.html")
    preproc_image = _readable_nifti(preproc)
    mask_image = _readable_nifti(mask)
    if len(preproc_image.shape) != 4 or len(mask_image.shape) != 3:
        raise ValueError("fMRIPrep BOLD or mask has unexpected dimensionality")
    if preproc_image.shape[:3] != mask_image.shape:
        raise ValueError("fMRIPrep BOLD and mask spatial dimensions differ")
    header = confounds_tsv.read_text(errors="replace").splitlines()[0].split("\t")
    if len(header) < 6:
        raise ValueError("Confounds TSV has too few columns")
    json.loads(confounds_json.read_text())
    crash_markers = list(output.rglob("crash-*.txt")) + list(
        output.rglob("crash-*.pklz")
    )
    if crash_markers:
        raise ValueError(f"fMRIPrep crash markers found: {len(crash_markers)}")
    return {
        "preprocessed_bold": str(preproc),
        "bold_shape": list(preproc_image.shape),
        "mask": str(mask),
        "confounds_tsv": str(confounds_tsv),
        "confounds_json": str(confounds_json),
        "confounds_columns": len(header),
        "report": str(report),
        "crash_markers": 0,
    }


def validate_fastsurfer(output: Path) -> dict[str, Any]:
    subject = output / "sub-01"
    required_dirs = [
        subject / name for name in ("mri", "surf", "label", "stats", "scripts")
    ]
    if not all(path.is_dir() for path in required_dirs):
        raise ValueError("FastSurfer subject directory is incomplete")
    volumes = [_one(subject / "mri", "orig.mgz"), _one(subject / "mri", "*aseg*.mgz")]
    for volume in volumes:
        _readable_nifti(volume)
    hemisphere: dict[str, Any] = {}
    for hemi in ("lh", "rh"):
        white = subject / "surf" / f"{hemi}.white"
        pial = subject / "surf" / f"{hemi}.pial"
        thickness = subject / "surf" / f"{hemi}.thickness"
        annot = _one(subject / "label", f"{hemi}.*.annot")
        vertices, faces = nib.freesurfer.read_geometry(white)
        pial_vertices, pial_faces = nib.freesurfer.read_geometry(pial)
        values = nib.freesurfer.read_morph_data(thickness)
        labels, _, _ = nib.freesurfer.read_annot(annot)
        if len(vertices) < 10_000 or len(faces) < 20_000:
            raise ValueError(f"Implausibly small {hemi} surface")
        if vertices.shape != pial_vertices.shape or faces.shape != pial_faces.shape:
            raise ValueError(f"White/pial topology differs for {hemi}")
        if len(values) != len(vertices) or len(labels) != len(vertices):
            raise ValueError(f"Thickness/annotation length mismatch for {hemi}")
        if (
            not np.isfinite(values).all()
            or np.nanmax(values) > 10
            or np.nanmin(values) < -1
        ):
            raise ValueError(f"Implausible thickness values for {hemi}")
        hemisphere[hemi] = {"vertices": len(vertices), "faces": len(faces)}
        _one(subject / "stats", f"{hemi}.*.stats")
    incomplete = list((subject / "scripts").glob("IsRunning*"))
    incomplete += list((subject / "scripts").glob("*.error"))
    if incomplete:
        raise ValueError(
            f"FastSurfer incomplete/error markers found: {len(incomplete)}"
        )
    completion = list((subject / "scripts").glob("*.done"))
    log_text = "\n".join(
        path.read_text(errors="replace")[-100_000:]
        for path in (subject / "scripts").glob("*.log")
    )
    if not completion and not re.search(
        r"finished successfully|recon-surf.*done", log_text, re.I
    ):
        raise ValueError("FastSurfer has no successful completion marker")
    return {
        "subject_directory": str(subject),
        "hemispheres": hemisphere,
        "volumes": [str(path) for path in volumes],
        "completion_markers": [str(path) for path in completion],
        "incomplete_markers": 0,
    }


VALIDATORS: dict[str, Callable[..., dict[str, Any]]] = {
    "pydeface": validate_pydeface,
    "fmriprep": validate_fmriprep,
    "fastsurfer": validate_fastsurfer,
}


def validate_all(fixture: Path, run_state: Path) -> dict[str, Any]:
    results: dict[str, Any] = {}
    all_valid = True
    for pipeline, validator in VALIDATORS.items():
        try:
            state = _latest_run(run_state, pipeline)
            output = Path(state["output_dir"])
            details = (
                validator(fixture, output)
                if pipeline == "pydeface"
                else validator(output)
            )
            results[pipeline] = {
                "status": "pass",
                "run_id": state["id"],
                "details": details,
            }
        except Exception as exc:
            all_valid = False
            results[pipeline] = {"status": "fail", "error": str(exc)}
    return {"schema_version": 1, "all_valid": all_valid, "pipelines": results}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--run-state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = validate_all(args.fixture, args.run_state)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["all_valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
