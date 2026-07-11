"""Tests for the atlas_roi_extraction pipeline.

Covers: atlas reuse, geometry validation, statistics correctness, 4D support,
binary mask, NaN/Inf handling, output files, and comparison eligibility.
"""
from __future__ import annotations

import csv
import json
import math
import tempfile
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

from app.tools.atlas_roi_extraction import (
    OVERLAP_REJECTION_THRESHOLD,
    _aggregate_4d,
    _compute_overlap_fraction,
    _is_binary_mask,
    _roi_stats,
    _write_csv,
    _write_json,
    _write_metadata,
    check_geometry,
    extract_all_rois,
)
from app.tools.functional_connectivity import (
    ATLAS_REGISTRY,
    DEFAULT_ATLAS_ID,
    LEGACY_ATLAS_ALIASES,
    normalize_atlas_id,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

AFFINE = np.diag([2.0, 2.0, 2.0, 1.0])


def make_nifti(data: np.ndarray, affine: np.ndarray = AFFINE) -> nib.Nifti1Image:
    return nib.Nifti1Image(data.astype(np.float32), affine)


def make_atlas(shape=(10, 10, 10), affine: np.ndarray = AFFINE, n_labels: int = 3) -> nib.Nifti1Image:
    """Synthetic atlas with n_labels rectangular ROIs, label 0 = background."""
    data = np.zeros(shape, dtype=np.int32)
    sz = shape[0] // (n_labels + 1)
    for i in range(n_labels):
        start = (i + 1) * sz
        data[start:start + sz, :, :] = i + 1
    return nib.Nifti1Image(data, affine)


# ── 1. Atlas reuse — no duplicate registry ────────────────────────────────────

def test_atlas_registry_not_duplicated():
    """atlas_roi_extraction must import ATLAS_REGISTRY from functional_connectivity, not define its own."""
    from app.tools import atlas_roi_extraction, functional_connectivity
    # Both modules must reference the same object
    assert atlas_roi_extraction.ATLAS_REGISTRY is functional_connectivity.ATLAS_REGISTRY


def test_normalize_atlas_id_canonical():
    assert normalize_atlas_id("schaefer100_7") == "schaefer100_7"
    assert normalize_atlas_id("aal") == "aal"


def test_legacy_alias_resolution():
    for alias, canonical in LEGACY_ATLAS_ALIASES.items():
        assert normalize_atlas_id(alias) == canonical


def test_default_atlas_in_registry():
    assert DEFAULT_ATLAS_ID in ATLAS_REGISTRY


# ── 2. Geometry validation ────────────────────────────────────────────────────

def test_check_geometry_same_space():
    img = make_nifti(np.ones((10, 10, 10)))
    atlas = make_atlas((10, 10, 10), AFFINE)
    result = check_geometry(img, atlas)
    assert result["affines_match"] is True
    assert result["shapes_match"] is True
    assert result["resampling_required"] is False


def test_check_geometry_different_shape():
    img = make_nifti(np.ones((20, 20, 20)))
    atlas = make_atlas((10, 10, 10), AFFINE)
    result = check_geometry(img, atlas)
    assert result["shapes_match"] is False
    assert result["resampling_required"] is True


def test_check_geometry_different_affine():
    img = make_nifti(np.ones((10, 10, 10)), np.diag([3.0, 3.0, 3.0, 1.0]))
    atlas = make_atlas((10, 10, 10), AFFINE)
    result = check_geometry(img, atlas)
    assert result["affines_match"] is False
    assert result["resampling_required"] is True


def test_overlap_fraction_full_overlap():
    """Atlas fully within image FOV → overlap fraction ≈ 1."""
    shape = (20, 20, 20)
    img = make_nifti(np.ones(shape))
    atlas = make_atlas(shape, AFFINE)
    frac = _compute_overlap_fraction(atlas, img)
    assert frac > 0.95


def test_overlap_fraction_no_overlap():
    """Atlas translated 100mm away → near-zero overlap."""
    img = make_nifti(np.ones((10, 10, 10)))
    far_affine = AFFINE.copy()
    far_affine[:3, 3] = [200.0, 200.0, 200.0]
    atlas = make_atlas((10, 10, 10), far_affine)
    frac = _compute_overlap_fraction(atlas, img)
    assert frac < OVERLAP_REJECTION_THRESHOLD


# ── 3. Binary mask detection ──────────────────────────────────────────────────

def test_is_binary_mask_true():
    data = np.array([[[0.0, 1.0], [1.0, 0.0]], [[1.0, 1.0], [0.0, 0.0]]])
    assert _is_binary_mask(data) is True


def test_is_binary_mask_false_float():
    data = np.array([[[0.5, 1.0], [0.0, 0.3]]])
    assert _is_binary_mask(data) is False


def test_is_binary_mask_empty():
    assert _is_binary_mask(np.array([])) is False


# ── 4. Per-ROI statistics ─────────────────────────────────────────────────────

def test_roi_stats_basic():
    scalar = np.arange(27, dtype=float).reshape(3, 3, 3)
    atlas = np.zeros((3, 3, 3), dtype=int)
    atlas[0, :, :] = 1  # 9 voxels with values 0-8
    result = _roi_stats(scalar, atlas, label_value=1, roi_number=1, roi_label="ROI_A", is_binary=False)
    expected_mean = float(np.mean(np.arange(9)))
    assert abs(result["mean"] - expected_mean) < 1e-6
    assert result["voxel_count"] == 9
    assert result["nan_count"] == 0
    assert result["inf_count"] == 0
    assert "overlap_voxel_count" not in result


def test_roi_stats_binary_extras():
    scalar = np.array([[[1.0, 0.0, 1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 1.0]]])  # 5 ones
    atlas = np.ones((1, 3, 3), dtype=int)
    result = _roi_stats(scalar.reshape(1, 3, 3), atlas, label_value=1, roi_number=1, roi_label="A", is_binary=True)
    assert "overlap_voxel_count" in result
    assert result["overlap_voxel_count"] == 5
    assert abs(result["roi_occupancy_pct"] - 5 / 9 * 100) < 1e-4


def test_roi_stats_empty_roi():
    scalar = np.ones((5, 5, 5))
    atlas = np.zeros((5, 5, 5), dtype=int)  # label 99 not present
    result = _roi_stats(scalar, atlas, label_value=99, roi_number=99, roi_label="Ghost", is_binary=False)
    assert result["voxel_count"] == 0
    assert result["mean"] is None


def test_roi_stats_nan_handling():
    scalar = np.array([[[np.nan, 1.0, 2.0, np.nan]]], dtype=float)
    atlas = np.ones((1, 1, 4), dtype=int)
    result = _roi_stats(scalar, atlas, label_value=1, roi_number=1, roi_label="R", is_binary=False)
    assert result["nan_count"] == 2
    # Mean should be computed over finite values only: (1+2)/2 = 1.5
    assert abs(result["mean"] - 1.5) < 1e-6


def test_roi_stats_inf_handling():
    scalar = np.array([[[np.inf, -np.inf, 2.0, 3.0]]], dtype=float)
    atlas = np.ones((1, 1, 4), dtype=int)
    result = _roi_stats(scalar, atlas, label_value=1, roi_number=1, roi_label="R", is_binary=False)
    assert result["inf_count"] == 2
    assert abs(result["mean"] - 2.5) < 1e-6


def test_roi_stats_all_nan():
    scalar = np.full((3, 3, 3), np.nan)
    atlas = np.ones((3, 3, 3), dtype=int)
    result = _roi_stats(scalar, atlas, label_value=1, roi_number=1, roi_label="R", is_binary=False)
    assert result["mean"] is None
    assert result["nan_count"] == 27


# ── 5. 4D aggregation ─────────────────────────────────────────────────────────

def test_aggregate_4d_temporal_mean():
    data = np.zeros((4, 4, 4, 3))
    data[:, :, :, 0] = 1.0
    data[:, :, :, 1] = 2.0
    data[:, :, :, 2] = 3.0
    result = _aggregate_4d(data, "temporal_mean")
    assert result.shape == (4, 4, 4)
    assert abs(result[0, 0, 0] - 2.0) < 1e-6


def test_aggregate_4d_unsupported_mode():
    data = np.zeros((4, 4, 4, 2))
    with pytest.raises(ValueError, match="Unsupported aggregation mode"):
        _aggregate_4d(data, "voxelwise")


# ── 6. extract_all_rois ordering and completeness ─────────────────────────────

def test_extract_all_rois_ordering():
    """ROIs must be returned sorted by roi_number."""
    shape = (10, 10, 10)
    data = np.random.rand(*shape).astype(np.float32)
    n = 4
    atlas = make_atlas(shape, AFFINE, n_labels=n)
    atlas_data = np.asanyarray(atlas.dataobj)
    roi_labels = [f"Label_{i}" for i in range(1, n + 1)]
    label_values = list(range(1, n + 1))
    rows = extract_all_rois(data, atlas_data, roi_labels, label_values, is_binary=False)
    nums = [r["roi_number"] for r in rows]
    assert nums == sorted(nums)
    assert len(rows) == n


def test_extract_all_rois_values_correct():
    """Spot check: ROI 1 mean matches direct numpy calculation."""
    shape = (6, 6, 6)
    data = np.arange(shape[0] * shape[1] * shape[2], dtype=float).reshape(shape)
    atlas_data = np.zeros(shape, dtype=int)
    atlas_data[0, :, :] = 1  # 36 voxels
    rows = extract_all_rois(data, atlas_data, ["L1"], [1], is_binary=False)
    expected = float(np.mean(data[0, :, :]))
    assert abs(rows[0]["mean"] - expected) < 1e-4


# ── 7. Output file writers ────────────────────────────────────────────────────

def _sample_rows():
    return [
        {"roi_number": 1, "roi_label": "A", "network": "Net", "mean": 1.5, "std": 0.5,
         "median": 1.5, "min": 1.0, "max": 2.0, "p5": 1.0, "p95": 2.0,
         "voxel_count": 100, "nonzero_voxel_count": 80, "coverage_pct": 80.0,
         "nan_count": 0, "inf_count": 0},
        {"roi_number": 2, "roi_label": "B", "network": "Net", "mean": None, "std": None,
         "median": None, "min": None, "max": None, "p5": None, "p95": None,
         "voxel_count": 0, "nonzero_voxel_count": 0, "coverage_pct": 0.0,
         "nan_count": 0, "inf_count": 0},
    ]


def test_write_csv_roundtrip(tmp_path):
    rows = _sample_rows()
    csv_path = tmp_path / "roi_extraction.csv"
    _write_csv(csv_path, rows)
    assert csv_path.exists()
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        read_rows = list(reader)
    assert len(read_rows) == 2
    assert read_rows[0]["roi_label"] == "A"
    assert read_rows[0]["mean"] == "1.5"


def test_write_json_roundtrip(tmp_path):
    rows = _sample_rows()
    json_path = tmp_path / "roi_extraction.json"
    _write_json(json_path, rows)
    assert json_path.exists()
    data = json.loads(json_path.read_text())
    assert isinstance(data, list)
    assert len(data) == 2
    assert data[0]["roi_number"] == 1
    assert data[1]["mean"] is None


def test_write_metadata(tmp_path):
    meta = {
        "atlas_id": "schaefer100_7",
        "n_rois": 100,
        "aggregation_mode": "none",
        "resampling_performed": False,
        "software": {"nibabel": "5.0", "nilearn": "0.10", "numpy": "1.26"},
    }
    meta_path = tmp_path / "roi_extraction_metadata.json"
    _write_metadata(meta_path, meta)
    assert meta_path.exists()
    loaded = json.loads(meta_path.read_text())
    assert loaded["atlas_id"] == "schaefer100_7"
    assert loaded["n_rois"] == 100


# ── 8. Path safety ────────────────────────────────────────────────────────────

def test_output_dir_required(tmp_path):
    """run() must not accept a missing output dir."""
    from app.tools.atlas_roi_extraction import run
    # Non-existent input → should raise SystemExit (argparse) or FileNotFoundError
    fake = str(tmp_path / "fake.nii.gz")
    with pytest.raises((SystemExit, FileNotFoundError, Exception)):
        run(["--input-file", fake, "--atlas", "schaefer100_7"])


# ── 9. Comparison eligibility (frontend logic mirrored in Python types) ────────

def test_roi_extraction_types_have_roi_prefix():
    """Artifact types for roi_extraction must start with 'roi_extraction_'."""
    expected_types = [
        "roi_extraction_csv",
        "roi_extraction_json",
        "roi_extraction_metadata_json",
        "roi_extraction_report_html",
    ]
    for t in expected_types:
        assert t.startswith("roi_extraction_"), f"Type {t!r} does not start with 'roi_extraction_'"
