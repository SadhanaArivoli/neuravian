"""Connectome Graph Analysis — NeuroForge native pipeline.

Reads a functional connectivity matrix (NPY or CSV) produced by a prior
NeuroForge FC run, constructs a weighted undirected graph, and computes
graph-theoretic metrics using NetworkX.

Outputs
-------
graph_metrics.json          – global graph metrics
node_metrics.csv            – per-node metrics table
edge_list.csv               – thresholded edges
adjacency_thresholded.npy   – thresholded adjacency matrix
graph_report.html           – self-contained HTML summary
graph_summary.png           – degree distribution + hub ranking figure
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.style.use("dark_background")
import numpy as np
import networkx as nx

from app.reporting import data_table, document_shell, footer, info_box, key_value_table, metadata_grid, statistics_cards

try:
    import community as community_louvain  # python-louvain
    _LOUVAIN_AVAILABLE = True
except ImportError:
    _LOUVAIN_AVAILABLE = False

__version__ = "neuroforge-connectome-graph-analysis"

# ── Matrix loading ─────────────────────────────────────────────────────────────

def load_matrix(path: Path) -> tuple[np.ndarray, list[str]]:
    """Load a connectivity matrix from .npy or .csv.

    Returns (matrix, labels).
    Labels are read from the CSV header/index when available; otherwise
    integers are used.
    """
    if path.suffix == ".npy":
        mat = np.load(path)
        if mat.ndim != 2 or mat.shape[0] != mat.shape[1]:
            raise ValueError(f"Expected square 2-D matrix, got shape {mat.shape}")
        labels = [str(i) for i in range(mat.shape[0])]
        return mat.astype(float), labels

    if path.suffix == ".csv":
        import pandas as pd
        df = pd.read_csv(path, index_col=0)
        labels = list(df.index.astype(str))
        return df.values.astype(float), labels

    raise ValueError(f"Unsupported file type: {path.suffix}. Expected .npy or .csv")


# ── Thresholding ───────────────────────────────────────────────────────────────

def apply_threshold(
    matrix: np.ndarray,
    method: str,
    value: float,
) -> np.ndarray:
    """Return a thresholded copy of the matrix.

    method: "absolute" | "proportional" | "none"
    value:  threshold value (0–1 for proportional, absolute for absolute)
    """
    mat = matrix.copy()
    np.fill_diagonal(mat, 0.0)
    # Remove negative weights (treat as disconnected)
    mat = np.where(mat < 0, 0.0, mat)

    if method == "none":
        return mat

    if method == "absolute":
        mat = np.where(mat >= value, mat, 0.0)
        return mat

    if method == "proportional":
        # Keep top (value * 100)% of edges by weight
        if not (0.0 < value <= 1.0):
            raise ValueError(f"Proportional threshold must be in (0, 1], got {value}")
        upper = mat[np.triu_indices_from(mat, k=1)]
        nonzero = upper[upper > 0]
        if len(nonzero) == 0:
            return mat
        cutoff = np.percentile(nonzero, (1.0 - value) * 100)
        mat = np.where(mat >= cutoff, mat, 0.0)
        return mat

    raise ValueError(f"Unknown threshold method: {method!r}")


# ── Graph construction ─────────────────────────────────────────────────────────

def build_graph(matrix: np.ndarray, labels: list[str]) -> nx.Graph:
    """Build a weighted undirected NetworkX graph from a symmetric matrix."""
    n = matrix.shape[0]
    G = nx.Graph()
    G.add_nodes_from(range(n))
    nx.set_node_attributes(G, {i: labels[i] for i in range(n)}, "label")
    for i in range(n):
        for j in range(i + 1, n):
            w = float((matrix[i, j] + matrix[j, i]) / 2)
            if w > 0:
                G.add_edge(i, j, weight=w)
    return G


# ── Global graph metrics ───────────────────────────────────────────────────────

def _safe(value: float | None) -> float | None:
    if value is None:
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return round(float(value), 6)


def compute_global_metrics(G: nx.Graph, n_nodes: int) -> dict[str, Any]:
    n_edges = G.number_of_edges()
    max_possible = n_nodes * (n_nodes - 1) / 2
    density = nx.density(G)

    # Strength (sum of weights)
    strengths = [sum(d["weight"] for _, d in G[u].items()) for u in G.nodes()]
    mean_strength = float(np.mean(strengths)) if strengths else 0.0

    # Weighted degree (same as strength for weighted undirected)
    degrees = [G.degree(u) for u in G.nodes()]
    mean_degree = float(np.mean(degrees)) if degrees else 0.0

    # Clustering
    try:
        clust = nx.average_clustering(G, weight="weight")
    except Exception:
        clust = None

    # Transitivity
    try:
        transitivity = nx.transitivity(G)
    except Exception:
        transitivity = None

    # Global efficiency
    try:
        global_eff = nx.global_efficiency(G)
    except Exception:
        global_eff = None

    # Local efficiency
    try:
        local_eff = nx.local_efficiency(G)
    except Exception:
        local_eff = None

    # Connected components
    components = list(nx.connected_components(G))
    n_components = len(components)
    largest_cc_size = max(len(c) for c in components) if components else 0
    is_connected = nx.is_connected(G)

    # Characteristic path length & avg shortest path (only if connected)
    char_path = None
    avg_shortest_path = None
    if is_connected and n_nodes > 1:
        try:
            avg_shortest_path = nx.average_shortest_path_length(G, weight=None)
            char_path = avg_shortest_path
        except Exception:
            pass

    # Betweenness centrality (normalised, unweighted for speed on large graphs)
    try:
        bc = nx.betweenness_centrality(G, normalized=True, weight=None)
        mean_betweenness = float(np.mean(list(bc.values())))
    except Exception:
        mean_betweenness = None

    # Modularity via Louvain
    modularity = None
    n_communities = None
    if _LOUVAIN_AVAILABLE and n_edges > 0:
        try:
            partition = community_louvain.best_partition(G, weight="weight")
            modularity = community_louvain.modularity(partition, G, weight="weight")
            n_communities = len(set(partition.values()))
        except Exception:
            pass

    return {
        "n_nodes": n_nodes,
        "n_edges": n_edges,
        "max_possible_edges": int(max_possible),
        "density": _safe(density),
        "mean_degree": _safe(mean_degree),
        "mean_strength": _safe(mean_strength),
        "global_efficiency": _safe(global_eff),
        "local_efficiency": _safe(local_eff),
        "clustering_coefficient": _safe(clust),
        "transitivity": _safe(transitivity),
        "characteristic_path_length": _safe(char_path),
        "average_shortest_path_length": _safe(avg_shortest_path),
        "mean_betweenness_centrality": _safe(mean_betweenness),
        "modularity": _safe(modularity),
        "n_communities": n_communities,
        "n_connected_components": n_components,
        "largest_component_size": largest_cc_size,
        "is_connected": is_connected,
    }


# ── Per-node metrics ───────────────────────────────────────────────────────────

def compute_node_metrics(
    G: nx.Graph,
    labels: list[str],
) -> list[dict[str, Any]]:
    n = G.number_of_nodes()

    degrees = dict(G.degree())
    strengths = {u: sum(d["weight"] for _, d in G[u].items()) for u in G.nodes()}

    # Clustering
    try:
        clust = nx.clustering(G, weight="weight")
    except Exception:
        clust = {u: None for u in G.nodes()}

    # Betweenness centrality
    try:
        bc = nx.betweenness_centrality(G, normalized=True, weight=None)
    except Exception:
        bc = {u: None for u in G.nodes()}

    # Participation coefficient (requires community assignment)
    participation = {u: None for u in G.nodes()}
    community_assignment: dict[int, int] | None = None
    if _LOUVAIN_AVAILABLE and G.number_of_edges() > 0:
        try:
            community_assignment = community_louvain.best_partition(G, weight="weight")
            for u in G.nodes():
                ki = strengths[u]
                if ki == 0:
                    participation[u] = 0.0
                    continue
                # Sum of within-module strengths squared
                module_strengths: dict[int, float] = {}
                for v, edge_data in G[u].items():
                    mod_v = community_assignment[v]
                    module_strengths[mod_v] = module_strengths.get(mod_v, 0.0) + edge_data["weight"]
                pc = 1.0 - sum((s / ki) ** 2 for s in module_strengths.values())
                participation[u] = _safe(pc)
        except Exception:
            pass

    rows = []
    for i in G.nodes():
        rows.append({
            "node_index": i,
            "node_label": labels[i],
            "degree": degrees[i],
            "strength": _safe(strengths[i]),
            "clustering_coefficient": _safe(clust[i]) if clust[i] is not None else None,
            "betweenness_centrality": _safe(bc[i]) if bc[i] is not None else None,
            "participation_coefficient": participation[i],
            "community": community_assignment[i] if community_assignment is not None else None,
        })
    return rows


# ── Output writers ─────────────────────────────────────────────────────────────

def _write_json(path: Path, data: Any) -> None:
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _write_node_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("")
        return
    fieldnames = list(rows[0].keys())
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _write_edge_csv(path: Path, G: nx.Graph, labels: list[str]) -> None:
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["source_index", "target_index", "source_label", "target_label", "weight"])
        for u, v, d in sorted(G.edges(data=True), key=lambda e: -e[2]["weight"]):
            writer.writerow([u, v, labels[u], labels[v], round(d["weight"], 6)])


def _write_summary_figure(
    path: Path,
    G: nx.Graph,
    node_rows: list[dict[str, Any]],
    global_metrics: dict[str, Any],
) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    fig.patch.set_facecolor("#1a1a2e")
    for ax in axes:
        ax.set_facecolor("#16213e")

    # Left: degree distribution
    degrees = [r["degree"] for r in node_rows]
    ax0 = axes[0]
    bins = max(10, len(set(degrees)))
    ax0.hist(degrees, bins=bins, color="#4f8ef7", edgecolor="#1a1a2e", linewidth=0.5)
    ax0.set_xlabel("Degree", color="white", fontsize=11)
    ax0.set_ylabel("Count", color="white", fontsize=11)
    ax0.set_title("Degree Distribution", color="white", fontsize=13, pad=10)
    ax0.tick_params(colors="white")
    for spine in ax0.spines.values():
        spine.set_edgecolor("#333")

    # Right: top 15 nodes by strength (hub ranking)
    ax1 = axes[1]
    sorted_rows = sorted(node_rows, key=lambda r: r["strength"] or 0, reverse=True)[:15]
    labels_plot = [r["node_label"][-20:] for r in sorted_rows]
    strengths_plot = [r["strength"] or 0 for r in sorted_rows]
    y_pos = range(len(labels_plot))
    bars = ax1.barh(list(y_pos), strengths_plot, color="#a78bfa", edgecolor="#1a1a2e", linewidth=0.5)
    ax1.set_yticks(list(y_pos))
    ax1.set_yticklabels(labels_plot, color="white", fontsize=8)
    ax1.set_xlabel("Strength", color="white", fontsize=11)
    ax1.set_title("Top 15 Hubs by Strength", color="white", fontsize=13, pad=10)
    ax1.tick_params(colors="white")
    ax1.invert_yaxis()
    for spine in ax1.spines.values():
        spine.set_edgecolor("#333")

    plt.tight_layout(pad=2.0)
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)


def _write_html_report(
    path: Path,
    global_metrics: dict[str, Any],
    node_rows: list[dict[str, Any]],
    provenance: dict[str, Any],
) -> None:
    def fmt(v: Any) -> str:
        if v is None:
            return "—"
        if isinstance(v, float):
            return f"{v:.4f}"
        return str(v)

    def bool_fmt(v: Any) -> str:
        if v is True:
            return "Yes"
        if v is False:
            return "No"
        return str(v)

    top_nodes = sorted(node_rows, key=lambda r: r["strength"] or 0, reverse=True)[:20]
    metrics = [(k.replace("_", " ").title(), bool_fmt(v) if isinstance(v, bool) else fmt(v)) for k, v in global_metrics.items()]
    node_values = ([r["node_index"], r["node_label"], r["degree"], fmt(r["strength"]), fmt(r["clustering_coefficient"]), fmt(r["betweenness_centrality"]), fmt(r["participation_coefficient"]), r["community"] if r["community"] is not None else "—"] for r in top_nodes)
    body = metadata_grid({"NetworkX": nx.__version__, "Community detection": "Louvain available" if _LOUVAIN_AVAILABLE else "Louvain unavailable", "Graph": "Weighted undirected"})
    body += "<h2>Global metrics</h2>" + statistics_cards(metrics)
    body += "<h2>Top 20 nodes by strength</h2>" + data_table(["#", "Label", "Degree", "Strength", "Clustering", "Betweenness", "Participation", "Community"], node_values)
    body += "<h2>Provenance</h2>" + key_value_table([("Source run", provenance.get("source_run_id", "—")), ("Input artifact", Path(str(provenance.get("input_file", "artifact"))).name), ("Threshold method", provenance.get("threshold_method", "—")), ("Threshold value", provenance.get("threshold_value", "—")), ("Runtime", f"{provenance.get('runtime_seconds', '—')} s"), ("NetworkX", nx.__version__)])
    body += info_box("Interpretation note", "Graph metrics are descriptive and are not clinical findings or inferential statistical results.")
    path.write_text(document_shell("Connectome Graph Analysis Report", "Network topology summary", body, footer_html=footer()), encoding="utf-8")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ── Entry point ────────────────────────────────────────────────────────────────

def run(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="NeuroForge Connectome Graph Analysis",
        prog="neuroforge-connectome-graph-analysis",
    )
    parser.add_argument("--input-matrix", required=True,
                        help="Path to connectivity matrix (.npy or .csv)")
    parser.add_argument("--threshold-method", default="proportional",
                        choices=["absolute", "proportional", "none"],
                        help="Thresholding method (default: proportional)")
    parser.add_argument("--threshold-value", type=float, default=0.25,
                        help="Threshold value: for proportional, fraction of edges to keep (0–1); "
                             "for absolute, minimum weight (default: 0.25)")
    parser.add_argument("--source-run-id", type=int, default=None,
                        help="NeuroForge run ID of the FC run that produced the matrix")
    parser.add_argument("--output-dir", required=True,
                        help="Directory to write outputs")
    args = parser.parse_args(argv)

    t_start = time.time()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    input_path = Path(args.input_matrix)
    if not input_path.exists():
        print(f"[neuroforge] ERROR: input matrix not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[neuroforge] Loading matrix: {input_path}")
    matrix, labels = load_matrix(input_path)
    n_nodes = matrix.shape[0]
    print(f"[neuroforge] Matrix shape: {matrix.shape} ({n_nodes} nodes)")

    print(f"[neuroforge] Threshold: {args.threshold_method} @ {args.threshold_value}")
    matrix_thresh = apply_threshold(matrix, args.threshold_method, args.threshold_value)

    print(f"[neuroforge] Building graph …")
    G = build_graph(matrix_thresh, labels)
    print(f"[neuroforge] Graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

    print(f"[neuroforge] Computing global metrics …")
    global_metrics = compute_global_metrics(G, n_nodes)

    print(f"[neuroforge] Computing node metrics …")
    node_rows = compute_node_metrics(G, labels)

    # Save thresholded adjacency
    adj_path = output_dir / "adjacency_thresholded.npy"
    np.save(adj_path, matrix_thresh)
    print(f"[neuroforge] Saved adjacency: {adj_path}")

    # Edge list
    edge_path = output_dir / "edge_list.csv"
    _write_edge_csv(edge_path, G, labels)
    print(f"[neuroforge] Saved edge list: {edge_path}")

    # Node metrics CSV
    node_csv_path = output_dir / "node_metrics.csv"
    _write_node_csv(node_csv_path, node_rows)
    print(f"[neuroforge] Saved node metrics: {node_csv_path}")

    # Figure
    fig_path = output_dir / "graph_summary.png"
    _write_summary_figure(fig_path, G, node_rows, global_metrics)
    print(f"[neuroforge] Saved figure: {fig_path}")

    # Runtime
    runtime = round(time.time() - t_start, 2)

    # Provenance + graph metrics JSON
    provenance: dict[str, Any] = {
        "source_run_id": args.source_run_id,
        "input_file": str(input_path),
        "threshold_method": args.threshold_method,
        "threshold_value": args.threshold_value,
        "graph_type": "weighted_undirected",
        "runtime_seconds": runtime,
        "networkx_version": nx.__version__,
        "louvain_available": _LOUVAIN_AVAILABLE,
        "checksums": {
            "adjacency_thresholded.npy": _sha256(adj_path),
            "edge_list.csv": _sha256(edge_path),
            "node_metrics.csv": _sha256(node_csv_path),
        },
    }

    metrics_payload: dict[str, Any] = {
        **global_metrics,
        "provenance": provenance,
    }
    metrics_path = output_dir / "graph_metrics.json"
    _write_json(metrics_path, metrics_payload)
    print(f"[neuroforge] Saved graph metrics: {metrics_path}")

    # HTML report
    report_path = output_dir / "graph_report.html"
    _write_html_report(report_path, global_metrics, node_rows, provenance)
    print(f"[neuroforge] Saved report: {report_path}")

    provenance["checksums"]["graph_metrics.json"] = _sha256(metrics_path)
    provenance["checksums"]["node_metrics.csv"] = _sha256(node_csv_path)
    provenance["checksums"]["graph_report.html"] = _sha256(report_path)

    print(f"[neuroforge] Done in {runtime}s")
    print(f"[neuroforge] Global efficiency: {global_metrics.get('global_efficiency')}")
    print(f"[neuroforge] Modularity Q: {global_metrics.get('modularity')}")
    print(f"[neuroforge] Communities: {global_metrics.get('n_communities')}")
    print(f"[neuroforge] Density: {global_metrics.get('density')}")


def main() -> None:
    run()


if __name__ == "__main__":
    main()
