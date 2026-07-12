"""Tests for Regional Homogeneity (ReHo) — KCC computation and end-to-end pipeline."""
import argparse
import json
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

from app.services.artifact_registry import resolve_run_artifacts
from app.services.pipeline import get_registry
from app.tools.regional_homogeneity import (
    _neighborhood_kernel,
    compute_reho,
    run,
)


# ── Unit: neighborhood kernels ─────────────────────────────────────────────────

def test_kernel_sizes():
    assert int(_neighborhood_kernel(7).sum()) == 7
    assert int(_neighborhood_kernel(19).sum()) == 19
    assert int(_neighborhood_kernel(27).sum()) == 27


def test_kernel_7_is_face_adjacent():
    k = _neighborhood_kernel(7)
    # Center must be 1; each of the 6 face neighbors must be 1; corners must be 0
    assert k[1, 1, 1] == 1.0
    assert k[0, 0, 0] == 0.0  # corner
    assert k[0, 1, 1] == 1.0  # face


def test_kernel_19_excludes_corners():
    k = _neighborhood_kernel(19)
    assert k[0, 0, 0] == 0.0  # corner excluded
    assert k[0, 1, 0] == 1.0  # edge included


# ── Unit: KCC formula ─────────────────────────────────────────────────────────

def test_kcc_perfect_agreement():
    """7×7×7 volume where all voxels share the same timeseries → W should be 1."""
    T = 50
    ts = np.tile(np.random.randn(T).astype(np.float32), (7, 7, 7, 1))
    data = ts
    mask = np.ones((7, 7, 7), dtype=bool)
    reho_map, valid_mask = compute_reho(data, mask, neighborhood=7)
    # Interior voxels (2:5, 2:5, 2:5) have complete 7-voxel neighborhoods
    interior = reho_map[2:5, 2:5, 2:5]
    assert interior.min() >= 0.0
    assert interior.max() <= 1.001
    assert interior.mean() > 0.95, "Perfect timeseries should yield KCC close to 1"


def test_kcc_range():
    """KCC values must be in [0, 1]."""
    rng = np.random.default_rng(42)
    data = rng.standard_normal((9, 9, 9, 60)).astype(np.float32)
    mask = np.ones((9, 9, 9), dtype=bool)
    reho_map, valid_mask = compute_reho(data, mask, neighborhood=27)
    vals = reho_map[valid_mask]
    assert vals.min() >= 0.0
    assert vals.max() <= 1.0 + 1e-6


def test_kcc_independent_recomputation():
    """Verify KCC formula manually for a single voxel against the vectorized result."""
    rng = np.random.default_rng(7)
    T = 40
    K = 7
    # 5×5×5 uniform random volume; pick center voxel for verification
    data = rng.standard_normal((5, 5, 5, T)).astype(np.float32)
    mask = np.ones((5, 5, 5), dtype=bool)
    reho_map, _ = compute_reho(data, mask, neighborhood=7)

    # Manual KCC for center voxel (2,2,2) and its 6 face neighbors
    cx, cy, cz = 2, 2, 2
    offsets = [(0,0,0),(1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)]
    from scipy.stats import rankdata
    rank_sums = np.zeros(T, dtype=np.float64)
    for dx, dy, dz in offsets:
        ts = data[cx+dx, cy+dy, cz+dz, :].astype(np.float64)
        rank_sums += rankdata(ts, method="average")
    mean_rs = rank_sums.mean()
    S = float(((rank_sums - mean_rs) ** 2).sum())
    W_manual = 12.0 * S / (K**2 * (T**3 - T))

    assert reho_map[cx, cy, cz] == pytest.approx(W_manual, abs=1e-5), \
        f"Vectorized KCC {reho_map[cx,cy,cz]:.6f} != manual {W_manual:.6f}"


# ── Fixture helpers ────────────────────────────────────────────────────────────

def _make_fixture(root: Path, n_timepoints: int = 50, tr: float = 2.0) -> Path:
    """Create a minimal fMRIPrep-style fixture with 5×5×5 volume."""
    func = root / "sub-01" / "func"
    func.mkdir(parents=True)
    shape = (5, 5, 5, n_timepoints)
    rng = np.random.default_rng(99)
    data = rng.standard_normal(shape).astype(np.float32)
    affine = np.diag([2.0, 2.0, 2.0, 1.0])
    bold = func / "sub-01_task-rest_space-MNI_desc-preproc_bold.nii.gz"
    img = nib.Nifti1Image(data, affine)
    img.header.set_zooms((2.0, 2.0, 2.0, tr))
    nib.save(img, bold)
    # Brain mask: all-ones interior (leave 1-voxel border out for 27-neighborhood tests)
    mask_data = np.zeros(shape[:3], dtype=np.uint8)
    mask_data[1:4, 1:4, 1:4] = 1
    nib.save(nib.Nifti1Image(mask_data, affine),
             func / "sub-01_task-rest_space-MNI_desc-brain_mask.nii.gz")
    return bold


# ── End-to-end: run() ─────────────────────────────────────────────────────────

def _default_args(fmriprep_dir: str, output_dir: str, **kwargs) -> argparse.Namespace:
    defaults = dict(
        fmriprep_dir=fmriprep_dir, output_dir=output_dir,
        neighborhood=27, tr=None, confound_strategy="none",
        detrend=True, z_normalize=False,
        subject_label=None, task_label=None, run_label=None,
        source_run_id=None,
    )
    defaults.update(kwargs)
    return argparse.Namespace(**defaults)


def test_end_to_end_outputs_and_metadata(tmp_path: Path):
    root = tmp_path / "fmriprep"
    _make_fixture(root)
    out = tmp_path / "out"
    meta = run(_default_args(str(root), str(out), source_run_id=7))

    # Metadata correctness
    assert meta["source_run_id"] == 7
    assert meta["neighborhood"] == 27
    assert meta["neighborhood_voxels"] == 27
    assert "Zang" in meta["citations"][0]
    assert 0 <= meta["reho_statistics"]["mean"] <= 1

    # Output files exist and are non-empty
    for fname in ["reho_map.nii.gz", "reho_histogram.png",
                  "reho_metadata.json", "reho_report.html"]:
        assert (out / fname).stat().st_size > 0, f"{fname} missing or empty"

    # NIfTI integrity
    img = nib.load(out / "reho_map.nii.gz")
    assert img.shape == (5, 5, 5)
    data = img.get_fdata()
    assert np.isfinite(data).all()
    assert data.min() >= 0.0
    assert data.max() <= 1.0 + 1e-5

    # Normalized map absent when z_normalize=False
    assert not (out / "reho_normalized_map.nii.gz").exists()


def test_z_normalize_produces_extra_map(tmp_path: Path):
    root = tmp_path / "fmriprep"
    _make_fixture(root)
    out = tmp_path / "out"
    run(_default_args(str(root), str(out), z_normalize=True))
    assert (out / "reho_normalized_map.nii.gz").stat().st_size > 0


def test_neighborhood_7_and_19_run_cleanly(tmp_path: Path):
    root = tmp_path / "fmriprep"
    _make_fixture(root)
    for n in [7, 19]:
        out = tmp_path / f"out_{n}"
        meta = run(_default_args(str(root), str(out), neighborhood=n))
        assert meta["neighborhood"] == n
        assert (out / "reho_map.nii.gz").exists()


def test_rejects_3d_input(tmp_path: Path):
    root = tmp_path / "fmriprep"
    func = root / "sub-01" / "func"
    func.mkdir(parents=True)
    nib.save(nib.Nifti1Image(np.zeros((5, 5, 5)), np.eye(4)),
             func / "sub-01_desc-preproc_bold.nii.gz")
    with pytest.raises(ValueError, match="not 4D"):
        run(_default_args(str(root), str(tmp_path / "out"), tr=2.0))


def test_rejects_too_few_timepoints(tmp_path: Path):
    root = tmp_path / "fmriprep"
    func = root / "sub-01" / "func"
    func.mkdir(parents=True)
    nib.save(nib.Nifti1Image(np.zeros((5, 5, 5, 10)), np.eye(4)),
             func / "sub-01_desc-preproc_bold.nii.gz")
    with pytest.raises(ValueError, match="timepoints"):
        run(_default_args(str(root), str(tmp_path / "out"), tr=2.0))


# ── Artifact registry ─────────────────────────────────────────────────────────

def test_artifact_registry_resolves_reho_types(tmp_path: Path):
    root = tmp_path / "fmriprep"
    _make_fixture(root)
    out = tmp_path / "out"
    run(_default_args(str(root), str(out)))
    manifest = get_registry()["regional-homogeneity"]
    artifacts = resolve_run_artifacts(manifest, str(out), {}, "success")
    resolved = {a.type: a.resolved for a in artifacts}
    assert resolved.get("reho_map_nii") is True
    assert resolved.get("reho_histogram_png") is True
    assert resolved.get("reho_metadata_json") is True
    assert resolved.get("reho_report_html") is True


# ── JSON validity of metadata ─────────────────────────────────────────────────

def test_metadata_json_is_valid(tmp_path: Path):
    root = tmp_path / "fmriprep"
    _make_fixture(root)
    out = tmp_path / "out"
    run(_default_args(str(root), str(out)))
    data = json.loads((out / "reho_metadata.json").read_text())
    assert data["neighborhood"] == 27
    assert "runtime_seconds" in data
    assert isinstance(data["warnings"], list)
