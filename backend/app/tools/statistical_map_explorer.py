"""Statistical Map Explorer — threshold, cluster, and summarize NIfTI statistical maps.

Reads any single-volume statistical NIfTI (z-map, t-map, beta map, contrast map,
seed connectivity map) and produces:
  - thresholded_map.nii.gz    : binarized/thresholded image
  - cluster_table.csv         : per-cluster statistics
  - cluster_table.json        : machine-readable cluster data
  - cluster_overlay.png       : publication-quality mosaic overlay
  - cluster_report.html       : self-contained HTML report
  - cluster_metadata.json     : run parameters and provenance

Cluster detection uses scipy.ndimage.label (6-connectivity by default) — no FSL,
no AFNI, no SPM, no ANTs required. All computation is native Python.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

# ── Matplotlib env setup (must precede import) ────────────────────────────────
_cache_dir = Path(tempfile.gettempdir()) / "neuroforge-cache"
(_cache_dir / "matplotlib").mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(_cache_dir / "matplotlib"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.style.use("dark_background")
import matplotlib.colors as mcolors
import nibabel as nib
import numpy as np
from scipy import ndimage

from app.reporting import data_table, document_shell, figure_block, footer, info_box, methods_block, save_dark_figure, statistics_cards, warning_box

# ── Constants ─────────────────────────────────────────────────────────────────

NEUROFORGE_VERSION = "0.1.0"

# Connectivity structure: 6-connectivity (face-adjacent), standard for neuroimaging
_CONNECTIVITY_6 = ndimage.generate_binary_structure(3, 1)

CLUSTER_CSV_COLUMNS = [
    "cluster_id", "size_voxels", "peak_value", "mean_value",
    "peak_x_mm", "peak_y_mm", "peak_z_mm",
    "com_x_mm", "com_y_mm", "com_z_mm",
    "bbox_x0", "bbox_y0", "bbox_z0", "bbox_x1", "bbox_y1", "bbox_z1",
]

_COLORMAPS = {
    "hot": "hot",
    "cold": "winter",
    "hot_cold": "RdBu_r",
    "viridis": "viridis",
    "plasma": "plasma",
    "bwr": "bwr",
}

# ── Thresholding ──────────────────────────────────────────────────────────────

def apply_threshold(
    data: np.ndarray,
    threshold: float,
    direction: str,
) -> np.ndarray:
    """Return a float32 array with sub-threshold voxels set to 0.

    direction: 'positive' | 'negative' | 'two-sided'
    """
    out = data.copy().astype(np.float32)
    if direction == "positive":
        out[out < threshold] = 0.0
    elif direction == "negative":
        out[out > -threshold] = 0.0
    elif direction == "two-sided":
        out[np.abs(out) < threshold] = 0.0
    else:
        raise ValueError(f"Unknown direction: {direction!r}")
    return out


# ── Cluster detection ─────────────────────────────────────────────────────────

def detect_clusters(
    thresholded: np.ndarray,
    min_size: int,
) -> tuple[np.ndarray, int]:
    """Label connected components; drop clusters smaller than min_size.

    Returns (labeled_array, n_clusters).
    labeled_array: integer array where each cluster has a unique positive label.
    Labels are re-numbered 1…N sorted by descending cluster size.
    """
    binary = thresholded != 0
    labeled, n_raw = ndimage.label(binary, structure=_CONNECTIVITY_6)

    if n_raw == 0:
        return labeled, 0

    # Measure sizes and filter
    sizes = ndimage.sum(binary, labeled, range(1, n_raw + 1))
    valid_labels = [i + 1 for i, s in enumerate(sizes) if s >= min_size]

    if not valid_labels:
        return np.zeros_like(labeled), 0

    # Re-label valid clusters sorted by descending size
    valid_sizes = [(int(ndimage.sum(binary, labeled, lbl)), lbl) for lbl in valid_labels]
    valid_sizes.sort(key=lambda x: -x[0])

    new_labeled = np.zeros_like(labeled)
    for new_id, (_, old_lbl) in enumerate(valid_sizes, start=1):
        new_labeled[labeled == old_lbl] = new_id

    return new_labeled, len(valid_labels)


def compute_cluster_stats(
    data: np.ndarray,
    labeled: np.ndarray,
    n_clusters: int,
    affine: np.ndarray,
) -> list[dict[str, Any]]:
    """Compute per-cluster statistics including MNI/world coordinates."""
    clusters: list[dict[str, Any]] = []

    for cid in range(1, n_clusters + 1):
        mask = labeled == cid
        vals = data[mask]

        size = int(mask.sum())
        peak_idx_flat = int(np.argmax(np.abs(vals)))
        peak_val = float(vals[peak_idx_flat])
        mean_val = float(vals.mean())

        # Peak voxel coordinates (ijk)
        voxel_coords = np.argwhere(mask)
        abs_vals = np.abs(data[mask])
        peak_vox = voxel_coords[np.argmax(abs_vals)]

        # Center of mass (intensity-weighted)
        com_vox = ndimage.center_of_mass(np.abs(data), labeled, cid)

        # Convert to mm via affine
        def vox_to_mm(ijk: np.ndarray) -> tuple[float, float, float]:
            xyz = affine @ np.array([ijk[0], ijk[1], ijk[2], 1.0])
            return float(xyz[0]), float(xyz[1]), float(xyz[2])

        peak_mm = vox_to_mm(peak_vox)
        com_mm = vox_to_mm(np.array(com_vox))

        # Bounding box (voxel space)
        mins = voxel_coords.min(axis=0)
        maxs = voxel_coords.max(axis=0)

        clusters.append({
            "cluster_id": cid,
            "size_voxels": size,
            "peak_value": round(peak_val, 4),
            "mean_value": round(mean_val, 4),
            "peak_x_mm": round(peak_mm[0], 2),
            "peak_y_mm": round(peak_mm[1], 2),
            "peak_z_mm": round(peak_mm[2], 2),
            "com_x_mm": round(com_mm[0], 2),
            "com_y_mm": round(com_mm[1], 2),
            "com_z_mm": round(com_mm[2], 2),
            "bbox_x0": int(mins[0]),
            "bbox_y0": int(mins[1]),
            "bbox_z0": int(mins[2]),
            "bbox_x1": int(maxs[0]),
            "bbox_y1": int(maxs[1]),
            "bbox_z1": int(maxs[2]),
        })

    return clusters


# ── Visualization ─────────────────────────────────────────────────────────────

def render_cluster_overlay(
    data: np.ndarray,
    thresholded: np.ndarray,
    labeled: np.ndarray,
    affine: np.ndarray,
    out_path: Path,
    colormap: str = "hot",
    n_slices: int = 9,
) -> None:
    """Write a mosaic of axial slices showing the thresholded stat map.

    Background: grayscale brain anatomy (raw data); overlay: cluster values.
    """
    mpl_cmap = _COLORMAPS.get(colormap, "hot")

    # Find slices that contain signal
    signal_mask = thresholded != 0
    z_indices = np.where(signal_mask.any(axis=(0, 1)))[0]

    if len(z_indices) == 0:
        # No signal — write a blank figure with a message
        fig, ax = plt.subplots(1, 1, figsize=(8, 2), facecolor="black")
        ax.text(0.5, 0.5, "No suprathreshold voxels", ha="center", va="center",
                color="white", fontsize=14, transform=ax.transAxes)
        ax.axis("off")
        save_dark_figure(fig, out_path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        return

    # Select representative slices spread across the signal extent
    z_indices = np.linspace(z_indices[0], z_indices[-1], min(n_slices, len(z_indices)), dtype=int)
    z_indices = list(dict.fromkeys(z_indices))  # deduplicate while preserving order

    n = len(z_indices)
    ncols = min(n, 3)
    nrows = (n + ncols - 1) // ncols

    fig, axes = plt.subplots(nrows, ncols, figsize=(ncols * 3.5, nrows * 3.5), facecolor="black")
    if n == 1:
        axes = np.array([[axes]])
    elif nrows == 1:
        axes = axes.reshape(1, -1)

    # Global color range for consistent scale
    nonzero = thresholded[thresholded != 0]
    vmin = float(nonzero.min()) if len(nonzero) > 0 else 0.0
    vmax = float(nonzero.max()) if len(nonzero) > 0 else 1.0
    if vmin == vmax:
        vmax = vmin + 1e-6

    for idx, z in enumerate(z_indices):
        row, col = divmod(idx, ncols)
        ax = axes[row, col]

        bg_slice = data[:, :, z].T
        ov_slice = thresholded[:, :, z].T

        # Background: anatomical (grayscale)
        bg_finite = bg_slice[np.isfinite(bg_slice)]
        bg_min = float(bg_finite.min()) if len(bg_finite) else 0.0
        bg_max = float(bg_finite.max()) if len(bg_finite) else 1.0
        if bg_max == bg_min:
            bg_max = bg_min + 1.0
        ax.imshow(bg_slice, cmap="gray", vmin=bg_min, vmax=bg_max,
                  origin="lower", interpolation="nearest", aspect="equal")

        # Overlay: stat values only where nonzero
        ov_display = np.where(ov_slice != 0, ov_slice, np.nan)
        im = ax.imshow(ov_display, cmap=mpl_cmap, vmin=vmin, vmax=vmax,
                       origin="lower", interpolation="nearest", aspect="equal",
                       alpha=0.75)

        ax.set_title(f"z={z}", color="white", fontsize=8, pad=3)
        ax.axis("off")

    # Hide unused axes
    for idx in range(n, nrows * ncols):
        row, col = divmod(idx, ncols)
        axes[row, col].set_visible(False)

    # Colorbar
    cbar_ax = fig.add_axes([0.92, 0.15, 0.015, 0.7])
    sm = plt.cm.ScalarMappable(cmap=mpl_cmap, norm=mcolors.Normalize(vmin=vmin, vmax=vmax))
    sm.set_array([])
    cbar = fig.colorbar(sm, cax=cbar_ax)
    cbar.ax.tick_params(colors="white", labelsize=7)
    cbar.ax.yaxis.label.set_color("white")

    plt.suptitle("Statistical map clusters", color="white", fontsize=11, y=1.01)
    fig.tight_layout(rect=[0, 0, 0.91, 1.0])
    save_dark_figure(fig, out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)


# ── Exporters ─────────────────────────────────────────────────────────────────

def export_csv(clusters: list[dict[str, Any]], out_path: Path) -> None:
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CLUSTER_CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(clusters)


def export_cluster_json(
    clusters: list[dict[str, Any]],
    metadata: dict[str, Any],
    out_path: Path,
) -> None:
    payload = {
        "schema": "neuroforge-cluster-table-v1",
        "metadata": metadata,
        "clusters": clusters,
    }
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def export_metadata_json(metadata: dict[str, Any], out_path: Path) -> None:
    out_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")


# ── HTML report ───────────────────────────────────────────────────────────────

def _cluster_table_html(clusters: list[dict[str, Any]]) -> str:
    if not clusters:
        return "<p><em>No clusters detected above threshold.</em></p>"

    rows = ""
    for c in clusters:
        rows += (
            f"<tr>"
            f"<td>{c['cluster_id']}</td>"
            f"<td>{c['size_voxels']}</td>"
            f"<td>{c['peak_value']:.3f}</td>"
            f"<td>{c['mean_value']:.3f}</td>"
            f"<td>{c['peak_x_mm']:.1f}</td>"
            f"<td>{c['peak_y_mm']:.1f}</td>"
            f"<td>{c['peak_z_mm']:.1f}</td>"
            f"<td>{c['com_x_mm']:.1f}, {c['com_y_mm']:.1f}, {c['com_z_mm']:.1f}</td>"
            f"</tr>"
        )
    return (
        "<table>"
        "<tr><th>Cluster</th><th>Size</th><th>Peak</th><th>Mean</th>"
        "<th>X (mm)</th><th>Y (mm)</th><th>Z (mm)</th><th>Center of Mass (mm)</th></tr>"
        f"{rows}</table>"
    )


def render_html_report(
    clusters: list[dict[str, Any]],
    metadata: dict[str, Any],
    out_path: Path,
) -> None:
    import scipy
    import matplotlib as _mpl

    n = len(clusters)
    largest = max((c["size_voxels"] for c in clusters), default=0)
    peak = max((abs(c["peak_value"]) for c in clusters), default=0.0)

    table_rows = ([c["cluster_id"], c["size_voxels"], f'{c["peak_value"]:.3f}', f'{c["mean_value"]:.3f}', f'{c["peak_x_mm"]:.1f}', f'{c["peak_y_mm"]:.1f}', f'{c["peak_z_mm"]:.1f}', f'{c["com_x_mm"]:.1f}, {c["com_y_mm"]:.1f}, {c["com_z_mm"]:.1f}'] for c in clusters)
    body = statistics_cards({"Clusters detected": n, "Threshold": metadata.get("threshold", ""), "Direction": metadata.get("direction", ""), "Min cluster size": metadata.get("min_cluster_size", ""), "Largest cluster": largest, "Peak statistic": f"{peak:.3f}"})
    body += "<h2>Cluster overlay</h2>" + figure_block("cluster_overlay.png", "Cluster overlay mosaic", f"Thresholded map; color map {metadata.get('colormap', 'hot')}.")
    body += "<h2>Cluster table</h2>" + info_box("Coordinate conventions", "Clusters are ordered by size. Coordinates are derived from the NIfTI affine in millimetres. Center of mass is intensity weighted.")
    body += warning_box("Descriptive results only", "Cluster values are not corrected for multiple comparisons. No FWE, FDR, or permutation inference was applied.")
    body += data_table(["Cluster", "Size", "Peak", "Mean", "X (mm)", "Y (mm)", "Z (mm)", "Center of mass (mm)"], table_rows) if clusters else "<p class=\"nf-muted\">No clusters detected above threshold.</p>"
    body += methods_block(f"Thresholding used {metadata.get('direction', '')} values at {metadata.get('threshold', '')}. Clusters smaller than {metadata.get('min_cluster_size', '')} voxels were discarded using 6-connectivity in scipy.ndimage {scipy.__version__}. Coordinates used the NIfTI affine with nibabel {metadata.get('nibabel_version', '')}.")
    body += "<h2>Software</h2>" + data_table(["Package", "Version", "Role"], [["nibabel", metadata.get("nibabel_version", ""), "NIfTI I/O"], ["scipy", scipy.__version__, "Connected components"], ["numpy", np.__version__, "Array operations"], ["matplotlib", _mpl.__version__, "Overlay figure"], ["NeuroForge", NEUROFORGE_VERSION, "Orchestration and reporting"]])
    html = document_shell("Cluster Analysis Report", f"Statistical Map Explorer · {metadata.get('input_filename', 'input artifact')}", body, footer_html=footer("No AI-generated scientific interpretation is included."))
    out_path.write_text(html, encoding="utf-8")


# ── Main ──────────────────────────────────────────────────────────────────────

def run(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="neuroforge-statistical-map-explorer",
        description=(
            "Threshold a statistical NIfTI map, detect clusters, compute statistics, "
            "and export a publication-quality report."
        ),
    )
    parser.add_argument("--input-file", required=True,
                        help="Path to the statistical NIfTI file (.nii or .nii.gz).")
    parser.add_argument("--output-dir", required=True,
                        help="Directory to write all output files.")
    parser.add_argument("--threshold", type=float, default=2.3,
                        help="Absolute threshold on the statistic value (default: 2.3).")
    parser.add_argument("--direction", default="positive",
                        choices=["positive", "negative", "two-sided"],
                        help="Threshold direction (default: positive).")
    parser.add_argument("--min-cluster-size", type=int, default=10,
                        help="Minimum cluster size in voxels (default: 10).")
    parser.add_argument("--colormap", default="hot",
                        choices=list(_COLORMAPS.keys()),
                        help="Colormap for the overlay figure (default: hot).")
    args = parser.parse_args(argv)

    t0 = time.monotonic()
    input_path = Path(args.input_file)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        print(f"ERROR: Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # Load image
    img = nib.load(str(input_path))
    if img.ndim not in (3, 4):
        print(f"ERROR: Expected 3D or 4D NIfTI, got shape {img.shape}", file=sys.stderr)
        sys.exit(1)

    raw = np.asarray(img.dataobj, dtype=np.float64)
    if raw.ndim == 4:
        raw = raw[..., 0]  # use first volume only
    raw = np.nan_to_num(raw, nan=0.0, posinf=0.0, neginf=0.0)

    affine = img.affine

    # Threshold
    thresholded = apply_threshold(raw, args.threshold, args.direction)

    # Save thresholded map
    thresholded_img = nib.Nifti1Image(thresholded, affine, img.header)
    nib.save(thresholded_img, str(output_dir / "thresholded_map.nii.gz"))

    # Detect clusters
    labeled, n_clusters = detect_clusters(thresholded, args.min_cluster_size)
    clusters = compute_cluster_stats(raw, labeled, n_clusters, affine)

    # Export cluster table
    export_csv(clusters, output_dir / "cluster_table.csv")

    import datetime
    import scipy
    timestamp = datetime.datetime.utcnow().isoformat() + "Z"
    metadata: dict[str, Any] = {
        "input_file": str(input_path),
        "input_filename": input_path.name,
        "threshold": args.threshold,
        "direction": args.direction,
        "min_cluster_size": args.min_cluster_size,
        "colormap": args.colormap,
        "n_clusters": n_clusters,
        "n_suprathreshold_voxels": int((thresholded != 0).sum()),
        "image_shape": list(raw.shape),
        "voxel_size_mm": [round(float(v), 4) for v in img.header.get_zooms()[:3]],
        "generated_at": timestamp,
        "nibabel_version": nib.__version__,
        "scipy_version": scipy.__version__,
        "neuroforge_version": NEUROFORGE_VERSION,
    }

    export_cluster_json(clusters, metadata, output_dir / "cluster_table.json")
    export_metadata_json(metadata, output_dir / "cluster_metadata.json")

    # Visualization
    render_cluster_overlay(
        raw, thresholded, labeled, affine,
        output_dir / "cluster_overlay.png",
        colormap=args.colormap,
    )

    # HTML report
    render_html_report(clusters, metadata, output_dir / "cluster_report.html")

    runtime = round(time.monotonic() - t0, 2)
    metadata["runtime_seconds"] = runtime
    export_metadata_json(metadata, output_dir / "cluster_metadata.json")

    largest = max((c["size_voxels"] for c in clusters), default=0)
    peak = max((abs(c["peak_value"]) for c in clusters), default=0.0)
    print(
        f"Statistical Map Explorer complete: {input_path.name} | "
        f"threshold={args.threshold} ({args.direction}) | "
        f"{n_clusters} cluster(s) | largest={largest} vox | "
        f"peak={peak:.3f} | runtime={runtime}s"
    )


def main() -> None:
    run(sys.argv[1:])


if __name__ == "__main__":
    main()
