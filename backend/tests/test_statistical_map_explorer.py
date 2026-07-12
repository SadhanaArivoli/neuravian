"""Regression tests for the Statistical Map Explorer tool.

All tests use synthetic NIfTI data — no real imaging data or external tools
required. Tests verify thresholding, cluster detection, coordinate computation,
output file contents, edge cases (NaN, empty map, 4D input, zero-origin affine),
and CLI entry-point execution.
"""
from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

from app.tools.statistical_map_explorer import (
    CLUSTER_CSV_COLUMNS,
    apply_threshold,
    compute_cluster_stats,
    detect_clusters,
    export_csv,
    export_cluster_json,
    render_cluster_overlay,
    render_html_report,
    run as explorer_run,
)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _identity_affine() -> np.ndarray:
    return np.eye(4, dtype=float)


def _save_nifti(data: np.ndarray, path: Path, affine: np.ndarray | None = None) -> None:
    aff = affine if affine is not None else _identity_affine()
    nib.save(nib.Nifti1Image(data.astype(np.float32), aff), str(path))


def _make_two_blob_data(shape=(30, 30, 30)) -> np.ndarray:
    """Two spatial blobs with peak values 5.0 and 3.5, background 0."""
    data = np.zeros(shape, dtype=np.float32)
    # Blob 1: 3×3×3 cube, 27 voxels, peak 5.0
    data[5:8, 5:8, 5:8] = 5.0
    # Blob 2: 2×2×2 cube, 8 voxels, peak 3.5
    data[20:22, 20:22, 20:22] = 3.5
    return data


# ── apply_threshold ───────────────────────────────────────────────────────────

class TestApplyThreshold:
    def test_positive_zeros_below(self):
        data = np.array([1.0, 2.5, 3.0, -4.0])
        out = apply_threshold(data, 2.3, "positive")
        assert out[0] == 0.0   # 1.0 < 2.3
        assert out[1] == 2.5   # survived
        assert out[2] == 3.0
        assert out[3] == 0.0   # negative, below positive threshold

    def test_negative_zeros_above(self):
        data = np.array([-1.0, -3.0, 2.0])
        out = apply_threshold(data, 2.3, "negative")
        assert out[0] == 0.0   # -1.0 > -2.3
        assert out[1] == -3.0  # -3.0 <= -2.3, survived
        assert out[2] == 0.0   # positive, above -threshold

    def test_two_sided(self):
        data = np.array([-3.0, -1.0, 0.5, 2.5])
        out = apply_threshold(data, 2.3, "two-sided")
        assert out[0] == -3.0   # |−3| >= 2.3
        assert out[1] == 0.0    # |−1| < 2.3
        assert out[2] == 0.0
        assert out[3] == 2.5

    def test_exact_threshold_survives(self):
        data = np.array([2.3])
        out = apply_threshold(data, 2.3, "positive")
        assert out[0] == pytest.approx(2.3)

    def test_invalid_direction(self):
        with pytest.raises(ValueError):
            apply_threshold(np.array([1.0]), 1.0, "sideways")

    def test_preserves_shape(self):
        data = np.zeros((5, 5, 5), dtype=np.float64)
        data[2, 2, 2] = 4.0
        out = apply_threshold(data, 3.0, "positive")
        assert out.shape == (5, 5, 5)

    def test_all_zeros_returns_zeros(self):
        data = np.zeros((4, 4, 4))
        out = apply_threshold(data, 2.3, "two-sided")
        assert out.sum() == 0.0


# ── detect_clusters ───────────────────────────────────────────────────────────

class TestDetectClusters:
    def test_two_blobs_detected(self):
        data = _make_two_blob_data()
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=5)
        assert n == 2

    def test_clusters_sorted_by_size(self):
        """Cluster 1 should be the largest (27 voxels vs 8 voxels)."""
        data = _make_two_blob_data()
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=1)
        assert n == 2
        size1 = int((labeled == 1).sum())
        size2 = int((labeled == 2).sum())
        assert size1 > size2

    def test_min_size_filters_small_cluster(self):
        data = _make_two_blob_data()
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=15)
        assert n == 1   # blob 2 (8 vox) is filtered out

    def test_empty_map_returns_zero(self):
        data = np.zeros((10, 10, 10), dtype=np.float32)
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=1)
        assert n == 0
        assert labeled.sum() == 0

    def test_single_voxel_cluster(self):
        data = np.zeros((5, 5, 5), dtype=np.float32)
        data[2, 2, 2] = 5.0
        thresh = apply_threshold(data, 3.0, "positive")
        labeled, n = detect_clusters(thresh, min_size=1)
        assert n == 1

    def test_single_voxel_filtered_by_min_size(self):
        data = np.zeros((5, 5, 5), dtype=np.float32)
        data[2, 2, 2] = 5.0
        thresh = apply_threshold(data, 3.0, "positive")
        labeled, n = detect_clusters(thresh, min_size=2)
        assert n == 0

    def test_labeled_array_shape_matches_input(self):
        data = _make_two_blob_data()
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, _ = detect_clusters(thresh, min_size=1)
        assert labeled.shape == data.shape

    def test_negative_direction(self):
        data = np.zeros((10, 10, 10), dtype=np.float32)
        data[3:6, 3:6, 3:6] = -4.0
        thresh = apply_threshold(data, 2.3, "negative")
        labeled, n = detect_clusters(thresh, min_size=1)
        assert n == 1


# ── compute_cluster_stats ──────────────────────────────────────────────────────

class TestComputeClusterStats:
    def test_stats_for_two_blobs(self):
        data = _make_two_blob_data()
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=1)
        stats = compute_cluster_stats(data, labeled, n, _identity_affine())
        assert len(stats) == 2

    def test_cluster_id_starts_at_one(self):
        data = _make_two_blob_data()
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=1)
        stats = compute_cluster_stats(data, labeled, n, _identity_affine())
        ids = [c["cluster_id"] for c in stats]
        assert ids == [1, 2]

    def test_size_matches_labeled_array(self):
        data = _make_two_blob_data()
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=1)
        stats = compute_cluster_stats(data, labeled, n, _identity_affine())
        for c in stats:
            assert c["size_voxels"] == int((labeled == c["cluster_id"]).sum())

    def test_peak_value_is_maximum(self):
        data = _make_two_blob_data()
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=1)
        stats = compute_cluster_stats(data, labeled, n, _identity_affine())
        # First cluster has peak 5.0
        assert abs(stats[0]["peak_value"]) == pytest.approx(5.0)

    def test_mni_coords_use_affine(self):
        """With a 2mm isotropic affine, mm coordinates should be 2× voxel coords."""
        data = np.zeros((20, 20, 20), dtype=np.float32)
        data[5:8, 5:8, 5:8] = 3.0
        aff = np.diag([2.0, 2.0, 2.0, 1.0])
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=1)
        stats = compute_cluster_stats(data, labeled, n, aff)
        # Peak voxel is somewhere in [5:8, 5:8, 5:8], so mm coords ≈ 10–14
        assert 8.0 <= stats[0]["peak_x_mm"] <= 16.0
        assert 8.0 <= stats[0]["peak_y_mm"] <= 16.0
        assert 8.0 <= stats[0]["peak_z_mm"] <= 16.0

    def test_all_stat_keys_present(self):
        data = _make_two_blob_data()
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=1)
        stats = compute_cluster_stats(data, labeled, n, _identity_affine())
        for c in stats:
            for col in CLUSTER_CSV_COLUMNS:
                assert col in c, f"Missing key: {col}"

    def test_bounding_box_valid(self):
        data = np.zeros((20, 20, 20), dtype=np.float32)
        data[5:8, 5:8, 5:8] = 3.0
        thresh = apply_threshold(data, 2.3, "positive")
        labeled, n = detect_clusters(thresh, min_size=1)
        stats = compute_cluster_stats(data, labeled, n, _identity_affine())
        c = stats[0]
        assert c["bbox_x0"] <= c["bbox_x1"]
        assert c["bbox_y0"] <= c["bbox_y1"]
        assert c["bbox_z0"] <= c["bbox_z1"]

    def test_empty_clusters_returns_empty_list(self):
        data = np.zeros((10, 10, 10), dtype=np.float32)
        labeled = np.zeros_like(data, dtype=int)
        stats = compute_cluster_stats(data, labeled, 0, _identity_affine())
        assert stats == []


# ── NaN handling ──────────────────────────────────────────────────────────────

class TestNaNHandling:
    def test_nan_voxels_treated_as_zero(self, tmp_path):
        data = np.zeros((10, 10, 10), dtype=np.float32)
        data[2:5, 2:5, 2:5] = 3.0
        data[0, 0, 0] = np.nan
        _save_nifti(data, tmp_path / "nan_map.nii.gz")
        outdir = tmp_path / "out"
        explorer_run([
            "--input-file", str(tmp_path / "nan_map.nii.gz"),
            "--output-dir", str(outdir),
            "--threshold", "2.3",
            "--direction", "positive",
        ])
        assert (outdir / "cluster_metadata.json").exists()
        meta = json.loads((outdir / "cluster_metadata.json").read_text())
        assert meta["n_clusters"] >= 1

    def test_all_nan_map_produces_zero_clusters(self, tmp_path):
        data = np.full((10, 10, 10), np.nan, dtype=np.float32)
        _save_nifti(data, tmp_path / "allnan.nii.gz")
        outdir = tmp_path / "out"
        explorer_run([
            "--input-file", str(tmp_path / "allnan.nii.gz"),
            "--output-dir", str(outdir),
            "--threshold", "2.3",
        ])
        meta = json.loads((outdir / "cluster_metadata.json").read_text())
        assert meta["n_clusters"] == 0


# ── Edge cases ────────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_empty_map_all_zeros(self, tmp_path):
        data = np.zeros((10, 10, 10), dtype=np.float32)
        _save_nifti(data, tmp_path / "zero.nii.gz")
        outdir = tmp_path / "out"
        explorer_run([
            "--input-file", str(tmp_path / "zero.nii.gz"),
            "--output-dir", str(outdir),
            "--threshold", "2.3",
        ])
        meta = json.loads((outdir / "cluster_metadata.json").read_text())
        assert meta["n_clusters"] == 0

    def test_4d_input_uses_first_volume(self, tmp_path):
        data = np.zeros((10, 10, 10, 3), dtype=np.float32)
        data[3:6, 3:6, 3:6, 0] = 5.0  # signal only in first volume
        _save_nifti(data, tmp_path / "4d.nii.gz")
        outdir = tmp_path / "out"
        explorer_run([
            "--input-file", str(tmp_path / "4d.nii.gz"),
            "--output-dir", str(outdir),
            "--threshold", "2.3",
        ])
        meta = json.loads((outdir / "cluster_metadata.json").read_text())
        assert meta["n_clusters"] == 1

    def test_threshold_higher_than_peak_yields_zero_clusters(self, tmp_path):
        data = _make_two_blob_data()
        _save_nifti(data, tmp_path / "blobs.nii.gz")
        outdir = tmp_path / "out"
        explorer_run([
            "--input-file", str(tmp_path / "blobs.nii.gz"),
            "--output-dir", str(outdir),
            "--threshold", "100.0",
        ])
        meta = json.loads((outdir / "cluster_metadata.json").read_text())
        assert meta["n_clusters"] == 0

    def test_two_sided_finds_positive_and_negative(self, tmp_path):
        data = np.zeros((15, 15, 15), dtype=np.float32)
        data[2:5, 2:5, 2:5] = 4.0   # positive blob
        data[10:13, 10:13, 10:13] = -4.0  # negative blob
        _save_nifti(data, tmp_path / "bipolar.nii.gz")
        outdir = tmp_path / "out"
        explorer_run([
            "--input-file", str(tmp_path / "bipolar.nii.gz"),
            "--output-dir", str(outdir),
            "--threshold", "2.3",
            "--direction", "two-sided",
        ])
        meta = json.loads((outdir / "cluster_metadata.json").read_text())
        assert meta["n_clusters"] == 2

    def test_non_identity_affine_preserved_in_output(self, tmp_path):
        data = np.zeros((10, 10, 10), dtype=np.float32)
        data[3:6, 3:6, 3:6] = 4.0
        aff = np.diag([3.0, 3.0, 3.0, 1.0])
        _save_nifti(data, tmp_path / "aniso.nii.gz", affine=aff)
        outdir = tmp_path / "out"
        explorer_run([
            "--input-file", str(tmp_path / "aniso.nii.gz"),
            "--output-dir", str(outdir),
            "--threshold", "2.3",
        ])
        thresh_img = nib.load(str(outdir / "thresholded_map.nii.gz"))
        assert np.allclose(thresh_img.affine, aff)


# ── Output files ──────────────────────────────────────────────────────────────

class TestOutputFiles:
    @pytest.fixture
    def outdir(self, tmp_path):
        data = _make_two_blob_data()
        _save_nifti(data, tmp_path / "blobs.nii.gz")
        out = tmp_path / "out"
        explorer_run([
            "--input-file", str(tmp_path / "blobs.nii.gz"),
            "--output-dir", str(out),
            "--threshold", "2.3",
            "--min-cluster-size", "5",
        ])
        return out

    def test_all_six_files_created(self, outdir):
        expected = [
            "thresholded_map.nii.gz",
            "cluster_table.csv",
            "cluster_table.json",
            "cluster_overlay.png",
            "cluster_report.html",
            "cluster_metadata.json",
        ]
        for fname in expected:
            assert (outdir / fname).exists(), f"Missing: {fname}"

    def test_thresholded_map_is_valid_nifti(self, outdir):
        img = nib.load(str(outdir / "thresholded_map.nii.gz"))
        assert img.ndim == 3

    def test_csv_has_correct_columns(self, outdir):
        with open(outdir / "cluster_table.csv") as f:
            reader = csv.DictReader(f)
            header = reader.fieldnames or []
        assert header == CLUSTER_CSV_COLUMNS

    def test_csv_has_two_rows(self, outdir):
        with open(outdir / "cluster_table.csv") as f:
            rows = list(csv.DictReader(f))
        assert len(rows) == 2

    def test_json_cluster_table_has_schema(self, outdir):
        payload = json.loads((outdir / "cluster_table.json").read_text())
        assert payload["schema"] == "neuroforge-cluster-table-v1"
        assert "clusters" in payload
        assert len(payload["clusters"]) == 2

    def test_metadata_json_has_required_fields(self, outdir):
        meta = json.loads((outdir / "cluster_metadata.json").read_text())
        for field in [
            "input_file", "threshold", "direction", "min_cluster_size",
            "n_clusters", "generated_at", "nibabel_version", "neuroforge_version",
        ]:
            assert field in meta, f"Missing metadata field: {field}"

    def test_html_report_is_valid_html(self, outdir):
        html = (outdir / "cluster_report.html").read_text()
        assert "<!DOCTYPE html>" in html
        assert "cluster" in html.lower()
        assert "No AI-generated scientific interpretation" in html

    def test_overlay_png_has_png_magic_bytes(self, outdir):
        magic = (outdir / "cluster_overlay.png").read_bytes()[:8]
        assert magic == b"\x89PNG\r\n\x1a\n"

    def test_thresholded_map_values_match_threshold(self, outdir):
        img = nib.load(str(outdir / "thresholded_map.nii.gz"))
        data = np.asarray(img.dataobj)
        nonzero = data[data != 0]
        if len(nonzero) > 0:
            assert float(nonzero.min()) >= 2.3


# ── CSV / JSON exporters ──────────────────────────────────────────────────────

class TestExporters:
    def _sample_clusters(self):
        return [
            {col: 0 for col in CLUSTER_CSV_COLUMNS},
            {col: 1 for col in CLUSTER_CSV_COLUMNS},
        ]

    def test_export_csv_creates_file(self, tmp_path):
        p = tmp_path / "t.csv"
        export_csv(self._sample_clusters(), p)
        assert p.exists()

    def test_export_csv_empty_clusters(self, tmp_path):
        p = tmp_path / "empty.csv"
        export_csv([], p)
        with open(p) as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        assert rows == []

    def test_export_cluster_json_schema(self, tmp_path):
        p = tmp_path / "t.json"
        meta = {"threshold": 2.3, "direction": "positive"}
        export_cluster_json(self._sample_clusters(), meta, p)
        payload = json.loads(p.read_text())
        assert payload["schema"] == "neuroforge-cluster-table-v1"

    def test_render_html_report_no_clusters(self, tmp_path):
        p = tmp_path / "report.html"
        meta = {
            "input_filename": "test.nii.gz",
            "generated_at": "2025-01-01T00:00:00Z",
            "threshold": 2.3,
            "direction": "positive",
            "min_cluster_size": 10,
            "colormap": "hot",
        }
        render_html_report([], meta, p)
        html = p.read_text()
        assert "No clusters detected" in html

    def test_render_cluster_overlay_no_signal(self, tmp_path):
        p = tmp_path / "overlay.png"
        data = np.zeros((10, 10, 10), dtype=np.float32)
        thresh = np.zeros_like(data)
        labeled = np.zeros_like(data, dtype=int)
        render_cluster_overlay(data, thresh, labeled, _identity_affine(), p)
        assert p.exists()
        assert p.stat().st_size > 0


# ── CLI entry-point ───────────────────────────────────────────────────────────

class TestCLI:
    def test_cli_runs_and_produces_outputs(self, tmp_path):
        data = _make_two_blob_data()
        infile = tmp_path / "blobs.nii.gz"
        _save_nifti(data, infile)
        outdir = tmp_path / "cli_out"
        result = subprocess.run(
            [
                sys.executable, "-m", "app.tools.statistical_map_explorer",
                "--input-file", str(infile),
                "--output-dir", str(outdir),
                "--threshold", "2.3",
                "--direction", "positive",
                "--min-cluster-size", "5",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        assert "cluster(s)" in result.stdout

    def test_cli_missing_input_exits_nonzero(self, tmp_path):
        result = subprocess.run(
            [
                sys.executable, "-m", "app.tools.statistical_map_explorer",
                "--input-file", str(tmp_path / "nonexistent.nii.gz"),
                "--output-dir", str(tmp_path / "out"),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0

    def test_cli_two_sided_direction(self, tmp_path):
        data = np.zeros((15, 15, 15), dtype=np.float32)
        data[2:5, 2:5, 2:5] = 4.0
        data[10:13, 10:13, 10:13] = -4.0
        infile = tmp_path / "bipolar.nii.gz"
        _save_nifti(data, infile)
        outdir = tmp_path / "out"
        result = subprocess.run(
            [
                sys.executable, "-m", "app.tools.statistical_map_explorer",
                "--input-file", str(infile),
                "--output-dir", str(outdir),
                "--threshold", "2.3",
                "--direction", "two-sided",
                "--min-cluster-size", "1",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        meta = json.loads((outdir / "cluster_metadata.json").read_text())
        assert meta["n_clusters"] == 2
