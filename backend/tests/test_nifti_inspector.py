"""Regression tests for the NIfTI Inspector native tool.

Covers: header parsing, histogram generation, warning detection, datatype
parsing, orientation parsing, NaN detection, and the 3-file entry point.

All tests use synthetic in-memory NIfTI images — no real fMRIPrep data
or external downloads required.
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest


# ── Synthetic NIfTI helpers ───────────────────────────────────────────────────

def _make_nifti(
    shape=(30, 30, 20),
    affine: np.ndarray | None = None,
    dtype=np.float32,
    qform_code: int = 1,
    sform_code: int = 1,
    n_volumes: int = 1,
) -> nib.Nifti1Image:
    if affine is None:
        affine = np.diag([2.0, 2.0, 2.0, 1.0])
    data_shape = shape if n_volumes == 1 else (*shape, n_volumes)
    rng = np.random.default_rng(42)
    data = rng.normal(0, 1, data_shape).astype(dtype)
    img = nib.Nifti1Image(data, affine)
    img.header.set_qform(affine, code=qform_code)
    img.header.set_sform(affine, code=sform_code)
    return img


def _save_nifti(img: nib.Nifti1Image, path: Path) -> None:
    nib.save(img, str(path))


# ── Header parsing ────────────────────────────────────────────────────────────

def test_header_dimensions():
    from app.tools.nifti_inspector import _parse_header
    img = _make_nifti(shape=(91, 109, 91))
    h = _parse_header(img)
    assert h["dimensions"] == [91, 109, 91]


def test_header_n_volumes():
    from app.tools.nifti_inspector import _parse_header
    img = _make_nifti(shape=(10, 10, 10), n_volumes=20)
    h = _parse_header(img)
    assert h["n_volumes"] == 20


def test_header_voxel_spacing():
    from app.tools.nifti_inspector import _parse_header
    affine = np.diag([3.0, 3.0, 4.5, 1.0])
    img = _make_nifti(affine=affine)
    h = _parse_header(img)
    assert abs(h["voxel_spacing_mm"][0] - 3.0) < 0.01
    assert abs(h["voxel_spacing_mm"][2] - 4.5) < 0.01


def test_header_orientation_ras():
    from app.tools.nifti_inspector import _parse_header
    affine = np.eye(4)
    img = _make_nifti(affine=affine)
    h = _parse_header(img)
    # Identity affine → RAS
    assert "R" in h["orientation"] or "L" in h["orientation"]


def test_header_datatype_float32():
    from app.tools.nifti_inspector import _parse_header
    img = _make_nifti(dtype=np.float32)
    h = _parse_header(img)
    assert "float32" in h["datatype"]


def test_header_datatype_int16():
    from app.tools.nifti_inspector import _parse_header
    img = _make_nifti(dtype=np.int16)
    h = _parse_header(img)
    assert "int16" in h["datatype"]


def test_header_qform_sform_codes():
    from app.tools.nifti_inspector import _parse_header
    img = _make_nifti(qform_code=1, sform_code=2)
    h = _parse_header(img)
    assert h["qform_code"] == 1
    assert h["sform_code"] == 2


def test_header_tr_extracted():
    from app.tools.nifti_inspector import _parse_header
    img = _make_nifti(shape=(10, 10, 10), n_volumes=5)
    img.header.set_zooms([2.0, 2.0, 2.0, 2.5])  # TR = 2.5 s
    h = _parse_header(img)
    assert h["tr_seconds"] is not None
    assert abs(h["tr_seconds"] - 2.5) < 0.01


# ── Stats ─────────────────────────────────────────────────────────────────────

def test_stats_min_max():
    from app.tools.nifti_inspector import _compute_stats
    data = np.array([[[0.0, 1.0], [2.0, 3.0]]], dtype=np.float32)
    s = _compute_stats(data)
    assert abs(s["min"] - 0.0) < 1e-6
    assert abs(s["max"] - 3.0) < 1e-6


def test_stats_mean():
    from app.tools.nifti_inspector import _compute_stats
    data = np.ones((10, 10, 10), dtype=np.float32) * 5.0
    s = _compute_stats(data)
    assert abs(s["mean"] - 5.0) < 1e-4


def test_stats_nan_count():
    from app.tools.nifti_inspector import _compute_stats
    data = np.ones((5, 5, 5), dtype=np.float64)
    data[0, 0, 0] = np.nan
    data[1, 1, 1] = np.nan
    s = _compute_stats(data)
    assert s["nan_count"] == 2


def test_stats_inf_count():
    from app.tools.nifti_inspector import _compute_stats
    data = np.ones((5, 5, 5), dtype=np.float64)
    data[0, 0, 0] = np.inf
    s = _compute_stats(data)
    assert s["inf_count"] == 1


def test_stats_nonzero_pct():
    from app.tools.nifti_inspector import _compute_stats
    data = np.zeros((10, 10, 10), dtype=np.float32)
    data[:5, :5, :5] = 1.0  # 125 / 1000 = 12.5%
    s = _compute_stats(data)
    assert abs(s["nonzero_pct"] - 12.5) < 0.1


def test_histogram_has_bins_and_counts():
    from app.tools.nifti_inspector import _compute_stats
    rng = np.random.default_rng(0)
    data = rng.normal(0, 1, (20, 20, 20)).astype(np.float32)
    s = _compute_stats(data, n_bins=32)
    assert len(s["histogram_bins"]) == 32
    assert len(s["histogram_counts"]) == 32
    assert sum(s["histogram_counts"]) > 0


# ── Warning detection ─────────────────────────────────────────────────────────

def test_warning_nan_detected():
    from app.tools.nifti_inspector import _detect_warnings
    hdr = {"qform_code": 1, "sform_code": 1, "qform_name": "scanner", "sform_name": "scanner",
           "dimensions": [10, 10, 10], "datatype": "float32", "datatype_code": 16}
    stats = {"nan_count": 5, "inf_count": 0, "dynamic_range": 1.0, "nonzero_count": 100}
    warns = _detect_warnings(hdr, stats)
    codes = [w["code"] for w in warns]
    assert "nan_detected" in codes


def test_warning_empty_mask():
    from app.tools.nifti_inspector import _detect_warnings
    hdr = {"qform_code": 1, "sform_code": 1, "qform_name": "scanner", "sform_name": "scanner",
           "dimensions": [10, 10, 10], "datatype": "float32", "datatype_code": 16}
    stats = {"nan_count": 0, "inf_count": 0, "dynamic_range": 0.0, "nonzero_count": 0}
    warns = _detect_warnings(hdr, stats)
    codes = [w["code"] for w in warns]
    assert "empty_mask" in codes


def test_warning_qform_sform_mismatch():
    from app.tools.nifti_inspector import _detect_warnings
    hdr = {"qform_code": 1, "sform_code": 2, "qform_name": "scanner", "sform_name": "aligned",
           "dimensions": [10, 10, 10], "datatype": "float32", "datatype_code": 16}
    stats = {"nan_count": 0, "inf_count": 0, "dynamic_range": 1.0, "nonzero_count": 100}
    warns = _detect_warnings(hdr, stats)
    codes = [w["code"] for w in warns]
    assert "qform_sform_mismatch" in codes


def test_warning_zero_dynamic_range():
    from app.tools.nifti_inspector import _detect_warnings
    hdr = {"qform_code": 1, "sform_code": 1, "qform_name": "scanner", "sform_name": "scanner",
           "dimensions": [10, 10, 10], "datatype": "float32", "datatype_code": 16}
    stats = {"nan_count": 0, "inf_count": 0, "dynamic_range": 0.0, "nonzero_count": 100}
    warns = _detect_warnings(hdr, stats)
    codes = [w["code"] for w in warns]
    assert "zero_dynamic_range" in codes


def test_no_warnings_clean_image():
    from app.tools.nifti_inspector import _detect_warnings
    hdr = {"qform_code": 1, "sform_code": 1, "qform_name": "scanner", "sform_name": "scanner",
           "dimensions": [10, 10, 10], "datatype": "float32", "datatype_code": 16}
    stats = {"nan_count": 0, "inf_count": 0, "dynamic_range": 2.5, "nonzero_count": 50}
    warns = _detect_warnings(hdr, stats)
    assert warns == []


# ── Entry point: 3 output files ───────────────────────────────────────────────

def test_entry_point_produces_three_files():
    """Invoke the real entry point and verify nifti_inspector.json,
    nifti_histogram.png, and nifti_report.html are written."""
    from app.tools.nifti_inspector import run as inspector_run

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        nii_path = td / "test.nii.gz"
        img = _make_nifti(shape=(15, 15, 10))
        _save_nifti(img, nii_path)

        out_dir = td / "out"
        inspector_run(["--input-file", str(nii_path), "--output-dir", str(out_dir)])

        assert (out_dir / "nifti_inspector.json").exists(), "nifti_inspector.json missing"
        assert (out_dir / "nifti_histogram.png").exists(), "nifti_histogram.png missing"
        assert (out_dir / "nifti_report.html").exists(), "nifti_report.html missing"


def test_entry_point_json_keys():
    """The inspector JSON must have required top-level and nested keys."""
    from app.tools.nifti_inspector import run as inspector_run

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        nii_path = td / "test.nii.gz"
        _save_nifti(_make_nifti(), nii_path)
        out_dir = td / "out"
        inspector_run(["--input-file", str(nii_path), "--output-dir", str(out_dir)])

        with open(out_dir / "nifti_inspector.json") as f:
            result = json.load(f)

        assert "header" in result
        assert "stats" in result
        assert "warnings" in result
        assert "provenance" in result
        assert "nibabel_version" in result["provenance"]
        assert "header_hash" in result["provenance"]
        assert result["provenance"]["header_hash"].startswith("sha256:")
        assert "dimensions" in result["header"]
        assert "orientation" in result["header"]
        assert "datatype" in result["header"]
        assert "nan_count" in result["stats"]


def test_entry_point_missing_file_raises():
    """Non-existent input file must raise FileNotFoundError."""
    from app.tools.nifti_inspector import run as inspector_run
    with tempfile.TemporaryDirectory() as td:
        with pytest.raises(FileNotFoundError):
            inspector_run(["--input-file", "/nonexistent/file.nii.gz", "--output-dir", td])


def test_entry_point_nan_detected_in_output():
    """When the NIfTI contains NaN, the JSON warnings must include nan_detected."""
    from app.tools.nifti_inspector import run as inspector_run

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        nii_path = td / "nan_test.nii.gz"
        img = _make_nifti(shape=(10, 10, 10))
        data = np.asarray(img.dataobj).copy()
        data[0, 0, 0] = np.nan
        nan_img = nib.Nifti1Image(data, img.affine, img.header)
        _save_nifti(nan_img, nii_path)

        out_dir = td / "out"
        inspector_run(["--input-file", str(nii_path), "--output-dir", str(out_dir)])

        with open(out_dir / "nifti_inspector.json") as f:
            result = json.load(f)

        codes = [w["code"] for w in result["warnings"]]
        assert "nan_detected" in codes
        assert result["stats"]["nan_count"] >= 1


# ── Manifest ──────────────────────────────────────────────────────────────────

def test_manifest_exists():
    manifest = Path(__file__).parent.parent.parent / "pipelines" / "nifti-inspector.yaml"
    assert manifest.exists(), "nifti-inspector.yaml is missing"


def test_manifest_artifact_types_registered():
    import yaml
    types_path = Path(__file__).parent.parent.parent / "pipelines" / "schema" / "artifact_types.yaml"
    manifest_path = Path(__file__).parent.parent.parent / "pipelines" / "nifti-inspector.yaml"
    with open(types_path) as f:
        types = yaml.safe_load(f)["artifact_types"]
    with open(manifest_path) as f:
        manifest = yaml.safe_load(f)
    for prod in manifest.get("produces", []):
        t = prod["type"]
        assert t in types, f"Artifact type '{t}' declared in manifest but missing from artifact_types.yaml"
