"""Atlas ROI Extraction native pipeline.

Extracts quantitative per-ROI statistics from any compatible scalar 3D (or
aggregated 4D) NIfTI artifact using an existing NeuroForge atlas.  Designed
to generalise the ROI statistics produced by functional-connectivity to
arbitrary scalar maps: brain masks, skull-stripped T1s, seed connectivity
maps, mean functional images, and future statistical maps.

Read-only — the input NIfTI is never modified.
"""
# ruff: noqa: E402, I001
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import tempfile
from pathlib import Path
from time import perf_counter
from typing import Any

_cache_dir = Path(tempfile.gettempdir()) / "neuroforge-cache"
(_cache_dir / "matplotlib").mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(_cache_dir / "matplotlib"))
os.environ.setdefault("XDG_CACHE_HOME", str(_cache_dir))

import datetime
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.style.use("dark_background")
import nibabel as nib
import numpy as np
import pandas as pd
from nilearn import __version__ as nilearn_version
from nilearn.image import resample_img

# ── Reuse canonical atlas registry from functional_connectivity ────────────────
from app.tools.functional_connectivity import (
    ATLAS_REGISTRY,
    DEFAULT_ATLAS_ID,
    LEGACY_ATLAS_ALIASES,
    LoadedAtlas,
    load_atlas,
    network_from_label,
    normalize_atlas_id,
)

# ── Constants ──────────────────────────────────────────────────────────────────

SUPPORTED_AGGREGATION_MODES = ("none", "temporal_mean")
INTERPOLATION_METHOD = "nearest"  # label-preserving for integer label atlases
OVERLAP_REJECTION_THRESHOLD = 0.05  # reject if < 5 % atlas voxels overlap FOV

# dtype codes considered "binary mask" (uint8, uint16, int8, int16 with [0,1] values)
_BINARY_CANDIDATE_DTYPES = {np.uint8, np.uint16, np.int8, np.int16}


# ── Geometry helpers ───────────────────────────────────────────────────────────

def _affines_close(a: np.ndarray, b: np.ndarray, tol: float = 0.01) -> bool:
    return bool(np.allclose(a, b, atol=tol))


def _shapes_match(s1: tuple, s2: tuple) -> bool:
    return tuple(s1[:3]) == tuple(s2[:3])


def _compute_overlap_fraction(atlas_img: nib.Nifti1Image, img: nib.Nifti1Image) -> float:
    """Fraction of non-background atlas voxels whose centres fall inside `img`'s FOV.

    Resamples a binary FOV mask of the image into atlas space, then counts atlas
    label voxels that are covered.  Always returns a value in [0, 1] regardless
    of the relative voxel sizes of atlas and image.
    """
    from nilearn.image.resampling import BoundingBoxError

    atlas_data = np.asanyarray(atlas_img.dataobj)
    total_atlas_vox = int(np.count_nonzero(atlas_data))
    if total_atlas_vox == 0:
        return 0.0

    img_data = np.asanyarray(img.dataobj)
    fov_mask = np.isfinite(img_data).astype(np.float32)
    fov_img = nib.Nifti1Image(fov_mask, img.affine)
    try:
        fov_in_atlas = resample_img(
            fov_img,
            target_affine=atlas_img.affine,
            target_shape=atlas_img.shape[:3],
            interpolation="nearest",
            fill_value=0,
        )
    except BoundingBoxError:
        # Image FOV and atlas have zero spatial overlap
        return 0.0

    fov_data = np.asanyarray(fov_in_atlas.dataobj)
    overlapping = int(np.sum((atlas_data != 0) & (fov_data > 0)))
    return overlapping / total_atlas_vox


def check_geometry(
    img: nib.Nifti1Image,
    atlas_img: nib.Nifti1Image,
) -> dict[str, Any]:
    """Return geometry metadata and whether resampling is required."""
    img_shape = img.shape[:3]
    atlas_shape = atlas_img.shape[:3]
    img_zooms = np.abs(np.diag(img.affine)[:3]).round(4).tolist()
    atlas_zooms = np.abs(np.diag(atlas_img.affine)[:3]).round(4).tolist()

    same_affine = _affines_close(img.affine, atlas_img.affine)
    same_shape = _shapes_match(img_shape, atlas_shape)
    needs_resample = not (same_affine and same_shape)

    return {
        "image_shape": list(img_shape),
        "image_voxel_spacing_mm": img_zooms,
        "image_affine": img.affine.tolist(),
        "atlas_shape": list(atlas_shape),
        "atlas_voxel_spacing_mm": atlas_zooms,
        "atlas_affine": atlas_img.affine.tolist(),
        "affines_match": same_affine,
        "shapes_match": same_shape,
        "resampling_required": needs_resample,
    }


# ── Aggregation ───────────────────────────────────────────────────────────────

def _aggregate_4d(data: np.ndarray, mode: str) -> np.ndarray:
    if mode == "temporal_mean":
        return data.mean(axis=3)
    raise ValueError(f"Unsupported aggregation mode '{mode}'.")


# ── Binary mask detection ──────────────────────────────────────────────────────

def _is_binary_mask(data: np.ndarray) -> bool:
    """True when all non-NaN values are exactly 0 or 1."""
    flat = data.ravel()
    finite = flat[np.isfinite(flat)]
    if finite.size == 0:
        return False
    unique = np.unique(finite)
    return set(unique.tolist()).issubset({0.0, 1.0})


# ── Per-ROI statistics ─────────────────────────────────────────────────────────

def _roi_stats(
    scalar_data: np.ndarray,
    atlas_data: np.ndarray,
    label_value: int,
    roi_number: int,
    roi_label: str,
    is_binary: bool,
) -> dict[str, Any]:
    mask = atlas_data == label_value
    voxel_count = int(np.sum(mask))
    if voxel_count == 0:
        return {
            "roi_number": roi_number,
            "roi_label": roi_label,
            "network": network_from_label(roi_label),
            "voxel_count": 0,
            "nonzero_voxel_count": 0,
            "coverage_pct": 0.0,
            "mean": None,
            "median": None,
            "std": None,
            "min": None,
            "max": None,
            "p5": None,
            "p95": None,
            "nan_count": 0,
            "inf_count": 0,
            **({"overlap_voxel_count": 0, "roi_occupancy_pct": 0.0} if is_binary else {}),
        }

    roi_vals = scalar_data[mask]
    nan_count = int(np.sum(np.isnan(roi_vals)))
    inf_count = int(np.sum(np.isinf(roi_vals)))
    nonzero_count = int(np.sum(roi_vals != 0))
    coverage_pct = round(nonzero_count / voxel_count * 100, 4)

    valid = roi_vals[np.isfinite(roi_vals)]
    if valid.size == 0:
        row: dict[str, Any] = {
            "roi_number": roi_number,
            "roi_label": roi_label,
            "network": network_from_label(roi_label),
            "voxel_count": voxel_count,
            "nonzero_voxel_count": nonzero_count,
            "coverage_pct": coverage_pct,
            "mean": None, "median": None, "std": None,
            "min": None, "max": None, "p5": None, "p95": None,
            "nan_count": nan_count,
            "inf_count": inf_count,
        }
    else:
        row = {
            "roi_number": roi_number,
            "roi_label": roi_label,
            "network": network_from_label(roi_label),
            "voxel_count": voxel_count,
            "nonzero_voxel_count": nonzero_count,
            "coverage_pct": coverage_pct,
            "mean": float(np.mean(valid)),
            "median": float(np.median(valid)),
            "std": float(np.std(valid, ddof=1)) if valid.size > 1 else 0.0,
            "min": float(np.min(valid)),
            "max": float(np.max(valid)),
            "p5": float(np.percentile(valid, 5)),
            "p95": float(np.percentile(valid, 95)),
            "nan_count": nan_count,
            "inf_count": inf_count,
        }

    if is_binary:
        overlap = int(np.sum((scalar_data == 1) & mask))
        row["overlap_voxel_count"] = overlap
        row["roi_occupancy_pct"] = round(overlap / voxel_count * 100, 4)

    return row


def extract_all_rois(
    scalar_data: np.ndarray,
    atlas_data: np.ndarray,
    roi_labels: list[str],
    label_values: list[int],
    is_binary: bool,
) -> list[dict[str, Any]]:
    rows = []
    for idx, (label, lval) in enumerate(zip(roi_labels, label_values)):
        rows.append(
            _roi_stats(
                scalar_data=scalar_data,
                atlas_data=atlas_data,
                label_value=lval,
                roi_number=idx + 1,
                roi_label=label,
                is_binary=is_binary,
            )
        )
    return rows


# ── Outputs ────────────────────────────────────────────────────────────────────

def _write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    pd.DataFrame(rows).to_csv(path, index=False)


def _write_json(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps(rows, indent=2), encoding="utf-8")


def _write_metadata(path: Path, metadata: dict[str, Any]) -> None:
    path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")


def _write_html_report(path: Path, metadata: dict[str, Any], rows: list[dict[str, Any]]) -> None:
    atlas_name = metadata.get("atlas_display_name", metadata.get("atlas_id", "—"))
    n_rois = metadata.get("n_rois", len(rows))
    source_path = metadata.get("input_path", "—")
    resamp_note = (
        "<p><strong>Note:</strong> Atlas was resampled to image space using"
        " nearest-neighbour interpolation to match spatial geometry.</p>"
        if metadata.get("resampling_performed")
        else ""
    )

    def _safe(v: object) -> str:
        if v is None:
            return "—"
        if isinstance(v, float):
            return f"{v:.4f}"
        return html.escape(str(v))

    meta_rows = "".join(
        f"<tr><th>{html.escape(str(k))}</th><td>{_safe(v)}</td></tr>"
        for k, v in metadata.items()
        if k not in {"atlas_labels", "output_checksums", "atlas_affine", "image_affine"}
    )

    col_keys = [
        "roi_number", "roi_label", "network", "voxel_count",
        "nonzero_voxel_count", "coverage_pct",
        "mean", "median", "std", "min", "max", "p5", "p95",
        "nan_count", "inf_count",
    ]
    if rows and "overlap_voxel_count" in rows[0]:
        col_keys += ["overlap_voxel_count", "roi_occupancy_pct"]

    header_cells = "".join(f"<th>{html.escape(k)}</th>" for k in col_keys)
    data_rows_html = ""
    for row in rows:
        cells = "".join(f"<td>{_safe(row.get(k))}</td>" for k in col_keys)
        data_rows_html += f"<tr>{cells}</tr>"

    report = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Atlas ROI Extraction Report</title>
  <style>
    body {{font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           margin: 2rem; color: #111827; background: #fff;}}
    h1 {{font-size: 1.4rem; color: #1e3a5f;}}
    h2 {{font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #e5e7eb; padding-bottom: .3rem;}}
    table {{border-collapse: collapse; width: 100%; font-size: .82rem; margin-top: .8rem;}}
    th, td {{border: 1px solid #d1d5db; padding: .3rem .5rem; text-align: left;}}
    th {{background: #f3f4f6; font-weight: 600;}}
    tr:nth-child(even) {{background: #f9fafb;}}
    .chip {{display:inline-block;padding:.1rem .5rem;border-radius:9999px;
            font-size:.75rem;background:#dbeafe;color:#1e40af;margin:.1rem;}}
    .warn {{background:#fef9c3;color:#92400e;}}
    .note {{background:#f0fdf4;color:#166534;padding:.5rem .8rem;
            border-left:3px solid #86efac;margin:1rem 0;font-size:.9rem;}}
  </style>
</head>
<body>
<h1>Atlas ROI Extraction Report</h1>
<p><strong>Input:</strong> <code>{html.escape(str(source_path))}</code></p>
<p><strong>Atlas:</strong> <span class="chip">{html.escape(atlas_name)}</span>
   <span class="chip">{n_rois} ROIs</span></p>
{resamp_note}
<div class="note">Generated by NeuroForge · nibabel {html.escape(metadata.get("nibabel_version","?"))} · nilearn {html.escape(metadata.get("nilearn_version","?"))}</div>

<h2>Run Metadata</h2>
<table><tbody>{meta_rows}</tbody></table>

<h2>ROI Statistics ({n_rois} regions)</h2>
<table>
  <thead><tr>{header_cells}</tr></thead>
  <tbody>{data_rows_html}</tbody>
</table>
</body>
</html>"""
    path.write_text(report, encoding="utf-8")


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()[:16]


# ── Main entry ─────────────────────────────────────────────────────────────────

def run(argv: list[str]) -> int:
    t0 = perf_counter()

    parser = argparse.ArgumentParser(description="Atlas ROI Extraction")
    parser.add_argument("--input-file", required=True, help="Path to input NIfTI file")
    parser.add_argument(
        "--atlas",
        default=DEFAULT_ATLAS_ID,
        choices=sorted(set(list(ATLAS_REGISTRY.keys()) + list(LEGACY_ATLAS_ALIASES.keys()))),
        help=f"Atlas ID (default: {DEFAULT_ATLAS_ID})",
    )
    parser.add_argument(
        "--aggregation-mode",
        default="none",
        choices=SUPPORTED_AGGREGATION_MODES,
        help="How to collapse 4D data before extraction (default: none)",
    )
    parser.add_argument("--output-dir", default="{output_dir}", help="Output directory")
    args = parser.parse_args(argv)

    input_path = Path(args.input_file)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    atlas_id = normalize_atlas_id(args.atlas)
    aggregation_mode: str = args.aggregation_mode

    # ── Load input ─────────────────────────────────────────────────────────────
    print(f"[neuroforge] Loading input: {input_path}")
    try:
        img: nib.Nifti1Image = nib.load(str(input_path))
    except Exception as exc:
        raise ValueError(f"Cannot load NIfTI file '{input_path}': {exc}") from exc

    ndim = len(img.shape)
    if ndim < 3:
        raise ValueError(f"Input has {ndim} dimensions; expected 3D or 4D NIfTI.")
    if ndim > 4:
        raise ValueError(f"Input has {ndim} dimensions; only 3D and 4D are supported.")

    if ndim == 4 and aggregation_mode == "none":
        raise ValueError(
            f"Input is 4D ({img.shape}). Set --aggregation-mode temporal_mean "
            "to compute the temporal mean before ROI extraction, or supply a 3D scalar map."
        )

    data = np.asanyarray(img.dataobj)
    if ndim == 4:
        print(f"[neuroforge] 4D input detected ({img.shape}); applying '{aggregation_mode}' aggregation.")
        data = _aggregate_4d(data, aggregation_mode)

    is_binary = _is_binary_mask(data)
    print(f"[neuroforge] Image shape: {img.shape[:3]}, binary_mask={is_binary}")

    # ── Load atlas ─────────────────────────────────────────────────────────────
    print(f"[neuroforge] Loading atlas: {atlas_id}")
    data_dir = str(_cache_dir / "nilearn_data")
    loaded: LoadedAtlas = load_atlas(atlas_id, data_dir)
    atlas_img: nib.Nifti1Image = nib.load(loaded.labels_img)

    # ── Geometry check ─────────────────────────────────────────────────────────
    geo = check_geometry(img, atlas_img)

    overlap_frac = _compute_overlap_fraction(atlas_img, img)
    if overlap_frac < OVERLAP_REJECTION_THRESHOLD:
        raise ValueError(
            f"Only {overlap_frac*100:.1f}% of atlas voxels overlap the input image's "
            "field of view. The images appear to be from different spaces or badly "
            "misaligned. Atlas ROI extraction aborted."
        )

    # ── Resample atlas if needed ───────────────────────────────────────────────
    resampling_performed = geo["resampling_required"]
    resampled_atlas_path: Path | None = None

    if resampling_performed:
        print(
            f"[neuroforge] Resampling atlas from {tuple(geo['atlas_shape'])} to "
            f"{tuple(geo['image_shape'])} using nearest-neighbour interpolation."
        )
        atlas_img_resampled = resample_img(
            atlas_img,
            target_affine=img.affine,
            target_shape=img.shape[:3],
            interpolation=INTERPOLATION_METHOD,
            fill_value=0,
        )
        resampled_atlas_path = output_dir / "atlas_resampled.nii.gz"
        nib.save(atlas_img_resampled, str(resampled_atlas_path))
        print(f"[neuroforge] Saved resampled atlas: {resampled_atlas_path}")
    else:
        atlas_img_resampled = atlas_img

    atlas_data = np.asanyarray(atlas_img_resampled.dataobj)

    # ── Extract ROI statistics ─────────────────────────────────────────────────
    print(
        f"[neuroforge] Extracting {len(loaded.roi_labels)} ROIs from "
        f"'{loaded.spec.display_name}' atlas."
    )
    rows = extract_all_rois(
        scalar_data=data,
        atlas_data=atlas_data,
        roi_labels=loaded.roi_labels,
        label_values=loaded.label_values,
        is_binary=is_binary,
    )

    n_rois_with_voxels = sum(1 for r in rows if r["voxel_count"] > 0)
    print(f"[neuroforge] {n_rois_with_voxels}/{len(rows)} ROIs have voxels in image space.")

    # ── Write outputs ──────────────────────────────────────────────────────────
    csv_path = output_dir / "roi_extraction.csv"
    json_path = output_dir / "roi_extraction.json"
    meta_path = output_dir / "roi_extraction_metadata.json"
    html_path = output_dir / "roi_extraction_report.html"

    _write_csv(csv_path, rows)
    _write_json(json_path, rows)

    checksums: dict[str, str] = {
        "roi_extraction.csv": _file_sha256(csv_path),
        "roi_extraction.json": _file_sha256(json_path),
    }
    if resampled_atlas_path:
        checksums["atlas_resampled.nii.gz"] = _file_sha256(resampled_atlas_path)

    h = nib.load(str(input_path)).header
    try:
        qform_code = int(h.get("qform_code", 0))
        sform_code = int(h.get("sform_code", 0))
        header_hash = _file_sha256(input_path)
    except Exception:
        qform_code = sform_code = 0
        header_hash = "unavailable"

    metadata: dict[str, Any] = {
        # provenance
        "input_path": str(input_path),
        "input_filename": input_path.name,
        "input_shape": list(img.shape),
        "input_ndim": ndim,
        "qform_code": qform_code,
        "sform_code": sform_code,
        "header_hash": header_hash,
        # atlas
        "atlas_id": atlas_id,
        "atlas_display_name": loaded.spec.display_name,
        "atlas_space": loaded.spec.space,
        "atlas_resolution": loaded.spec.resolution,
        "atlas_citation": loaded.spec.citation,
        "atlas_source": loaded.spec.source,
        "atlas_type": loaded.spec.atlas_type,
        "atlas_version": loaded.version,
        "atlas_labels": loaded.roi_labels,
        # geometry
        "image_shape": geo["image_shape"],
        "image_voxel_spacing_mm": geo["image_voxel_spacing_mm"],
        "atlas_shape": geo["atlas_shape"],
        "atlas_voxel_spacing_mm": geo["atlas_voxel_spacing_mm"],
        "resampling_performed": resampling_performed,
        "interpolation_method": INTERPOLATION_METHOD if resampling_performed else "none",
        "atlas_fov_overlap_pct": round(overlap_frac * 100, 2),
        # analysis
        "n_rois": len(rows),
        "n_rois_with_voxels": n_rois_with_voxels,
        "aggregation_mode": aggregation_mode,
        "is_binary_mask": is_binary,
        # software
        "nibabel_version": nib.__version__,
        "nilearn_version": nilearn_version,
        "numpy_version": np.__version__,
        # outputs
        "output_checksums": checksums,
        "runtime_seconds": round(perf_counter() - t0, 2),
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }

    _write_metadata(meta_path, metadata)
    _write_html_report(html_path, metadata, rows)

    checksums["roi_extraction_metadata.json"] = _file_sha256(meta_path)
    checksums["roi_extraction_report.html"] = _file_sha256(html_path)

    print(
        f"ROI Extraction complete: {input_path.name} | atlas={loaded.spec.display_name} "
        f"| {n_rois_with_voxels}/{len(rows)} ROIs | "
        f"resamp={resampling_performed} | runtime={perf_counter()-t0:.1f}s"
    )
    return 0


def main() -> None:
    import sys
    sys.exit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()
