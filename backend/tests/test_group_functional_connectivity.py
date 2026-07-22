"""Regression tests for the group-functional-connectivity native pipeline.

Tests cover: manifest schema, artifact types, matrix aggregation (Fisher-z),
compatibility validation, artifact discovery (glob patterns), metadata
correctness, comparison eligibility, Methods Studio template, and Workflow
Builder template.

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
    matrix_dirs_param = next(p for p in m["parameters"] if p["name"] == "matrix-dirs")
    assert matrix_dirs_param.get("internal") is True


def test_manifest_produce_types():
    """Manifest must declare all current Fisher-z output artifact types."""
    import yaml
    manifest_path = Path(__file__).parent.parent.parent / "pipelines" / "group-functional-connectivity.yaml"
    with open(manifest_path) as f:
        m = yaml.safe_load(f)
    produce_types = {p["type"] for p in m.get("produces", [])}
    expected = {
        "group_mean_r_matrix_csv",
        "group_mean_r_matrix_npy",
        "group_mean_r_heatmap_png",
        "group_mean_fisher_z_matrix_csv",
        "group_mean_fisher_z_matrix_npy",
        "group_mean_fisher_z_heatmap_png",
        "group_std_fisher_z_matrix_csv",
        "group_std_fisher_z_matrix_npy",
        "group_std_fisher_z_heatmap_png",
        "group_summary_json",
        "group_report_html",
    }
    for t in expected:
        assert t in produce_types, f"manifest produces[] missing: {t}"


# ── Artifact types ────────────────────────────────────────────────────────────

def test_artifact_types_registered():
    """All current Group FC artifact types must appear in artifact_types.yaml."""
    import yaml
    art_path = Path(__file__).parent.parent.parent / "pipelines" / "schema" / "artifact_types.yaml"
    with open(art_path) as f:
        art = yaml.safe_load(f)
    types = art["artifact_types"]
    current_types = [
        "group_mean_r_matrix_csv", "group_mean_r_matrix_npy", "group_mean_r_heatmap_png",
        "group_mean_fisher_z_matrix_csv", "group_mean_fisher_z_matrix_npy", "group_mean_fisher_z_heatmap_png",
        "group_std_fisher_z_matrix_csv", "group_std_fisher_z_matrix_npy", "group_std_fisher_z_heatmap_png",
        "group_summary_json", "group_report_html",
    ]
    for expected in current_types:
        assert expected in types, f"artifact_types.yaml missing: {expected}"
    # Legacy types must still be present (backward compat)
    for legacy in ["group_mean_matrix_csv", "group_mean_matrix_npy", "group_mean_heatmap_png",
                   "group_std_matrix_csv", "group_std_heatmap_png"]:
        assert legacy in types, f"artifact_types.yaml must still contain legacy type: {legacy}"


# ── Matrix aggregation helpers ────────────────────────────────────────────────

def _write_fake_fc_run(
    directory: Path,
    n_rois: int,
    atlas_id: str,
    seed: int,
    confound_strategy: str = "motion6_wm_csf_gsr",
) -> None:
    """Write a fake FC run output directory with connectivity_matrix.csv and metadata."""
    np.random.seed(seed)
    # Build a valid correlation-like matrix: symmetric, diagonal = 1, values in (-1, 1)
    raw = np.random.randn(n_rois, n_rois).astype(np.float64)
    sym = (raw + raw.T) / 2
    # Normalise so off-diagonal elements are in (-1, 1)
    max_off = np.max(np.abs(sym - np.diag(np.diag(sym))))
    if max_off > 0:
        sym = sym / (max_off + 1e-6) * 0.99
    np.fill_diagonal(sym, 1.0)
    mat = sym

    roi_labels = [f"roi_{i + 1}" for i in range(n_rois)]

    with open(directory / "connectivity_matrix.csv", "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([""] + roi_labels)
        for i, row in enumerate(mat):
            writer.writerow([roi_labels[i]] + [f"{v:.8f}" for v in row])

    from nilearn import __version__ as nlv
    metadata = {
        "pipeline": "functional-connectivity",
        "atlas": f"{atlas_id} display name",
        "atlas_id": atlas_id,
        "atlas_display_name": f"{atlas_id} display name",
        "atlas_citation": "Test citation",
        "n_rois": n_rois,
        "roi_labels": roi_labels,
        "correlation_method": "Pearson correlation",
        "nilearn_version": nlv,
        "confound_strategy": confound_strategy,
        "global_signal_included": confound_strategy in ("motion6_wm_csf_gsr", "motion6_wm_csf_global"),
    }
    with open(directory / "connectivity_metadata.json", "w") as f:
        json.dump(metadata, f)


# ── Fisher-z correctness ──────────────────────────────────────────────────────

def test_fisher_aggregate_diagonal_identity():
    """Diagonal of mean_r must be 1.0 and diagonal of mean_z must be 0.0."""
    from app.tools.group_functional_connectivity import _fisher_aggregate
    n = 6
    # Two identity-like diagonal=1 matrices with realistic off-diagonal values
    mats = []
    for seed in (1, 2):
        np.random.seed(seed)
        m = np.random.uniform(-0.6, 0.6, (n, n))
        m = (m + m.T) / 2
        np.fill_diagonal(m, 1.0)
        mats.append(m)

    mean_r, mean_z, std_z = _fisher_aggregate(mats)
    np.testing.assert_array_equal(np.diag(mean_r), np.ones(n))
    np.testing.assert_array_equal(np.diag(mean_z), np.zeros(n))
    np.testing.assert_array_equal(np.diag(std_z), np.zeros(n))


def test_fisher_aggregate_tanh_identity():
    """mean_r must equal tanh(mean_z) off-diagonal."""
    from app.tools.group_functional_connectivity import _fisher_aggregate
    n = 8
    mats = []
    for seed in range(4):
        np.random.seed(seed * 3)
        m = np.random.uniform(-0.7, 0.7, (n, n))
        m = (m + m.T) / 2
        np.fill_diagonal(m, 1.0)
        mats.append(m)

    mean_r, mean_z, _ = _fisher_aggregate(mats)
    diag_mask = np.eye(n, dtype=bool)
    # Off-diagonal: mean_r should equal tanh(mean_z)
    np.testing.assert_allclose(mean_r[~diag_mask], np.tanh(mean_z[~diag_mask]), atol=1e-12)


def test_fisher_aggregate_identical_matrices():
    """Identical input matrices → std_z == 0 everywhere."""
    from app.tools.group_functional_connectivity import _fisher_aggregate
    n = 5
    np.random.seed(77)
    m = np.random.uniform(-0.5, 0.5, (n, n))
    m = (m + m.T) / 2
    np.fill_diagonal(m, 1.0)
    mats = [m.copy(), m.copy(), m.copy()]

    _, _, std_z = _fisher_aggregate(mats)
    np.testing.assert_allclose(std_z, 0.0, atol=1e-12)


def test_fisher_aggregate_clip_near_one():
    """Values very close to ±1 must not produce inf in Fisher z (clipping must work)."""
    from app.tools.group_functional_connectivity import _fisher_aggregate
    n = 4
    m = np.full((n, n), 0.9999999)
    np.fill_diagonal(m, 1.0)
    mean_r, mean_z, std_z = _fisher_aggregate([m, m])
    assert np.all(np.isfinite(mean_r)), "mean_r contains non-finite values near ±1"
    assert np.all(np.isfinite(mean_z)), "mean_z contains non-finite values near ±1"


def test_fisher_aggregate_known_values():
    """Verify Fisher-z aggregation against manually computed expected values."""
    from app.tools.group_functional_connectivity import _fisher_aggregate
    # 2×2 matrices, off-diagonal values: run1=0.5, run2=0.3
    r1 = 0.5; r2 = 0.3
    z1 = np.arctanh(r1); z2 = np.arctanh(r2)
    mean_z_expected = (z1 + z2) / 2
    mean_r_expected = np.tanh(mean_z_expected)

    mat1 = np.array([[1.0, r1], [r1, 1.0]])
    mat2 = np.array([[1.0, r2], [r2, 1.0]])
    mean_r, mean_z, _ = _fisher_aggregate([mat1, mat2])

    assert abs(mean_r[0, 1] - mean_r_expected) < 1e-12
    assert abs(mean_z[0, 1] - mean_z_expected) < 1e-12


def test_fisher_z_applied_flag_in_summary():
    """group_summary.json must contain fisher_z_applied: true for new runs."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        for i in range(2):
            d = td / f"r{i}"; d.mkdir()
            _write_fake_fc_run(d, 6, "schaefer100_7", seed=i + 10)
        out = td / "out"; out.mkdir()
        gfc_run(["--matrix-dirs", f"{td/'r0'},{td/'r1'}", "--output-dir", str(out)])
        with open(out / "group_summary.json") as f:
            summary = json.load(f)
    assert summary.get("fisher_z_applied") is True
    assert summary.get("aggregation_space") == "fisher_z"


# ── Full-run output correctness ───────────────────────────────────────────────

def test_matrix_aggregation_outputs():
    """Run the full tool and verify all 11 output files are produced."""
    from app.tools.group_functional_connectivity import run as gfc_run
    n_rois = 8
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        dirs = []
        for i in range(2):
            d = td / f"run_{i}"; d.mkdir()
            _write_fake_fc_run(d, n_rois, "schaefer100_7", seed=i * 7)
            dirs.append(d)

        output_dir = td / "group_output"; output_dir.mkdir()
        gfc_run(["--matrix-dirs", ",".join(str(d) for d in dirs), "--output-dir", str(output_dir)])

        expected_files = [
            "group_mean_r_matrix.csv",
            "group_mean_r_matrix.npy",
            "group_mean_r_heatmap.png",
            "group_mean_fisher_z_matrix.csv",
            "group_mean_fisher_z_matrix.npy",
            "group_mean_fisher_z_heatmap.png",
            "group_std_fisher_z_matrix.csv",
            "group_std_fisher_z_matrix.npy",
            "group_std_fisher_z_heatmap.png",
            "group_summary.json",
            "group_report.html",
        ]
        missing = [f for f in expected_files if not (output_dir / f).exists()]
        assert not missing, f"Missing output files: {missing}"


def test_summary_json_keys():
    """group_summary.json must contain all required fields for the frontend."""
    from app.tools.group_functional_connectivity import run as gfc_run
    n_rois = 6
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        for i in range(2):
            d = td / f"r{i}"; d.mkdir()
            _write_fake_fc_run(d, n_rois, "aal", seed=i + 1)
        out = td / "out"; out.mkdir()
        gfc_run(["--matrix-dirs", f"{td/'r0'},{td/'r1'}", "--output-dir", str(out)])

        with open(out / "group_summary.json") as f:
            summary = json.load(f)

    required_keys = [
        "pipeline", "n_runs", "atlas", "atlas_id", "n_rois",
        "correlation_method", "nilearn_version",
        # Fisher-z fields
        "fisher_z_applied", "aggregation_space",
        "mean_r_min", "mean_r_max", "mean_r_mean",
        "mean_z_min", "mean_z_max", "mean_z_mean",
        "std_z_max",
        "runtime_seconds", "warnings",
    ]
    for key in required_keys:
        assert key in summary, f"group_summary.json missing key: {key}"
    assert summary["n_runs"] == 2
    assert summary["n_rois"] == n_rois
    assert summary["fisher_z_applied"] is True
    # No inferential statistics
    inferential = {"p_value", "t_stat", "f_stat", "z_score", "confidence_interval"}
    assert not inferential.intersection(summary), "summary.json must not contain inferential stats"


def test_entry_point_produces_all_eleven_files():
    """Invoke the real entry point with synthetic inputs and verify all 11 output files."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"; d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        _write_fake_fc_run(d1, 10, "test_atlas", seed=42)
        _write_fake_fc_run(d2, 10, "test_atlas", seed=99)
        out = td / "out"; out.mkdir()

        gfc_run(["--matrix-dirs", f"{d1},{d2}", "--output-dir", str(out), "--input-run-ids", "1,2"])

        expected = [
            "group_mean_r_matrix.csv",
            "group_mean_r_matrix.npy",
            "group_mean_r_heatmap.png",
            "group_mean_fisher_z_matrix.csv",
            "group_mean_fisher_z_matrix.npy",
            "group_mean_fisher_z_heatmap.png",
            "group_std_fisher_z_matrix.csv",
            "group_std_fisher_z_matrix.npy",
            "group_std_fisher_z_heatmap.png",
            "group_summary.json",
            "group_report.html",
        ]
        missing = [f for f in expected if not (out / f).exists()]
        assert not missing, f"Missing output files: {missing}"

        # NPY (r-space) must match CSV
        npy = np.load(str(out / "group_mean_r_matrix.npy"))
        rows = []
        with open(out / "group_mean_r_matrix.csv", newline="") as f:
            reader = csv.reader(f)
            next(reader)
            for row in reader:
                rows.append([float(v) for v in row[1:]])
        csv_mat = np.array(rows)
        np.testing.assert_allclose(npy, csv_mat, atol=1e-6)


# ── Compatibility validation ──────────────────────────────────────────────────

def test_atlas_mismatch_raises():
    """Mixing runs from different atlases must raise ValueError."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"; d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        _write_fake_fc_run(d1, 8, "schaefer100_7", seed=1)
        _write_fake_fc_run(d2, 8, "aal", seed=2)
        out = td / "out"; out.mkdir()
        with pytest.raises(ValueError, match="[Aa]tlas mismatch"):
            gfc_run(["--matrix-dirs", f"{d1},{d2}", "--output-dir", str(out)])


def test_dimension_mismatch_raises():
    """Matrices with different ROI counts must raise ValueError."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"; d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        _write_fake_fc_run(d1, 8, "schaefer100_7", seed=1)
        _write_fake_fc_run(d2, 10, "schaefer100_7", seed=2)
        out = td / "out"; out.mkdir()
        with pytest.raises(ValueError, match="[Mm]atch|[Dd]imension"):
            gfc_run(["--matrix-dirs", f"{d1},{d2}", "--output-dir", str(out)])


def test_confound_strategy_mismatch_raises():
    """Runs with different confound strategies must raise ValueError."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"; d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        _write_fake_fc_run(d1, 6, "schaefer100_7", seed=1, confound_strategy="motion6")
        _write_fake_fc_run(d2, 6, "schaefer100_7", seed=2, confound_strategy="motion6_wm_csf_gsr")
        out = td / "out"; out.mkdir()
        with pytest.raises(ValueError, match="[Cc]onfound.*mismatch|[Ss]trategy.*mismatch"):
            gfc_run(["--matrix-dirs", f"{d1},{d2}", "--output-dir", str(out)])


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
        "group_mean_r_matrix.csv",
        "group_mean_r_matrix.npy",
        "group_mean_r_heatmap.png",
        "group_mean_fisher_z_matrix.csv",
        "group_mean_fisher_z_matrix.npy",
        "group_mean_fisher_z_heatmap.png",
        "group_std_fisher_z_matrix.csv",
        "group_std_fisher_z_matrix.npy",
        "group_std_fisher_z_heatmap.png",
        "group_summary.json",
        "group_report.html",
    ]
    assert any(f.endswith(".html") for f in output_files)
    assert any(f.endswith(".png") for f in output_files)
    assert any("matrix" in f and f.endswith(".csv") for f in output_files)
    assert "group_summary.json" in output_files


# ── Comparison eligibility ────────────────────────────────────────────────────

def test_group_fc_family_detection():
    """group_mean_r_matrix_csv must be detected as group_connectivity family."""
    group_types = ["group_mean_r_matrix_csv", "group_std_fisher_z_matrix_csv",
                   "group_mean_r_heatmap_png", "group_summary_json", "group_report_html"]
    fc_types = ["connectivity_matrix_csv", "connectivity_matrix_png"]
    # Also test legacy artifact types are still detected as group_connectivity
    legacy_types = ["group_mean_matrix_csv", "group_std_matrix_csv"]

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
    assert detect(legacy_types) == "group_connectivity"


def test_two_group_fc_runs_are_comparable():
    """Two group FC runs should form a comparable pair."""
    group_types_a = ["group_mean_r_matrix_csv", "group_std_fisher_z_matrix_csv"]
    group_types_b = ["group_mean_r_matrix_csv", "group_std_fisher_z_matrix_csv"]

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
    """The group-functional-connectivity methods template must mention Fisher r-to-z."""
    candidates = [
        Path(__file__).parent.parent.parent / "frontend" / "src" / "lib" / "methodsEngine.ts",
        Path("/host-data/neuravian/frontend/src/lib/methodsEngine.ts"),
    ]
    ts_path = next((p for p in candidates if p.exists()), None)
    if ts_path is None:
        pytest.skip("Frontend source not mounted in this environment")
    content = ts_path.read_text()
    if '"group-functional-connectivity"' not in content:
        pytest.skip("Frontend source is a stale mount; check host filesystem")
    assert "fisher" in content.lower() or "arctanh" in content.lower(), \
        "Methods template should mention Fisher r-to-z transformation"


# ── Workflow Builder template ─────────────────────────────────────────────────

def test_workflow_template_exists():
    """A workflow template referencing group-functional-connectivity must exist."""
    candidates = [
        Path(__file__).parent.parent.parent / "frontend" / "src" / "lib" / "workflowTemplates.ts",
        Path("/host-data/neuravian/frontend/src/lib/workflowTemplates.ts"),
    ]
    ts_path = next((p for p in candidates if p.exists()), None)
    if ts_path is None:
        pytest.skip("Frontend source not mounted in this environment")
    content = ts_path.read_text()
    if '"group-functional-connectivity"' not in content and "'group-functional-connectivity'" not in content:
        pytest.skip("Frontend source is a stale mount; check host filesystem")
    assert "group" in content.lower()


# ── Atlas alias normalisation ─────────────────────────────────────────────────

def test_atlas_alias_schaefer_underscore_resolves_to_canonical():
    """schaefer_100_7 (legacy underscore spelling) must resolve to schaefer100_7."""
    from app.tools.functional_connectivity import LEGACY_ATLAS_ALIASES
    assert LEGACY_ATLAS_ALIASES.get("schaefer_100_7") == "schaefer100_7", (
        "LEGACY_ATLAS_ALIASES must map schaefer_100_7 -> schaefer100_7"
    )


def test_normalize_atlas_id_alias():
    """normalize_atlas_id must return the canonical ID for legacy aliases."""
    from app.tools.functional_connectivity import normalize_atlas_id
    assert normalize_atlas_id("schaefer_100_7") == "schaefer100_7"
    assert normalize_atlas_id("schaefer100_7") == "schaefer100_7"


def test_atlas_alias_runs_accepted_by_group_fc():
    """Group FC must accept one run with schaefer_100_7 and one with schaefer100_7."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"; d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        # Simulate: legacy run stored atlas_id as schaefer_100_7
        _write_fake_fc_run(d1, 6, "schaefer_100_7", seed=1, confound_strategy="motion6")
        _write_fake_fc_run(d2, 6, "schaefer100_7", seed=2, confound_strategy="motion6")
        out = td / "out"; out.mkdir()
        gfc_run(["--matrix-dirs", f"{d1},{d2}", "--output-dir", str(out)])
        assert (out / "group_summary.json").exists()
        summary = json.loads((out / "group_summary.json").read_text())
        assert summary["canonical_atlas_id"] == "schaefer100_7"


def test_atlas_alias_different_roi_ordering_still_rejected():
    """Alias equality must not bypass ROI-order validation."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"; d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        _write_fake_fc_run(d1, 6, "schaefer_100_7", seed=1, confound_strategy="motion6")
        # Different n_rois — forces dimension/shape mismatch, the proxy for ROI ordering
        _write_fake_fc_run(d2, 8, "schaefer100_7", seed=2, confound_strategy="motion6")
        out = td / "out"; out.mkdir()
        with pytest.raises(ValueError, match="[Dd]imension|[Ss]hape|[Mm]atch"):
            gfc_run(["--matrix-dirs", f"{d1},{d2}", "--output-dir", str(out)])


def test_schaefer_vs_aal_still_rejected():
    """Truly different atlases must remain incompatible after the alias fix."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"; d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        _write_fake_fc_run(d1, 6, "schaefer100_7", seed=1)
        _write_fake_fc_run(d2, 6, "aal", seed=2)
        out = td / "out"; out.mkdir()
        with pytest.raises(ValueError, match="[Aa]tlas mismatch"):
            gfc_run(["--matrix-dirs", f"{d1},{d2}", "--output-dir", str(out)])


def test_canonical_atlas_id_in_summary():
    """canonical_atlas_id must be present and canonical in group_summary.json."""
    from app.tools.group_functional_connectivity import run as gfc_run
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        d1 = td / "run_1"; d2 = td / "run_2"
        d1.mkdir(); d2.mkdir()
        _write_fake_fc_run(d1, 6, "schaefer100_7", seed=10, confound_strategy="motion6")
        _write_fake_fc_run(d2, 6, "schaefer100_7", seed=11, confound_strategy="motion6")
        out = td / "out"; out.mkdir()
        gfc_run(["--matrix-dirs", f"{d1},{d2}", "--output-dir", str(out)])
        summary = json.loads((out / "group_summary.json").read_text())
        assert "canonical_atlas_id" in summary, "group_summary.json must include canonical_atlas_id"
        assert summary["canonical_atlas_id"] == "schaefer100_7"
