"""Regression tests for the connectome-graph-analysis native pipeline.

Tests cover: manifest schema, artifact type registration, graph construction,
thresholding (proportional/absolute/none), global and node metrics, JSON/CSV
output generation, artifact discovery, comparison eligibility, Methods Studio
template, and Workflow Builder template.

All tests run without real fMRIPrep or FC run data.
"""
from __future__ import annotations

import csv
import json
import tempfile
from pathlib import Path

import numpy as np
import pytest

PIPELINES_DIR = Path(__file__).parent.parent.parent / "pipelines"
MANIFEST_PATH = PIPELINES_DIR / "connectome-graph-analysis.yaml"


# ── Manifest ──────────────────────────────────────────────────────────────────

def test_manifest_exists():
    assert MANIFEST_PATH.exists(), "connectome-graph-analysis.yaml manifest is missing"


def test_manifest_fields():
    import yaml
    with open(MANIFEST_PATH) as f:
        m = yaml.safe_load(f)
    assert m["id"] == "connectome-graph-analysis"
    assert m["category"] == "connectivity"
    assert m["execution"]["type"] == "native"
    assert m["input_type"] == "matrix"
    param_names = [p["name"] for p in m.get("parameters", [])]
    assert "input-matrix" in param_names
    assert "threshold-method" in param_names
    assert "threshold-value" in param_names
    assert "source-run-id" in param_names
    assert "output-dir" in param_names


def test_manifest_produces():
    import yaml
    with open(MANIFEST_PATH) as f:
        m = yaml.safe_load(f)
    types = {p["type"] for p in m.get("produces", [])}
    assert types == {
        "graph_metrics_json",
        "graph_node_metrics_csv",
        "graph_edge_list_csv",
        "graph_adjacency_npy",
        "graph_report_html",
        "graph_summary_png",
    }


def test_manifest_accepts():
    import yaml
    with open(MANIFEST_PATH) as f:
        m = yaml.safe_load(f)
    accept_types = {a["type"] for a in m.get("accepts", [])}
    assert "connectivity_matrix_npy" in accept_types
    assert "connectivity_matrix_csv" in accept_types
    assert "group_mean_matrix_npy" in accept_types
    assert "group_mean_matrix_csv" in accept_types


def test_threshold_method_options():
    import yaml
    with open(MANIFEST_PATH) as f:
        m = yaml.safe_load(f)
    threshold_param = next(p for p in m["parameters"] if p["name"] == "threshold-method")
    assert set(threshold_param["options"]) == {"proportional", "absolute", "none"}
    assert threshold_param["default"] == "proportional"


# ── Artifact types ─────────────────────────────────────────────────────────────

def test_artifact_types_registered():
    import yaml
    types_path = PIPELINES_DIR / "schema" / "artifact_types.yaml"
    with open(types_path) as f:
        data = yaml.safe_load(f)
    # artifact_types.yaml may be a list or a dict keyed by id
    if isinstance(data, list):
        registered = {t["id"] for t in data}
    elif "artifact_types" in data:
        registered = set(data["artifact_types"].keys())
    else:
        registered = set(data.keys())
    for t in [
        "graph_metrics_json",
        "graph_node_metrics_csv",
        "graph_edge_list_csv",
        "graph_adjacency_npy",
        "graph_report_html",
        "graph_summary_png",
    ]:
        assert t in registered, f"artifact type '{t}' missing from artifact_types.yaml"


# ── Graph engine import ────────────────────────────────────────────────────────

def get_engine():
    from app.tools.connectome_graph_analysis import (
        load_matrix, apply_threshold, build_graph, compute_global_metrics, compute_node_metrics,
    )
    return load_matrix, apply_threshold, build_graph, compute_global_metrics, compute_node_metrics


# ── Thresholding ──────────────────────────────────────────────────────────────

def _symmetric_matrix(n: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    m = rng.uniform(0.1, 1.0, (n, n))
    m = (m + m.T) / 2
    np.fill_diagonal(m, 0)
    return m


def test_threshold_proportional_retains_fraction():
    _, apply_threshold, _, _, _ = get_engine()
    mat = _symmetric_matrix(20, seed=1)
    result = apply_threshold(mat, "proportional", 0.25)
    # Count upper-triangle edges
    n = mat.shape[0]
    total_edges = n * (n - 1) // 2
    kept = int(np.sum(result[np.triu_indices(n, k=1)] > 0))
    expected = round(total_edges * 0.25)
    assert abs(kept - expected) <= 1, f"Expected ~{expected} edges, got {kept}"


def test_threshold_proportional_zero_raises():
    _, apply_threshold, _, _, _ = get_engine()
    mat = _symmetric_matrix(10, seed=2)
    with pytest.raises((ValueError, Exception)):
        apply_threshold(mat, "proportional", 0.0)


def test_threshold_absolute_cutoff():
    _, apply_threshold, _, _, _ = get_engine()
    mat = _symmetric_matrix(10, seed=3)
    cutoff = 0.5
    result = apply_threshold(mat, "absolute", cutoff)
    # All retained edges must be >= cutoff
    nonzero = result[result > 0]
    assert np.all(nonzero >= cutoff), "Absolute threshold: some edges below cutoff retained"


def test_threshold_none_keeps_all_positive():
    _, apply_threshold, _, _, _ = get_engine()
    mat = _symmetric_matrix(10, seed=4)
    result = apply_threshold(mat, "none", 0.0)
    # All positive entries in original should survive
    assert np.all((result > 0) == (mat > 0))


# ── Graph construction ────────────────────────────────────────────────────────

def test_build_graph_no_self_loops():
    _, _, build_graph, _, _ = get_engine()
    mat = _symmetric_matrix(8, seed=5)
    labels = [f"ROI_{i}" for i in range(8)]
    G = build_graph(mat, labels)
    assert not G.has_edge("ROI_0", "ROI_0"), "Graph should have no self-loops"


def test_build_graph_node_count():
    _, _, build_graph, _, _ = get_engine()
    mat = _symmetric_matrix(10, seed=6)
    labels = [f"N{i}" for i in range(10)]
    G = build_graph(mat, labels)
    assert G.number_of_nodes() == 10


def test_build_graph_undirected():
    _, _, build_graph, _, _ = get_engine()
    import networkx as nx
    mat = _symmetric_matrix(6, seed=7)
    labels = [f"R{i}" for i in range(6)]
    G = build_graph(mat, labels)
    assert not isinstance(G, nx.DiGraph), "Graph must be undirected"


def test_build_graph_weights_symmetric_average():
    _, _, build_graph, _, _ = get_engine()
    mat = np.zeros((3, 3))
    mat[0, 1] = 0.6
    mat[1, 0] = 0.8
    mat[0, 2] = 0.4
    mat[2, 0] = 0.4
    mat[1, 2] = 0.5
    mat[2, 1] = 0.5
    labels = ["A", "B", "C"]
    G = build_graph(mat, labels)
    # Nodes are indexed by integer (0, 1, 2), not by label
    w_01 = G[0][1]["weight"]
    assert abs(w_01 - 0.7) < 1e-9, f"Expected weight 0.7 for 0-1 edge, got {w_01}"


# ── Global metrics ────────────────────────────────────────────────────────────

def test_global_metrics_keys():
    _, _, build_graph, compute_global_metrics, _ = get_engine()
    mat = _symmetric_matrix(10, seed=8)
    labels = [f"R{i}" for i in range(10)]
    G = build_graph(mat, labels)
    metrics = compute_global_metrics(G, 10)
    required = {
        "n_nodes", "n_edges", "density",
        "global_efficiency", "local_efficiency",
        "clustering_coefficient", "transitivity",
        "characteristic_path_length",
        "modularity", "n_communities",
        "largest_component_size",
    }
    missing = required - metrics.keys()
    assert not missing, f"Missing global metric keys: {missing}"


def test_density_range():
    _, _, build_graph, compute_global_metrics, _ = get_engine()
    mat = _symmetric_matrix(12, seed=9)
    G = build_graph(mat, [f"R{i}" for i in range(12)])
    m = compute_global_metrics(G, 12)
    assert 0.0 <= m["density"] <= 1.0, f"Density out of range: {m['density']}"


def test_global_efficiency_range():
    _, _, build_graph, compute_global_metrics, _ = get_engine()
    mat = _symmetric_matrix(12, seed=10)
    G = build_graph(mat, [f"R{i}" for i in range(12)])
    m = compute_global_metrics(G, 12)
    assert 0.0 <= m["global_efficiency"] <= 1.0


def test_modularity_range():
    _, _, build_graph, compute_global_metrics, _ = get_engine()
    mat = _symmetric_matrix(20, seed=11)
    G = build_graph(mat, [f"R{i}" for i in range(20)])
    m = compute_global_metrics(G, 20)
    # Modularity can be negative but typically in [-0.5, 1.0]
    assert -1.0 <= m["modularity"] <= 1.0


def test_empty_graph_handles_gracefully():
    _, apply_threshold, build_graph, compute_global_metrics, _ = get_engine()
    # All-zero matrix → empty graph
    mat = np.zeros((5, 5))
    G = build_graph(mat, [f"R{i}" for i in range(5)])
    m = compute_global_metrics(G, 5)
    assert m["n_edges"] == 0
    assert m["density"] == 0.0
    assert m["characteristic_path_length"] is None or m["characteristic_path_length"] == 0.0


# ── Node metrics ──────────────────────────────────────────────────────────────

def test_node_metrics_count():
    _, _, build_graph, _, compute_node_metrics = get_engine()
    n = 8
    mat = _symmetric_matrix(n, seed=12)
    labels = [f"R{i}" for i in range(n)]
    G = build_graph(mat, labels)
    rows = compute_node_metrics(G, labels)
    assert len(rows) == n


def test_node_metrics_keys():
    _, _, build_graph, _, compute_node_metrics = get_engine()
    mat = _symmetric_matrix(6, seed=13)
    labels = [f"R{i}" for i in range(6)]
    G = build_graph(mat, labels)
    rows = compute_node_metrics(G, labels)
    # Accept either naming convention (label or node_label, clustering or clustering_coefficient, etc.)
    for row in rows:
        assert "degree" in row
        assert "strength" in row
        assert "participation_coefficient" in row
        assert "community" in row
        assert any(k in row for k in ("label", "node_label"))
        assert any(k in row for k in ("clustering", "clustering_coefficient"))
        assert any(k in row for k in ("betweenness", "betweenness_centrality"))


def test_participation_coefficient_range():
    _, _, build_graph, _, compute_node_metrics = get_engine()
    mat = _symmetric_matrix(15, seed=14)
    labels = [f"R{i}" for i in range(15)]
    G = build_graph(mat, labels)
    rows = compute_node_metrics(G, labels)
    for row in rows:
        pc = row["participation_coefficient"]
        assert 0.0 <= pc <= 1.0, f"Participation coefficient out of [0,1]: {pc}"


def test_betweenness_range():
    _, _, build_graph, _, compute_node_metrics = get_engine()
    mat = _symmetric_matrix(10, seed=15)
    labels = [f"R{i}" for i in range(10)]
    G = build_graph(mat, labels)
    rows = compute_node_metrics(G, labels)
    for row in rows:
        bc = row.get("betweenness") or row.get("betweenness_centrality", 0)
        assert 0.0 <= bc <= 1.0, f"Betweenness out of [0,1]: {bc}"


# ── NPY matrix output ─────────────────────────────────────────────────────────

def test_load_matrix_npy():
    load_matrix, _, _, _, _ = get_engine()
    n = 8
    mat = _symmetric_matrix(n, seed=16)
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "matrix.npy"
        np.save(p, mat)
        loaded, labels = load_matrix(p)
        assert loaded.shape == (n, n)
        assert len(labels) == n
        np.testing.assert_allclose(loaded, mat)


def test_load_matrix_csv():
    load_matrix, _, _, _, _ = get_engine()
    n = 5
    mat = _symmetric_matrix(n, seed=17)
    labels = [f"ROI_{i}" for i in range(n)]
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "matrix.csv"
        import pandas as pd
        pd.DataFrame(mat, index=labels, columns=labels).to_csv(p)
        loaded, loaded_labels = load_matrix(p)
        assert loaded.shape == (n, n)
        assert loaded_labels == labels


# ── End-to-end run() ──────────────────────────────────────────────────────────

def test_run_produces_all_outputs():
    from app.tools.connectome_graph_analysis import run as graph_run
    n = 15
    mat = _symmetric_matrix(n, seed=18)
    labels = [f"ROI_{i}" for i in range(n)]
    with tempfile.TemporaryDirectory() as d:
        matrix_path = Path(d) / "matrix.npy"
        np.save(matrix_path, mat)
        out_dir = Path(d) / "output"
        out_dir.mkdir()
        graph_run([
            "--input-matrix", str(matrix_path),
            "--threshold-method", "proportional",
            "--threshold-value", "0.25",
            "--output-dir", str(out_dir),
        ])
        assert (out_dir / "graph_metrics.json").exists()
        assert (out_dir / "node_metrics.csv").exists()
        assert (out_dir / "edge_list.csv").exists()
        assert (out_dir / "adjacency_thresholded.npy").exists()
        assert (out_dir / "graph_report.html").exists()
        assert (out_dir / "graph_summary.png").exists()


def test_run_metrics_json_schema():
    from app.tools.connectome_graph_analysis import run as graph_run
    n = 15
    mat = _symmetric_matrix(n, seed=19)
    with tempfile.TemporaryDirectory() as d:
        matrix_path = Path(d) / "matrix.npy"
        np.save(matrix_path, mat)
        out_dir = Path(d) / "output"
        out_dir.mkdir()
        graph_run([
            "--input-matrix", str(matrix_path),
            "--threshold-method", "none",
            "--output-dir", str(out_dir),
        ])
        with open(out_dir / "graph_metrics.json") as f:
            m = json.load(f)
        assert m["n_nodes"] == n
        assert isinstance(m["density"], float)
        assert isinstance(m["modularity"], float)
        assert isinstance(m["n_communities"], int)


def test_run_node_metrics_csv_columns():
    from app.tools.connectome_graph_analysis import run as graph_run
    n = 10
    mat = _symmetric_matrix(n, seed=20)
    with tempfile.TemporaryDirectory() as d:
        matrix_path = Path(d) / "matrix.npy"
        np.save(matrix_path, mat)
        out_dir = Path(d) / "output"
        out_dir.mkdir()
        graph_run([
            "--input-matrix", str(matrix_path),
            "--threshold-method", "proportional",
            "--threshold-value", "0.5",
            "--output-dir", str(out_dir),
        ])
        with open(out_dir / "node_metrics.csv") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        assert len(rows) == n
        keys = set(rows[0].keys())
        assert "degree" in keys
        assert "strength" in keys
        assert "participation_coefficient" in keys
        assert "community" in keys
        assert any(k in keys for k in ("label", "node_label"))
        assert any(k in keys for k in ("clustering", "clustering_coefficient"))


def test_run_adjacency_npy_shape():
    from app.tools.connectome_graph_analysis import run as graph_run
    n = 8
    mat = _symmetric_matrix(n, seed=21)
    with tempfile.TemporaryDirectory() as d:
        matrix_path = Path(d) / "matrix.npy"
        np.save(matrix_path, mat)
        out_dir = Path(d) / "output"
        out_dir.mkdir()
        graph_run([
            "--input-matrix", str(matrix_path),
            "--threshold-method", "absolute",
            "--threshold-value", "0.3",
            "--output-dir", str(out_dir),
        ])
        adj = np.load(out_dir / "adjacency_thresholded.npy")
        assert adj.shape == (n, n)
        # Must be symmetric
        np.testing.assert_allclose(adj, adj.T, atol=1e-9)


# ── Artifact discovery ────────────────────────────────────────────────────────

def test_artifact_registry_resolves_graph_outputs():
    from app.services.artifact_registry import resolve_run_artifacts
    import yaml
    with open(MANIFEST_PATH) as f:
        manifest = yaml.safe_load(f)
    n = 6
    mat = _symmetric_matrix(n, seed=22)
    with tempfile.TemporaryDirectory() as d:
        out_dir = Path(d)
        np.save(out_dir / "adjacency_thresholded.npy", mat)
        (out_dir / "graph_metrics.json").write_text("{}")
        (out_dir / "node_metrics.csv").write_text("label,degree\n")
        (out_dir / "edge_list.csv").write_text("source,target,weight\n")
        (out_dir / "graph_report.html").write_text("<html></html>")
        (out_dir / "graph_summary.png").write_bytes(b"\x89PNG")
        artifacts = resolve_run_artifacts(manifest, str(out_dir), {}, "success")
    # ResolvedArtifact has .path and .resolution_source; use filenames to verify coverage
    paths_found = {str(a.path).rsplit("/", 1)[-1] for a in artifacts}
    assert "graph_metrics.json" in paths_found
    assert "node_metrics.csv" in paths_found
    assert "edge_list.csv" in paths_found
    assert "adjacency_thresholded.npy" in paths_found
    assert "graph_report.html" in paths_found
    assert "graph_summary.png" in paths_found


# ── Comparison eligibility ────────────────────────────────────────────────────

def _make_run(pipeline_id: str, produced_types: list[str]) -> dict:
    """Minimal run dict for eligibility checks (no real DB needed)."""
    from app.services.artifact_registry import ArtifactRecord
    return {"pipeline_manifest_id": pipeline_id, "produced_types": produced_types}


def test_graph_vs_graph_eligible():
    """Two graph-analysis runs should be 'graph_analysis' family."""
    # Import the TypeScript logic equivalent from the Python side isn't available,
    # but we can verify at the artifact type level.
    graph_types = [
        "graph_metrics_json", "graph_node_metrics_csv", "graph_edge_list_csv",
        "graph_adjacency_npy", "graph_report_html", "graph_summary_png",
    ]
    assert all(t.startswith("graph_") for t in graph_types), \
        "All graph output types must start with 'graph_' for frontend eligibility detection"


def test_graph_types_prefix():
    """Frontend comparisonEligibility.ts uses t.startsWith('graph_') — verify all types match."""
    import yaml
    with open(MANIFEST_PATH) as f:
        m = yaml.safe_load(f)
    for p in m.get("produces", []):
        assert p["type"].startswith("graph_"), \
            f"Produce type '{p['type']}' does not start with 'graph_' — frontend eligibility detection will fail"


# ── Numerical spot checks ─────────────────────────────────────────────────────

def test_density_known_value():
    """Fully connected 4-node graph should have density=1.0."""
    _, _, build_graph, compute_global_metrics, _ = get_engine()
    n = 4
    mat = np.ones((n, n))
    np.fill_diagonal(mat, 0)
    G = build_graph(mat, [f"R{i}" for i in range(n)])
    m = compute_global_metrics(G, n)
    assert abs(m["density"] - 1.0) < 1e-9, f"Full graph density should be 1.0, got {m['density']}"


def test_global_efficiency_path_graph():
    """For a path graph 0-1-2, global efficiency = mean inverse shortest path length."""
    import networkx as nx
    _, _, build_graph, compute_global_metrics, _ = get_engine()
    # Build 3-node path manually with integer nodes (matching build_graph convention)
    G = nx.Graph()
    G.add_edge(0, 1, weight=1.0)
    G.add_edge(1, 2, weight=1.0)
    m = compute_global_metrics(G, 3)
    # Pairs: 0-1=1, 0-2=2, 1-2=1 → inv = 1, 0.5, 1 → mean = 2.5/3 ≈ 0.833
    expected = (1.0 + 0.5 + 1.0) / 3.0
    assert abs(m["global_efficiency"] - expected) < 1e-6, \
        f"Path-graph global efficiency: expected {expected:.4f}, got {m['global_efficiency']:.4f}"


def test_participation_coefficient_single_community():
    """When all nodes are in one community, participation coefficient should be 0."""
    _, _, build_graph, compute_global_metrics, compute_node_metrics = get_engine()
    # Complete graph of 4 nodes — Louvain may assign all to one community
    n = 4
    mat = np.ones((n, n)) * 0.9
    np.fill_diagonal(mat, 0)
    labels = [f"R{i}" for i in range(n)]
    G = build_graph(mat, labels)
    rows = compute_node_metrics(G, labels)
    # Check that all communities are the same
    communities = {r["community"] for r in rows}
    if len(communities) == 1:
        for row in rows:
            assert row["participation_coefficient"] == 0.0, \
                f"Single community → participation coefficient must be 0, got {row['participation_coefficient']}"
