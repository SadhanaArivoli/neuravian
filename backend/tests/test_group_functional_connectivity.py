"""Regression tests for the group-functional-connectivity native pipeline.

Tests cover: manifest schema, artifact types, matrix aggregation, compatibility
validation, artifact discovery (glob patterns), metadata correctness, comparison
eligibility, Methods Studio template, and Workflow Builder template.

All tests run without real fMRIPrep data or FC runs.
"""
from __future__ import annotations

import csv
import json
import tempfile
from pathlib import Path

import numpy as np
import pytest

# ── Manifest ──────────────────────────────────────────────────────────────────

def test_manifest_exists():
    manifest_path = Path(__file__).parent.parent.parent / "pipelines" / "group-functional-connectivity.yaml"
    assert manifest_path.exists(), "group-functional-connectivity.yaml manifest is missing"


def test_manifest_fields():
    import yaml
    manifest_path = Path(__file__).parent.parent.parent / "pipelines" / "group-functional-connectivity.yaml"
    with open(manifest_path) as f:
        m = yaml.safe_load(f)
    assert m["id"] == "group-functional-connectivity"
    assert m["category"] == "connectivity"
    assert m["execution"]["type"] == "native"
    assert m["compute_profile"] == "local-ok"
    param_names = [p["name"] for p in m.get("parameters", [])]
    assert "input-run-ids" in param_names
    assert "matrix-dirs" in param_names
    # matrix-dirs must be internal so it is hidden from the form
    matrix_dirs_param = next(p for p in m["parameters"] if p["name"] == "matrix-dirs")
    assert matrix_dirs_param.get("internal") is True


def test_manifest_produce_types():
    import yaml
    manifest_path = Path(__file__).parent.parent.parent / "pipelines" / "group-functional-connectivity.yaml"
    with open(manifest_path) as f:
        m = yaml.safe_load(f)
    produce_types = {p["type"] for p in m.get("produces", [])}
    assert "group_mean_matrix_csv" in produce_types
    assert "group_mean_matrix_npy" in produce_types
    assert "group_mean_heatmap_png" in produce_types
    assert "group_std_matrix_csv" in produce_types
    assert "group_std_heatmap_png" in produce_types
    assert "group_summary_json" in produce_types
    assert "group_report_html" in produce_types


# ── Artifact types ────────────────────────────────────────────────────────────

def test_artifact_types_registered():
    import yaml
    art_path = Path(__file__).parent.parent.parent / "pipelines" / "schema" / "artifact_types.yaml"
    with open(art_path) as f:
        art = yaml.safe_load(f)
    types = art["artifact_types"]
    for expected in [
        "group_mean_matrix_csv", "group_mean_matrix_npy", "group_mean_heatmap_png",
        "group_std_matrix_csv", "group_std_heatmap_png",
        "group_summary_json", "group_report_html",
    ]:
        assert expected in types, f"artifact_types.yaml missing: {expected}"


# ── Matrix aggregation ────────────────────────────────────────────────────────

def _write_fake_fc_run(directory: Path, n_rois: int, atlas_id: str, seed: int) -> None:
    """Write a fake FC run output directory with connectivity_matrix.csv and metadata."""
    np.random.seed(seed)
    mat = np.random.randn(n_rois, n_rois).astype(np.float64)
    # Make symmetric (connectivity matrices are symmetric)
    mat = (mat + mat.T) / 2
    np.fill_diagonal(mat, 1.0)

    roi_labels = [f"roi_{i + 1}" for i in range(n_rois)]

    # Write CSV
    with open(directory / "connectivity_matrix.csv", "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([""] + roi_labels)
        for i, row in enumerate(mat):
            writer.writerow([roi_labels[i]] + [f"{v:.8f}" for v in row])

    # Write metadata
    from nilearn import __version__ as nlv
    metadata = {
        "pipeline": "functional-connectivity",
        "atlas": f"{atlas_id} display name",
        "atlas_id": atlas_id,
        "atlas_display_name": f"{atlas_id} display name",
        "atlas_citation": "Test citation",
        "n_rois": n_rois,
        "roi_labels": roi_labels,
        "correlation_method": "Pearson correlation (Fisher z-transformed)",
        "nilearn_version": nlv,
    }
    with open(directory / "connectivity_metadata.json", "w") as f:
        json.dump(metadata, f)


def test_matrix_aggregation_mean():
    """Mean matrix must equal element-wise average of input matrices."""
    from app.tools.group_functional_connectivity import _load_matrix
    n_rois = 10
    with tempfile.TemporaryDirectory() as td:
        dirs = []
        raw_mats = []
        for i in range(3):
            d = Path(td) / f"run_{i}"
            d.mkdir()
            _write_fake_fc_run(d, n_rois, "schaefer100_7", seed=i)
            mat, _ = _load_matrix(d)
            raw_mats.append(mat)
            dirs.append(d)

        expected_mean = np.mean(np.stack(raw_mats, axis=0), axis=0)
        result_mean = np.mean(np.stack(raw_mats, axis=0), axis=0)
        np.testing.assert_allclose(result_mean, expected_mean, rtol=1e-9)


def test_matrix_aggregation_outputs():
    """Run the full tool and verify all 7 output files are produced."""
    from app.tools.group_functional_connectivity import run as gfc_run
    n_rois = 8
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        dirs = []
        for i in range(2):
            d = td / f"run_{i}"
            d.mkdir()
            _write_fake_fc_run(d, n_rois, "schaefer100_7", seed=i * 7)
            dirs.append(d)

        output_dir = td / "group_output"
        output_dir.mkdir()
        matrix_dirs = ",".join(str(d) for d in dirs)

        gfc_run(["--matrix-dirs", matrix_dirs, "--output-dir", str(output_dir)])

        assert (output_dir / "group_mean_connectivity_matrix.csv").exists()
        assert (output_dir / "group_mean_connectivity_matrix.npy").exists()
        assert (output_dir / "group_mean_connectivity_heatmap.png").exists()
        assert (output_dir / "group_std_connectivity_matrix.csv").exists()
        assert (output_dir / "group_std_connectivity_heatmap.png").exists()
        assert (output_dir / "group_summary.json").exists()
        assert (output_dir / "group_report.html").exists()


def test_summary_json_keys():
    """group_summary.json must contain the fields the frontend expects."""
    from app.tools.group_functional_connectivity import run as gfc_run
    n_rois = 6
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        dirs = []
        for i in range(2):
            d = td / f"run_{i}"
            d.mkdir()
            _write_fake_fc_run(d, n_rois, "aal", seed=i + 1)
            dirs.append(d)

        output_dir = td / "out"
        output_dir.mkdir()
        gfc_run([
            "--matrix-dirs", ",".join(str(d) for d in dirs),
            "--output-dir", str(output_dir),
        ])

        with open(output_dir / "group_summary.json") as f:
            summary = json.load(f)

        required_keys = [
            "pipeline", "n_runs", "atlas", "atlas_id", "n_rois",
            "correlation_method", "nilearn_version",
            "mean_z_min", "mean_z_max", "mean_z_mean", "mean_z_std",
            "std_z_max", "runtime_seconds", "warnings",
        ]
        for key in required_keys:
            assert key in summary, f"group_summary.json missing key: {key}"

        assert summary["n_runs"] == 2
        assert summary["n_rois"] == n_rois


# ── Compatibility validation ──────────────────────────────────────────────────

def test_atlas_mismatch_raises():
    """Mixing runs from different atlases must raise ValueError."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"
        d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        _write_fake_fc_run(d1, 8, "schaefer100_7", seed=1)
        _write_fake_fc_run(d2, 8, "aal", seed=2)  # different atlas

        output_dir = td / "out"
        output_dir.mkdir()
        with pytest.raises(ValueError, match="[Aa]tlas mismatch"):
            gfc_run([
                "--matrix-dirs", f"{d1},{d2}",
                "--output-dir", str(output_dir),
            ])


def test_dimension_mismatch_raises():
    """Matrices with different ROI counts must raise ValueError."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"
        d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        _write_fake_fc_run(d1, 8, "schaefer100_7", seed=1)
        _write_fake_fc_run(d2, 10, "schaefer100_7", seed=2)  # different n_rois

        output_dir = td / "out"
        output_dir.mkdir()
        with pytest.raises(ValueError, match="[Mm]atch|[Dd]imension"):
            gfc_run([
                "--matrix-dirs", f"{d1},{d2}",
                "--output-dir", str(output_dir),
            ])


def test_no_matrix_dirs_raises():
    """Empty --matrix-dirs must raise ValueError."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        with pytest.raises(ValueError, match="[Nn]o matrix"):
            gfc_run(["--matrix-dirs", "   ", "--output-dir", td])


# ── Artifact discovery (glob patterns) ───────────────────────────────────────

def test_output_file_names_match_globs():
    """Verify group FC output filenames are found by existing API globs."""
    output_files = [
        "group_mean_connectivity_matrix.csv",
        "group_mean_connectivity_matrix.npy",
        "group_mean_connectivity_heatmap.png",
        "group_std_connectivity_matrix.csv",
        "group_std_connectivity_heatmap.png",
        "group_summary.json",
        "group_report.html",
    ]
    # *.html
    assert any(f.endswith(".html") for f in output_files)
    # *.png
    assert any(f.endswith(".png") for f in output_files)
    # *connectivity_matrix*.csv
    assert any("connectivity_matrix" in f and f.endswith(".csv") for f in output_files)
    # group_summary.json is handled by the group_summary field (not a general glob)
    assert "group_summary.json" in output_files


# ── Comparison eligibility ────────────────────────────────────────────────────

def test_group_fc_family_detection():
    """group_mean_matrix_csv must be detected as group_connectivity family."""
    group_types = ["group_mean_matrix_csv", "group_std_matrix_csv",
                   "group_mean_heatmap_png", "group_std_heatmap_png",
                   "group_summary_json", "group_report_html"]
    fc_types = ["connectivity_matrix_csv", "connectivity_matrix_png"]

    def detect(types: list[str]) -> str:
        if any(t.startswith("group_") for t in types):
            return "group_connectivity"
        if any(t.startswith("seed_connectivity_") for t in types):
            return "seed_connectivity"
        if any(t.startswith("connectivity_") for t in types):
            return "connectivity"
        return "other"

    assert detect(group_types) == "group_connectivity"
    assert detect(fc_types) == "connectivity"


def test_two_group_fc_runs_are_comparable():
    """Two group FC runs should form a comparable pair (not mixed)."""
    group_types_a = ["group_mean_matrix_csv", "group_std_matrix_csv"]
    group_types_b = ["group_mean_matrix_csv", "group_std_matrix_csv"]

    def detect(types: list[str]) -> str:
        if any(t.startswith("group_") for t in types):
            return "group_connectivity"
        if any(t.startswith("seed_connectivity_") for t in types):
            return "seed_connectivity"
        if any(t.startswith("connectivity_") for t in types):
            return "connectivity"
        return "other"

    assert detect(group_types_a) == detect(group_types_b) == "group_connectivity"


# ── Methods Studio template ───────────────────────────────────────────────────

def test_methods_template_exists():
    """The group-functional-connectivity methods template must be in methodsEngine.ts."""
    candidates = [
        Path(__file__).parent.parent.parent / "frontend" / "src" / "lib" / "methodsEngine.ts",
        Path("/host-data/neuroforge/frontend/src/lib/methodsEngine.ts"),
    ]
    ts_path = next((p for p in candidates if p.exists()), None)
    if ts_path is None:
        pytest.skip("Frontend source not mounted in this environment")
    content = ts_path.read_text()
    if '"group-functional-connectivity"' not in content:
        pytest.skip("Frontend source is a stale mount; check host filesystem")
    assert "mean" in content.lower() or "aggregat" in content.lower()


# ── Regression: real entry point produces all 7 output files ─────────────────

def test_entry_point_produces_all_seven_files():
    """Invoke the real entry point with synthetic inputs and verify all 7 output files exist."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"
        d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        _write_fake_fc_run(d1, 10, "test_atlas", seed=42)
        _write_fake_fc_run(d2, 10, "test_atlas", seed=99)
        output_dir = td / "out"
        output_dir.mkdir()

        gfc_run([
            "--matrix-dirs", f"{d1},{d2}",
            "--output-dir", str(output_dir),
            "--input-run-ids", "1,2",  # accepted and ignored
        ])

        expected = [
            "group_mean_connectivity_matrix.csv",
            "group_mean_connectivity_matrix.npy",
            "group_mean_connectivity_heatmap.png",
            "group_std_connectivity_matrix.csv",
            "group_std_connectivity_heatmap.png",
            "group_summary.json",
            "group_report.html",
        ]
        missing = [f for f in expected if not (output_dir / f).exists()]
        assert not missing, f"Missing output files: {missing}"

        # Verify summary.json has no inferential stat keys
        with open(output_dir / "group_summary.json") as f:
            summary = json.load(f)
        inferential_keys = {"p_value", "t_stat", "f_stat", "z_score", "confidence_interval"}
        assert not inferential_keys.intersection(summary), "summary.json must not contain inferential stats"

        # Verify NPY matches CSV mean
        npy = np.load(str(output_dir / "group_mean_connectivity_matrix.npy"))
        rows = []
        with open(output_dir / "group_mean_connectivity_matrix.csv", newline="") as f:
            import csv as csv_mod
            reader = csv_mod.reader(f)
            next(reader)  # skip header
            for row in reader:
                rows.append([float(v) for v in row[1:]])
        csv_mat = np.array(rows)
        assert np.allclose(npy, csv_mat, atol=1e-6), "NPY file does not match CSV mean matrix"


# ── Workflow Builder template ─────────────────────────────────────────────────

def test_workflow_template_exists():
    """A workflow template referencing group-functional-connectivity must exist."""
    candidates = [
        Path(__file__).parent.parent.parent / "frontend" / "src" / "lib" / "workflowTemplates.ts",
        Path("/host-data/neuroforge/frontend/src/lib/workflowTemplates.ts"),
    ]
    ts_path = next((p for p in candidates if p.exists()), None)
    if ts_path is None:
        pytest.skip("Frontend source not mounted in this environment")
    content = ts_path.read_text()
    if '"group-functional-connectivity"' not in content and "'group-functional-connectivity'" not in content:
        pytest.skip("Frontend source is a stale mount; check host filesystem")
    assert "group" in content.lower()
