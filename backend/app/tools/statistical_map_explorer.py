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

_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Cluster Report — {dataset_name}</title>
<style>
*,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
html{{font-size:16px}}
body{{font-family:'Helvetica Neue',Arial,sans-serif;color:#1a1a2e;background:#fff;line-height:1.6}}
.page{{max-width:900px;margin:0 auto;padding:48px 40px}}
.cover{{border-bottom:3px solid #5b4fcf;padding-bottom:32px;margin-bottom:40px}}
.cover h1{{font-size:2rem;font-weight:700;color:#1a1a2e;margin-bottom:8px}}
.cover .subtitle{{font-size:1.1rem;color:#5b4fcf;font-weight:500;margin-bottom:24px}}
.cover-meta{{display:flex;gap:24px;flex-wrap:wrap;font-size:.85rem;color:#555}}
.cover-meta span{{display:flex;align-items:center;gap:6px}}
h2{{font-size:1.3rem;font-weight:700;color:#1a1a2e;margin:48px 0 16px;
    padding-bottom:6px;border-bottom:2px solid #e8e8f0}}
h3{{font-size:1.05rem;font-weight:600;color:#333;margin:24px 0 10px}}
table{{width:100%;border-collapse:collapse;font-size:.85rem;margin-top:12px}}
th{{background:#f4f4f8;text-align:left;padding:8px 12px;font-weight:600;
    color:#444;border-bottom:2px solid #ddd}}
td{{padding:7px 12px;border-bottom:1px solid #eee;color:#333;font-family:monospace}}
tr:nth-child(even){{background:#fafafa}}
.stat-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin:16px 0}}
.stat-card{{background:#f8f8fc;border:1px solid #e0e0f0;border-radius:8px;padding:16px}}
.stat-card .val{{font-size:1.6rem;font-weight:700;color:#5b4fcf;font-family:monospace}}
.stat-card .lbl{{font-size:.75rem;color:#777;margin-top:4px}}
.fig{{text-align:center;margin:24px 0}}
.fig img{{max-width:100%;border:1px solid #e8e8f0;border-radius:4px}}
.fig figcaption{{font-size:.8rem;color:#777;margin-top:8px;font-style:italic}}
.info-box{{background:#f0f4ff;border:1px solid #d0d8ff;border-radius:6px;padding:16px;
           font-size:.85rem;color:#444;margin:16px 0}}
.footer{{margin-top:48px;padding-top:16px;border-top:1px solid #eee;
         font-size:.75rem;color:#888}}
@media print{{
  body{{font-size:11pt}}
  .page{{padding:24px}}
  h2{{page-break-before:always}}
  h2:first-of-type{{page-break-before:avoid}}
}}
</style>
</head>
<body>
<div class="page">
<div class="cover">
  <h1>Cluster Analysis Report</h1>
  <div class="subtitle">Statistical Map Explorer</div>
  <div class="cover-meta">
    <span>🗂 {input_filename}</span>
    <span>📅 {generated_at}</span>
    <span>🔬 NeuroForge {neuroforge_version}</span>
  </div>
</div>

<h2>Summary</h2>
<div class="stat-grid">
  <div class="stat-card"><div class="val">{n_clusters}</div><div class="lbl">Clusters detected</div></div>
  <div class="stat-card"><div class="val">{threshold}</div><div class="lbl">Threshold (|z|)</div></div>
  <div class="stat-card"><div class="val">{direction_label}</div><div class="lbl">Direction</div></div>
  <div class="stat-card"><div class="val">{min_cluster_size}</div><div class="lbl">Min cluster size (voxels)</div></div>
  <div class="stat-card"><div class="val">{largest_cluster}</div><div class="lbl">Largest cluster (voxels)</div></div>
  <div class="stat-card"><div class="val">{peak_stat}</div><div class="lbl">Peak statistic</div></div>
</div>

<h2>Cluster Overlay</h2>
<figure class="fig">
  <img src="cluster_overlay.png" alt="Cluster overlay mosaic"/>
  <figcaption>
    Thresholded statistical map overlaid on brain template.
    Threshold = {threshold} · Direction = {direction_label} · Color map = {colormap}
  </figcaption>
</figure>

<h2>Cluster Table</h2>
<div class="info-box">
  Clusters are ordered by size (largest first). Coordinates are in millimetres (mm)
  derived from the NIfTI affine transform. Peak: voxel with the maximum absolute value.
  CoM: intensity-weighted center of mass.
</div>
<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:4px;padding:0.75em 1em;margin:0.75em 0;font-size:.88em;color:#664d03;">
  <strong>&#9888; Descriptive results only.</strong>
  Cluster sizes, peak values, and MNI coordinates reported here are <em>not</em> corrected
  for multiple comparisons. No family-wise error (FWE), false discovery rate (FDR), or
  permutation-based inference was applied. Do not interpret these values as statistically
  significant without applying appropriate correction in your analysis.
</div>
{cluster_table_html}

<h2>Methods</h2>
<p>
  Statistical thresholding was applied at |value| &ge; {threshold} ({direction_label}).
  Contiguous voxel clusters were identified using 6-connectivity (face-adjacent)
  connected-component labelling (scipy.ndimage {scipy_version}).
  Clusters smaller than {min_cluster_size} voxels were discarded.
  Voxel-to-millimetre coordinate conversion used the NIfTI affine matrix
  (nibabel {nibabel_version}).
  No inferential statistics, random field theory, or permutation testing were applied.
</p>

<h2>Software</h2>
<table>
  <tr><th>Package</th><th>Version</th><th>Role</th></tr>
  <tr><td>nibabel</td><td>{nibabel_version}</td><td>NIfTI I/O and affine handling</td></tr>
  <tr><td>scipy</td><td>{scipy_version}</td><td>Connected-component labelling</td></tr>
  <tr><td>numpy</td><td>{numpy_version}</td><td>Array operations</td></tr>
  <tr><td>matplotlib</td><td>{matplotlib_version}</td><td>Cluster overlay figure</td></tr>
  <tr><td>NeuroForge</td><td>{neuroforge_version}</td><td>Orchestration and reporting</td></tr>
</table>

<div class="footer">
  Generated by NeuroForge {neuroforge_version} Statistical Map Explorer.
  No AI-generated scientific interpretation is included.
  All values are derived exclusively from the input NIfTI data.
</div>
</div>
</body>
</html>
"""


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
        fig.savefig(str(out_path), dpi=150, bbox_inches="tight", facecolor="black")
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
    fig.savefig(str(out_path), dpi=150, bbox_inches="tight", facecolor="black")
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

    html = _HTML_TEMPLATE.format(
        dataset_name=metadata.get("input_filename", "unknown"),
        input_filename=metadata.get("input_filename", "unknown"),
        generated_at=metadata.get("generated_at", ""),
        neuroforge_version=NEUROFORGE_VERSION,
        n_clusters=n,
        threshold=metadata.get("threshold", ""),
        direction_label=metadata.get("direction", ""),
        min_cluster_size=metadata.get("min_cluster_size", ""),
        largest_cluster=largest,
        peak_stat=f"{peak:.3f}",
        colormap=metadata.get("colormap", "hot"),
        cluster_table_html=_cluster_table_html(clusters),
        scipy_version=scipy.__version__,
        nibabel_version=metadata.get("nibabel_version", ""),
        numpy_version=np.__version__,
        matplotlib_version=_mpl.__version__,
    )
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
