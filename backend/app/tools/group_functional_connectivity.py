"""Group Functional Connectivity aggregation tool.

Aggregates multiple NeuroForge functional-connectivity run output directories
into a group mean and standard-deviation connectivity matrix.  Performs
compatibility validation (same atlas, ROI count, correlation method) then
writes mean/std matrices, heatmaps, a JSON summary, and an HTML report.

Descriptive statistics only — no inferential testing.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

# ── Compatibility helpers ──────────────────────────────────────────────────────

def _load_matrix(matrix_dir: Path) -> tuple[np.ndarray, dict[str, Any]]:
    """Load connectivity matrix and metadata from a FC run output directory.

    Returns (matrix_array, metadata_dict).
    Raises FileNotFoundError / ValueError on missing or malformed data.
    """
    # Find connectivity_matrix CSV
    csvs = sorted(matrix_dir.glob("*connectivity_matrix*.csv"))
    if not csvs:
        raise FileNotFoundError(
            f"No connectivity_matrix CSV found in {matrix_dir}"
        )
    csv_path = csvs[0]

    # Find connectivity_metadata JSON
    meta_files = sorted(matrix_dir.glob("*connectivity_metadata*.json"))
    metadata: dict[str, Any] = {}
    if meta_files:
        with open(meta_files[0]) as f:
            metadata = json.load(f)

    # Parse CSV — first row is header (ROI labels), first column is index label
    import csv as csv_mod
    with open(csv_path, newline="") as f:
        reader = csv_mod.reader(f)
        rows = list(reader)
    if len(rows) < 2:
        raise ValueError(f"Connectivity matrix CSV is empty: {csv_path}")
    # Drop header row and first column (label column)
    data_rows = [row[1:] for row in rows[1:]]
    matrix = np.array([[float(v) for v in row] for row in data_rows], dtype=np.float64)
    if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1]:
        raise ValueError(
            f"Expected square matrix, got shape {matrix.shape} from {csv_path}"
        )
    return matrix, metadata


def _check_compatibility(
    matrices: list[np.ndarray],
    metadatas: list[dict[str, Any]],
    run_dirs: list[Path],
) -> list[str]:
    """Validate that all matrices are compatible for averaging.

    Returns a list of warning strings (empty if fully compatible).
    Raises ValueError on fatal incompatibilities.
    """
    warnings: list[str] = []

    # Shape check — fatal
    ref_shape = matrices[0].shape
    for i, mat in enumerate(matrices[1:], 1):
        if mat.shape != ref_shape:
            raise ValueError(
                f"Matrix dimension mismatch: run 0 has shape {ref_shape} "
                f"but run {i} ({run_dirs[i]}) has shape {mat.shape}"
            )

    # Atlas check — fatal
    ref_atlas = metadatas[0].get("atlas_id") or metadatas[0].get("atlas")
    if ref_atlas:
        for i, meta in enumerate(metadatas[1:], 1):
            cand_atlas = meta.get("atlas_id") or meta.get("atlas")
            if cand_atlas and cand_atlas != ref_atlas:
                raise ValueError(
                    f"Atlas mismatch: run 0 used '{ref_atlas}' but "
                    f"run {i} used '{cand_atlas}'"
                )

    # Correlation method — warning
    ref_method = metadatas[0].get("correlation_method")
    if ref_method:
        for i, meta in enumerate(metadatas[1:], 1):
            cand_method = meta.get("correlation_method")
            if cand_method and cand_method != ref_method:
                warnings.append(
                    f"Correlation method mismatch: run 0 used '{ref_method}' but "
                    f"run {i} used '{cand_method}'"
                )

    # Pipeline version — warning only
    ref_ver = metadatas[0].get("nilearn_version") or metadatas[0].get("pipeline_version")
    if ref_ver:
        for i, meta in enumerate(metadatas[1:], 1):
            cand_ver = meta.get("nilearn_version") or meta.get("pipeline_version")
            if cand_ver and cand_ver != ref_ver:
                warnings.append(
                    f"Nilearn version mismatch: run 0 used {ref_ver}, "
                    f"run {i} used {cand_ver}"
                )

    return warnings


# ── Heatmap ────────────────────────────────────────────────────────────────────

def _write_heatmap(
    matrix: np.ndarray,
    output_path: Path,
    title: str,
    roi_labels: list[str] | None = None,
) -> None:
    """Write a square connectivity matrix as a PNG heatmap using matplotlib."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    n = matrix.shape[0]
    fig_size = max(6, min(20, n * 0.12))
    fig, ax = plt.subplots(figsize=(fig_size, fig_size * 0.9))

    vmax = np.nanmax(np.abs(matrix))
    vmax = max(vmax, 0.01)
    im = ax.imshow(matrix, cmap="RdBu_r", vmin=-vmax, vmax=vmax, aspect="auto")
    plt.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    ax.set_title(title, fontsize=10, pad=8)
    ax.set_xlabel("ROI index")
    ax.set_ylabel("ROI index")

    if roi_labels and n <= 50:
        ax.set_xticks(range(n))
        ax.set_yticks(range(n))
        ax.set_xticklabels(roi_labels, rotation=90, fontsize=5)
        ax.set_yticklabels(roi_labels, fontsize=5)

    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)


# ── HTML report ────────────────────────────────────────────────────────────────

def _write_html_report(
    output_path: Path,
    summary: dict[str, Any],
    warnings: list[str],
    run_dirs: list[Path],
) -> None:
    """Write a self-contained HTML summary report."""
    n_runs = summary["n_runs"]
    atlas = summary.get("atlas") or "unknown"
    n_rois = summary.get("n_rois", "?")
    method = summary.get("correlation_method") or "Pearson correlation"
    mean_min = summary.get("mean_z_min", "?")
    mean_max = summary.get("mean_z_max", "?")
    mean_mean = summary.get("mean_z_mean", "?")
    std_max = summary.get("std_z_max", "?")

    def fmt(v: Any) -> str:
        if isinstance(v, float):
            return f"{v:.4f}"
        return str(v)

    warn_html = ""
    if warnings:
        items = "".join(f"<li>{w}</li>" for w in warnings)
        warn_html = f"""
        <div style="background:#fff3cd;border:1px solid #ffc107;padding:10px 14px;
                    border-radius:6px;margin-bottom:18px">
          <strong>Warnings</strong>
          <ul style="margin:6px 0 0 18px;padding:0">{items}</ul>
        </div>"""

    runs_rows = "".join(
        f"<tr><td style='padding:4px 10px'>{i + 1}</td>"
        f"<td style='padding:4px 10px;font-family:monospace;font-size:12px'>{d}</td></tr>"
        for i, d in enumerate(run_dirs)
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Group Functional Connectivity Report</title>
  <style>
    body{{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#222}}
    h1{{font-size:1.4rem;border-bottom:2px solid #e5e7eb;padding-bottom:10px}}
    h2{{font-size:1.1rem;color:#374151;margin-top:28px}}
    table{{border-collapse:collapse;width:100%}}
    th{{background:#f3f4f6;text-align:left;padding:6px 10px;font-weight:600}}
    td{{border-top:1px solid #e5e7eb}}
    .badge{{display:inline-block;padding:2px 8px;border-radius:12px;
            background:#dbeafe;color:#1d4ed8;font-size:12px;font-weight:600}}
  </style>
</head>
<body>
  <h1>Group Functional Connectivity Report</h1>
  {warn_html}
  <h2>Aggregation summary</h2>
  <table>
    <tr><th>Runs aggregated</th><td><span class="badge">{n_runs}</span></td></tr>
    <tr><th>Atlas</th><td>{atlas}</td></tr>
    <tr><th>ROI count</th><td>{n_rois}</td></tr>
    <tr><th>Correlation method</th><td>{method}</td></tr>
    <tr><th>Mean matrix — min z</th><td>{fmt(mean_min)}</td></tr>
    <tr><th>Mean matrix — max z</th><td>{fmt(mean_max)}</td></tr>
    <tr><th>Mean matrix — mean z</th><td>{fmt(mean_mean)}</td></tr>
    <tr><th>Std matrix — max std</th><td>{fmt(std_max)}</td></tr>
  </table>

  <h2>Input runs</h2>
  <table>
    <tr><th>#</th><th>Output directory</th></tr>
    {runs_rows}
  </table>

  <h2>Outputs</h2>
  <ul>
    <li><code>group_mean_connectivity_matrix.csv</code> — mean ROI × ROI matrix</li>
    <li><code>group_mean_connectivity_matrix.npy</code> — NumPy binary</li>
    <li><code>group_mean_connectivity_heatmap.png</code> — mean heatmap</li>
    <li><code>group_std_connectivity_matrix.csv</code> — std ROI × ROI matrix</li>
    <li><code>group_std_connectivity_heatmap.png</code> — std heatmap</li>
    <li><code>group_summary.json</code> — machine-readable summary</li>
  </ul>

  <p style="color:#6b7280;font-size:12px;margin-top:32px">
    Generated by NeuroForge Group Functional Connectivity pipeline.
    This report contains descriptive statistics only.
  </p>
</body>
</html>"""
    output_path.write_text(html)


# ── Matrix CSV writer ──────────────────────────────────────────────────────────

def _write_matrix_csv(
    matrix: np.ndarray,
    output_path: Path,
    roi_labels: list[str] | None = None,
) -> None:
    import csv as csv_mod
    n = matrix.shape[0]
    labels = roi_labels if roi_labels and len(roi_labels) == n else [str(i) for i in range(n)]
    with open(output_path, "w", newline="") as f:
        writer = csv_mod.writer(f)
        writer.writerow([""] + labels)
        for i, row in enumerate(matrix):
            writer.writerow([labels[i]] + [f"{v:.8f}" for v in row])


# ── Entry point ────────────────────────────────────────────────────────────────

def run(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="neuroforge-group-functional-connectivity",
        description="Aggregate multiple FC runs into a group mean/std matrix.",
    )
    parser.add_argument(
        "--matrix-dirs",
        required=True,
        help="Comma-separated list of FC run output directories",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory to write group outputs into",
    )
    # input-run-ids is resolved by the backend to matrix-dirs before execution.
    # It is passed through by NativeExecutor for provenance; the tool ignores it.
    parser.add_argument("--input-run-ids", required=False)
    args = parser.parse_args(argv)

    t0 = time.monotonic()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    raw_dirs = [d.strip() for d in args.matrix_dirs.split(",") if d.strip()]
    if not raw_dirs:
        raise ValueError("No matrix directories provided via --matrix-dirs")

    run_dirs = [Path(d) for d in raw_dirs]
    for d in run_dirs:
        if not d.exists():
            raise FileNotFoundError(f"Run output directory not found: {d}")

    # Load matrices and metadata
    matrices: list[np.ndarray] = []
    metadatas: list[dict[str, Any]] = []
    for d in run_dirs:
        mat, meta = _load_matrix(d)
        matrices.append(mat)
        metadatas.append(meta)

    # Compatibility validation
    warnings = _check_compatibility(matrices, metadatas, run_dirs)

    # Aggregate
    stack = np.stack(matrices, axis=0)          # shape: (n_runs, n_rois, n_rois)
    mean_mat = np.mean(stack, axis=0)
    std_mat = np.std(stack, axis=0, ddof=1) if len(matrices) > 1 else np.zeros_like(mean_mat)

    # Extract ROI labels from first metadata
    roi_labels: list[str] | None = metadatas[0].get("roi_labels")
    n_rois = mean_mat.shape[0]

    # Write mean CSV
    _write_matrix_csv(
        mean_mat,
        output_dir / "group_mean_connectivity_matrix.csv",
        roi_labels,
    )
    # Write mean NPY
    np.save(str(output_dir / "group_mean_connectivity_matrix.npy"), mean_mat)

    # Write mean heatmap
    atlas_display = (
        metadatas[0].get("atlas_display_name")
        or metadatas[0].get("atlas")
        or "unknown atlas"
    )
    _write_heatmap(
        mean_mat,
        output_dir / "group_mean_connectivity_heatmap.png",
        title=f"Group Mean Connectivity — {atlas_display} (n={len(matrices)})",
        roi_labels=roi_labels,
    )

    # Write std CSV
    _write_matrix_csv(
        std_mat,
        output_dir / "group_std_connectivity_matrix.csv",
        roi_labels,
    )
    # Write std heatmap
    _write_heatmap(
        std_mat,
        output_dir / "group_std_connectivity_heatmap.png",
        title=f"Group Std Connectivity — {atlas_display} (n={len(matrices)})",
        roi_labels=roi_labels,
    )

    runtime = time.monotonic() - t0

    from nilearn import __version__ as nilearn_version
    import nilearn  # noqa: F401 — confirms nilearn present

    summary: dict[str, Any] = {
        "pipeline": "group-functional-connectivity",
        "n_runs": len(matrices),
        "atlas": atlas_display,
        "atlas_id": metadatas[0].get("atlas_id") or metadatas[0].get("atlas"),
        "atlas_citation": metadatas[0].get("atlas_citation"),
        "n_rois": n_rois,
        "correlation_method": metadatas[0].get("correlation_method"),
        "nilearn_version": nilearn_version,
        "input_run_dirs": [str(d) for d in run_dirs],
        "mean_z_min": float(np.nanmin(mean_mat)),
        "mean_z_max": float(np.nanmax(mean_mat)),
        "mean_z_mean": float(np.nanmean(mean_mat)),
        "mean_z_std": float(np.nanstd(mean_mat)),
        "std_z_min": float(np.nanmin(std_mat)),
        "std_z_max": float(np.nanmax(std_mat)),
        "std_z_mean": float(np.nanmean(std_mat)),
        "warnings": warnings,
        "runtime_seconds": round(runtime, 2),
    }
    with open(output_dir / "group_summary.json", "w") as f:
        json.dump(summary, f, indent=2)

    # HTML report
    _write_html_report(
        output_dir / "group_report.html",
        summary=summary,
        warnings=warnings,
        run_dirs=run_dirs,
    )

    print(f"Group FC complete: {len(matrices)} runs, {n_rois} ROIs, "
          f"atlas={atlas_display}, runtime={runtime:.1f}s")


def main() -> None:
    run(sys.argv[1:])
