"""Group Functional Connectivity aggregation tool.

Aggregates multiple Neuravian functional-connectivity run output directories
into a group mean and standard-deviation connectivity matrix using the
Fisher r-to-z transform (arctanh).

Scientific rationale
--------------------
Pearson correlation coefficients are bounded in [−1, 1] and are not normally
distributed, so arithmetic averaging of raw r values is statistically
inappropriate.  Fisher (1915, 1921) showed that z = arctanh(r) is
approximately normally distributed with variance 1/(n−3), making it the
correct space for averaging across participants or runs.

Procedure
---------
1. Load each individual r matrix from connectivity_matrix.csv.
2. Zero the diagonal (r = 1 → arctanh = ∞; diagonal is meaningless for group
   connectivity).
3. Clip off-diagonal r to (−1 + ε, 1 − ε) with ε = 1e-6 to prevent ±∞ after
   arctanh.
4. Apply Fisher z = arctanh(r_clipped) element-wise.
5. Compute the arithmetic mean and sample standard deviation (ddof=1) in
   z-space across all n runs.
6. Back-transform the mean: mean_r = tanh(mean_z).
7. Restore the diagonal: mean_z diagonal = 0, mean_r diagonal = 1.

Outputs
-------
group_mean_r_matrix.csv / .npy  — primary result: mean r (back-transformed)
group_mean_fisher_z_matrix.csv / .npy — mean in z-space
group_std_fisher_z_matrix.csv / .npy  — sample std in z-space (ddof=1)
group_mean_r_heatmap.png           — heatmap of back-transformed mean r
group_mean_fisher_z_heatmap.png    — heatmap of mean z
group_std_fisher_z_heatmap.png     — heatmap of z-space std
group_summary.json                 — machine-readable summary
group_report.html                  — HTML summary report

Backward compatibility
----------------------
Runs produced before v0.1.1 averaged raw r without Fisher z.  The
group_summary.json for those runs lacks the 'fisher_z_applied' key (or it
is False).  The UI labels such runs accordingly and blocks cross-comparison
with new Fisher-z runs.

References
----------
Fisher, R. A. (1915). Frequency distribution of the values of the
    correlation coefficient in samples from an indefinitely large population.
    Biometrika, 10(4), 507–521.
Fisher, R. A. (1921). On the 'probable error' of a coefficient of correlation
    deduced from a small sample. Metron, 1, 3–32.

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

from app.reporting import citation_block, data_table, document_shell, footer, info_box, key_value_table, save_dark_figure, statistics_cards, warning_box
from app.tools.functional_connectivity import (
    LEGACY_ATLAS_ALIASES,
    normalize_atlas_id,
)

# Epsilon used to clip r values away from ±1 before arctanh to prevent ±∞.
_FISHER_CLIP_EPS: float = 1e-6


# ── Matrix and metadata loading ───────────────────────────────────────────────

def _load_matrix(matrix_dir: Path) -> tuple[np.ndarray, dict[str, Any]]:
    """Load connectivity matrix and metadata from a FC run output directory.

    Returns (matrix_array, metadata_dict).
    Raises FileNotFoundError / ValueError on missing or malformed data.
    """
    csvs = sorted(matrix_dir.glob("*connectivity_matrix*.csv"))
    if not csvs:
        raise FileNotFoundError(
            f"No connectivity_matrix CSV found in {matrix_dir}"
        )
    csv_path = csvs[0]

    meta_files = sorted(matrix_dir.glob("*connectivity_metadata*.json"))
    metadata: dict[str, Any] = {}
    if meta_files:
        with open(meta_files[0]) as f:
            metadata = json.load(f)

    import csv as csv_mod
    with open(csv_path, newline="") as f:
        reader = csv_mod.reader(f)
        rows = list(reader)
    if len(rows) < 2:
        raise ValueError(f"Connectivity matrix CSV is empty: {csv_path}")
    data_rows = [row[1:] for row in rows[1:]]
    matrix = np.array([[float(v) for v in row] for row in data_rows], dtype=np.float64)
    if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1]:
        raise ValueError(
            f"Expected square matrix, got shape {matrix.shape} from {csv_path}"
        )
    return matrix, metadata


# ── Fisher z-transform aggregation ────────────────────────────────────────────

def _fisher_aggregate(
    matrices: list[np.ndarray],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Aggregate a list of Pearson r matrices via Fisher r-to-z transform.

    Returns (mean_r, mean_z, std_z) — all three are n_rois × n_rois arrays.
    Diagonal entries of mean_z are 0; diagonal entries of mean_r are 1.
    """
    n_runs = len(matrices)
    n_rois = matrices[0].shape[0]
    diag_mask = np.eye(n_rois, dtype=bool)

    z_stack = np.zeros((n_runs, n_rois, n_rois), dtype=np.float64)
    for i, mat in enumerate(matrices):
        # Set diagonal to 0 before transform (arctanh(1) = +∞)
        r_off = np.where(diag_mask, 0.0, mat)
        r_clipped = np.clip(r_off, -1.0 + _FISHER_CLIP_EPS, 1.0 - _FISHER_CLIP_EPS)
        z = np.arctanh(r_clipped)
        z[diag_mask] = 0.0
        z_stack[i] = z

    mean_z = np.mean(z_stack, axis=0)
    std_z = (
        np.std(z_stack, axis=0, ddof=1) if n_runs > 1
        else np.zeros((n_rois, n_rois), dtype=np.float64)
    )
    mean_z[diag_mask] = 0.0
    std_z[diag_mask] = 0.0

    mean_r = np.tanh(mean_z)
    mean_r[diag_mask] = 1.0

    return mean_r, mean_z, std_z


# ── Compatibility validation ───────────────────────────────────────────────────

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

    ref_shape = matrices[0].shape
    for i, mat in enumerate(matrices[1:], 1):
        if mat.shape != ref_shape:
            raise ValueError(
                f"Matrix dimension mismatch: run 0 has shape {ref_shape} "
                f"but run {i} ({run_dirs[i]}) has shape {mat.shape}"
            )

    ref_atlas_raw = metadatas[0].get("atlas_id") or metadatas[0].get("atlas")
    ref_atlas = LEGACY_ATLAS_ALIASES.get(ref_atlas_raw, ref_atlas_raw) if ref_atlas_raw else None
    if ref_atlas:
        for i, meta in enumerate(metadatas[1:], 1):
            cand_raw = meta.get("atlas_id") or meta.get("atlas")
            cand_atlas = LEGACY_ATLAS_ALIASES.get(cand_raw, cand_raw) if cand_raw else None
            if cand_atlas and cand_atlas != ref_atlas:
                raise ValueError(
                    f"Atlas mismatch: run 0 used '{ref_atlas_raw}' but "
                    f"run {i} used '{cand_raw}'"
                )

    # Confound strategy mismatch is fatal: aggregating runs with different
    # preprocessing would confound group mean interpretation.
    ref_strategy = metadatas[0].get("confound_strategy")
    if ref_strategy:
        for i, meta in enumerate(metadatas[1:], 1):
            cand_strategy = meta.get("confound_strategy")
            if cand_strategy and cand_strategy != ref_strategy:
                raise ValueError(
                    f"Confound strategy mismatch: run 0 used '{ref_strategy}' but "
                    f"run {i} used '{cand_strategy}'. All runs must use the same "
                    "confound strategy for group aggregation to be meaningful. "
                    "Global signal regression in particular changes correlation sign "
                    "and magnitude and must be consistent."
                )

    ref_method = metadatas[0].get("correlation_method")
    if ref_method:
        for i, meta in enumerate(metadatas[1:], 1):
            cand_method = meta.get("correlation_method")
            if cand_method and cand_method != ref_method:
                warnings.append(
                    f"Correlation method mismatch: run 0 used '{ref_method}' but "
                    f"run {i} used '{cand_method}'"
                )

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
    vmin: float | None = None,
    vmax: float | None = None,
) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.style.use("dark_background")

    n = matrix.shape[0]
    fig_size = max(6, min(20, n * 0.12))
    fig, ax = plt.subplots(figsize=(fig_size, fig_size * 0.9))

    if vmax is None:
        vmax = float(np.nanmax(np.abs(matrix)))
        vmax = max(vmax, 0.01)
    if vmin is None:
        vmin = -vmax

    im = ax.imshow(matrix, cmap="RdBu_r", vmin=vmin, vmax=vmax, aspect="auto")
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
    save_dark_figure(fig, output_path, dpi=150, bbox_inches="tight")
    plt.close(fig)


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


# ── HTML report ────────────────────────────────────────────────────────────────

def _write_html_report(
    output_path: Path,
    summary: dict[str, Any],
    warnings: list[str],
    run_dirs: list[Path],
) -> None:
    n_runs = summary["n_runs"]
    atlas = summary.get("atlas") or "unknown"
    n_rois = summary.get("n_rois", "?")
    method = summary.get("correlation_method") or "Pearson correlation"
    confound_strategy = summary.get("confound_strategy") or "Not recorded"
    agg_space = summary.get("aggregation_space", "raw_r (legacy)")
    fisher_applied = summary.get("fisher_z_applied", False)
    clip_eps = summary.get("clip_epsilon", "N/A")
    ddof = summary.get("ddof", "N/A")
    mean_r_min = summary.get("mean_r_min", "?")
    mean_r_max = summary.get("mean_r_max", "?")
    mean_z_min = summary.get("mean_z_min", "?")
    mean_z_max = summary.get("mean_z_max", "?")
    std_z_max = summary.get("std_z_max", "?")

    def fmt(v: Any) -> str:
        if isinstance(v, float):
            return f"{v:.4f}"
        return str(v)

    notices = "".join(warning_box("Compatibility warning", w) for w in warnings)
    if not fisher_applied:
        notices += warning_box("Legacy aggregation (raw r)", "This run predates Fisher r-to-z aggregation. Re-run the same inputs to obtain Fisher-z results.")
    method_rows = [("Aggregation space", agg_space), ("Fisher r-to-z applied", "Yes (arctanh)" if fisher_applied else "No (legacy raw r)"), ("Confound strategy", confound_strategy)]
    if fisher_applied:
        method_rows.extend([("Clip epsilon", clip_eps), ("ddof (std)", ddof)])
    summary_cards = [("Runs aggregated", n_runs), ("Atlas", atlas), ("ROI count", n_rois), ("Correlation method", method), ("Mean z min", fmt(mean_z_min)), ("Mean z max", fmt(mean_z_max)), ("Std z max", fmt(std_z_max))]
    if fisher_applied:
        summary_cards.extend([("Mean r min", fmt(mean_r_min)), ("Mean r max", fmt(mean_r_max))])
    output_rows = [(name, description) for name, description in [
        ("group_mean_r_matrix.csv", "Back-transformed mean r matrix"), ("group_mean_r_heatmap.png", "Mean r heatmap"),
        ("group_mean_fisher_z_matrix.csv", "Mean Fisher z matrix"), ("group_mean_fisher_z_heatmap.png", "Mean z heatmap"),
        ("group_std_fisher_z_matrix.csv", "Sample standard deviation in z-space"), ("group_std_fisher_z_heatmap.png", "Z-space standard deviation heatmap"),
        ("group_summary.json", "Machine-readable summary")]]
    body = notices + "<h2>Aggregation method</h2>" + key_value_table(method_rows) + "<h2>Aggregation summary</h2>" + statistics_cards(summary_cards)
    body += "<h2>Input runs</h2>" + data_table(["#", "Source run artifact"], ((i + 1, d.name or f"run-{i + 1}") for i, d in enumerate(run_dirs)))
    body += "<h2>Outputs</h2>" + data_table(["File", "Description"], output_rows)
    body += info_box("Interpretation note", "Descriptive statistics only; no inferential testing. Group means are computed in Fisher z-space and back-transformed to r.")
    body += citation_block(["Fisher, R. A. (1915). Biometrika, 10(4), 507–521.", "Fisher, R. A. (1921). Metron, 1, 3–32."])
    output_path.write_text(document_shell("Group Functional Connectivity Report", "Fisher z-space aggregation summary", body, footer_html=footer()), encoding="utf-8")


# ── Entry point ────────────────────────────────────────────────────────────────

def run(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="neuravian-group-functional-connectivity",
        description="Aggregate multiple FC runs into a group mean/std matrix via Fisher z.",
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

    matrices: list[np.ndarray] = []
    metadatas: list[dict[str, Any]] = []
    for d in run_dirs:
        mat, meta = _load_matrix(d)
        matrices.append(mat)
        metadatas.append(meta)

    warnings = _check_compatibility(matrices, metadatas, run_dirs)

    # Fisher r-to-z aggregation
    mean_r, mean_z, std_z = _fisher_aggregate(matrices)

    roi_labels: list[str] | None = metadatas[0].get("roi_labels")
    n_rois = mean_r.shape[0]

    atlas_display = (
        metadatas[0].get("atlas_display_name")
        or metadatas[0].get("atlas")
        or "unknown atlas"
    )
    n = len(matrices)

    # Write mean r outputs
    _write_matrix_csv(
        mean_r, output_dir / "group_mean_r_matrix.csv", roi_labels,
    )
    np.save(str(output_dir / "group_mean_r_matrix.npy"), mean_r)
    _write_heatmap(
        mean_r,
        output_dir / "group_mean_r_heatmap.png",
        title=f"Group Mean Connectivity (r) — {atlas_display} (n={n})",
        roi_labels=roi_labels,
        vmin=-1.0, vmax=1.0,
    )

    # Write mean z outputs
    _write_matrix_csv(
        mean_z, output_dir / "group_mean_fisher_z_matrix.csv", roi_labels,
    )
    np.save(str(output_dir / "group_mean_fisher_z_matrix.npy"), mean_z)
    _write_heatmap(
        mean_z,
        output_dir / "group_mean_fisher_z_heatmap.png",
        title=f"Group Mean Connectivity (Fisher z) — {atlas_display} (n={n})",
        roi_labels=roi_labels,
    )

    # Write std z outputs
    _write_matrix_csv(
        std_z, output_dir / "group_std_fisher_z_matrix.csv", roi_labels,
    )
    np.save(str(output_dir / "group_std_fisher_z_matrix.npy"), std_z)
    _write_heatmap(
        std_z,
        output_dir / "group_std_fisher_z_heatmap.png",
        title=f"Group Std Connectivity (Fisher z, ddof=1) — {atlas_display} (n={n})",
        roi_labels=roi_labels,
        vmin=0.0,
    )

    runtime = time.monotonic() - t0

    from nilearn import __version__ as nilearn_version

    # Off-diagonal masks for scalar summaries
    diag_mask = np.eye(n_rois, dtype=bool)
    off_r = mean_r[~diag_mask]
    off_z = mean_z[~diag_mask]
    off_std = std_z[~diag_mask]

    confound_strategy = metadatas[0].get("confound_strategy", "Not recorded")

    summary: dict[str, Any] = {
        "pipeline": "group-functional-connectivity",
        "n_runs": n,
        "atlas": atlas_display,
        "atlas_id": metadatas[0].get("atlas_id") or metadatas[0].get("atlas"),
        "canonical_atlas_id": (
            lambda raw: LEGACY_ATLAS_ALIASES.get(raw, raw) if raw else None
        )(metadatas[0].get("atlas_id") or metadatas[0].get("atlas")),
        "atlas_citation": metadatas[0].get("atlas_citation"),
        "n_rois": n_rois,
        "roi_ordering": "canonical atlas ROI order from first input run",
        "correlation_method": metadatas[0].get("correlation_method"),
        "confound_strategy": confound_strategy,
        "nilearn_version": nilearn_version,
        "input_run_dirs": [str(d) for d in run_dirs],
        # ── Aggregation metadata ──────────────────────────────────────────────
        "fisher_z_applied": True,
        "aggregation_space": "fisher_z",
        "clip_epsilon": _FISHER_CLIP_EPS,
        "ddof": 1,
        # ── Mean r statistics (off-diagonal) ─────────────────────────────────
        "mean_r_min": float(np.nanmin(off_r)) if off_r.size else float("nan"),
        "mean_r_max": float(np.nanmax(off_r)) if off_r.size else float("nan"),
        "mean_r_mean": float(np.nanmean(off_r)) if off_r.size else float("nan"),
        "mean_r_std": float(np.nanstd(off_r)) if off_r.size else float("nan"),
        # ── Mean z statistics (off-diagonal) ─────────────────────────────────
        "mean_z_min": float(np.nanmin(off_z)) if off_z.size else float("nan"),
        "mean_z_max": float(np.nanmax(off_z)) if off_z.size else float("nan"),
        "mean_z_mean": float(np.nanmean(off_z)) if off_z.size else float("nan"),
        "mean_z_std": float(np.nanstd(off_z)) if off_z.size else float("nan"),
        # ── Std z statistics (off-diagonal) ──────────────────────────────────
        "std_z_min": float(np.nanmin(off_std)) if off_std.size else float("nan"),
        "std_z_max": float(np.nanmax(off_std)) if off_std.size else float("nan"),
        "std_z_mean": float(np.nanmean(off_std)) if off_std.size else float("nan"),
        "warnings": warnings,
        "runtime_seconds": round(runtime, 2),
    }
    with open(output_dir / "group_summary.json", "w") as f:
        json.dump(summary, f, indent=2)

    _write_html_report(
        output_dir / "group_report.html",
        summary=summary,
        warnings=warnings,
        run_dirs=run_dirs,
    )

    print(
        f"Group FC complete: {n} runs, {n_rois} ROIs, atlas={atlas_display}, "
        f"confound_strategy={confound_strategy}, "
        f"mean_r=[{summary['mean_r_min']:.3f}, {summary['mean_r_max']:.3f}], "
        f"runtime={runtime:.1f}s"
    )


def main() -> None:
    run(sys.argv[1:])
