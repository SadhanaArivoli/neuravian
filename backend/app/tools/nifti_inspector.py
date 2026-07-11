"""NIfTI Inspector — universal header and image QC tool.

Reads any NIfTI-1 or NIfTI-2 file with nibabel and produces:
  - nifti_inspector.json  : full metadata, stats, warnings, provenance
  - nifti_histogram.png   : intensity histogram
  - nifti_report.html     : self-contained HTML summary

No preprocessing, no registration, no segmentation — read-only QC only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

# ── Matplotlib env setup (before import) ──────────────────────────────────────
_cache_dir = Path(tempfile.gettempdir()) / "neuroforge-cache"
(_cache_dir / "matplotlib").mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(_cache_dir / "matplotlib"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import nibabel as nib
import numpy as np

# ── Constants ─────────────────────────────────────────────────────────────────

_NIFTI_DTYPES = {
    0: "unknown", 1: "binary", 2: "uint8", 4: "int16", 8: "int32",
    16: "float32", 32: "complex64", 64: "float64", 128: "rgb24",
    256: "int8", 512: "uint16", 768: "uint32", 1024: "int64",
    1280: "uint64", 1536: "float128", 1792: "complex128", 2048: "complex256",
    2304: "rgba32",
}

_INTENT_CODES = {
    0: "none", 2: "correlation", 3: "t-test", 4: "f-test",
    5: "z-score", 6: "chi2", 7: "beta", 8: "binomial",
    9: "gamma", 10: "poisson", 11: "normal", 1002: "label",
    1003: "neuronames", 1007: "connectivity dense", 2001: "time series",
    2003: "node indices", 2005: "pointset", 2006: "triangle",
    2010: "vector", 2011: "pointset", 2015: "NIFTI_INTENT_ZSCORE",
}

_NIFTI_VERSIONS = {1: "NIfTI-1", 2: "NIfTI-2"}

# NIfTI orientation codes
_FORM_CODES = {0: "unknown", 1: "scanner", 2: "aligned", 3: "talairach", 4: "mni152"}


# ── Header parsing ─────────────────────────────────────────────────────────────

def _parse_header(img: nib.Nifti1Image | nib.Nifti2Image) -> dict[str, Any]:
    hdr = img.header
    shape = img.shape
    ndim = len(shape)

    dims = list(shape[:3])
    n_volumes = int(shape[3]) if ndim >= 4 else 1
    zooms = list(hdr.get_zooms())
    voxel_spacing = zooms[:3] if len(zooms) >= 3 else zooms

    datatype_code = int(hdr["datatype"]) if hasattr(hdr, "__getitem__") else 0
    datatype_name = _NIFTI_DTYPES.get(datatype_code, f"code_{datatype_code}")
    bitpix = int(hdr.get_data_shape()[0]) if False else int(getattr(hdr, "get_data_dtype", lambda: np.dtype("f4"))().itemsize * 8)

    tr = None
    if ndim >= 4 and len(zooms) >= 4:
        tr_val = float(zooms[3])
        if tr_val > 0:
            tr = tr_val

    # endianness from dtype
    dtype = np.dtype(hdr.get_data_dtype())
    if dtype.byteorder in ("<", "=", "|"):
        endianness = "little"
    elif dtype.byteorder == ">":
        endianness = "big"
    else:
        endianness = "native"

    # intent
    try:
        intent_code = int(hdr["intent_code"])
    except Exception:
        intent_code = 0
    intent_name = _INTENT_CODES.get(intent_code, f"code_{intent_code}")

    # qform / sform
    try:
        qform_code = int(hdr["qform_code"])
        sform_code = int(hdr["sform_code"])
    except Exception:
        qform_code = 0
        sform_code = 0

    # orientation
    try:
        ornt = nib.orientations.aff2axcodes(img.affine)
        orientation = "".join(ornt)
    except Exception:
        orientation = "unknown"

    # affine / qform / sform as nested lists
    affine = img.affine.tolist()
    try:
        qform_matrix = hdr.get_qform().tolist()
    except Exception:
        qform_matrix = None
    try:
        sform_matrix = hdr.get_sform().tolist()
    except Exception:
        sform_matrix = None

    version_int = 2 if isinstance(hdr, nib.nifti2.Nifti2Header) else 1
    version_name = _NIFTI_VERSIONS.get(version_int, "NIfTI-1")

    total_voxels = int(np.prod(shape))

    return {
        "dimensions": dims,
        "n_volumes": n_volumes,
        "voxel_spacing_mm": [round(float(v), 6) for v in voxel_spacing],
        "tr_seconds": round(float(tr), 6) if tr is not None else None,
        "datatype": datatype_name,
        "datatype_code": datatype_code,
        "bitpix": bitpix,
        "endianness": endianness,
        "intent_code": intent_code,
        "intent_name": intent_name,
        "qform_code": qform_code,
        "qform_name": _FORM_CODES.get(qform_code, f"code_{qform_code}"),
        "sform_code": sform_code,
        "sform_name": _FORM_CODES.get(sform_code, f"code_{sform_code}"),
        "orientation": orientation,
        "header_version": version_name,
        "voxel_count": total_voxels,
        "affine": affine,
        "qform": qform_matrix,
        "sform": sform_matrix,
    }


# ── Stats ─────────────────────────────────────────────────────────────────────

def _compute_stats(
    data: np.ndarray,
    n_bins: int = 64,
) -> dict[str, Any]:
    flat = data.ravel()
    total = flat.size

    nan_count = int(np.sum(np.isnan(flat)))
    inf_count = int(np.sum(np.isinf(flat)))

    # Work with finite values for stats
    finite = flat[np.isfinite(flat)]
    nonzero = finite[finite != 0]

    if finite.size == 0:
        return {
            "min": None, "max": None, "mean": None, "median": None, "std": None,
            "p5": None, "p25": None, "p75": None, "p95": None,
            "dynamic_range": None,
            "nonzero_count": 0, "nonzero_pct": 0.0,
            "nan_count": nan_count, "inf_count": inf_count,
            "background_pct": 100.0, "mask_coverage_pct": 0.0,
            "histogram_bins": [], "histogram_counts": [],
        }

    vmin = float(np.min(finite))
    vmax = float(np.max(finite))
    vmean = float(np.mean(finite))
    vmedian = float(np.median(finite))
    vstd = float(np.std(finite))
    p5, p25, p75, p95 = [float(v) for v in np.percentile(finite, [5, 25, 75, 95])]
    dynamic_range = (vmax - vmin) if (vmax - vmin) > 0 else 0.0

    nonzero_count = int(nonzero.size)
    nonzero_pct = round(100.0 * nonzero_count / total, 4)
    background_pct = round(100.0 - nonzero_pct, 4)

    # Histogram (exclude NaN/inf, use ~robust range)
    hist_min = p5
    hist_max = p95
    if hist_min >= hist_max:
        hist_min = vmin
        hist_max = vmax
    # When all values are identical, use a single bin to avoid zero-range error
    actual_bins = 1 if hist_min >= hist_max else n_bins
    if hist_min >= hist_max:
        hist_min = vmin - 0.5
        hist_max = vmax + 0.5

    hist_data = finite[(finite >= hist_min) & (finite <= hist_max)]
    counts, edges = np.histogram(hist_data, bins=actual_bins, range=(hist_min, hist_max))
    bin_centers = ((edges[:-1] + edges[1:]) / 2).tolist()

    return {
        "min": round(vmin, 8),
        "max": round(vmax, 8),
        "mean": round(vmean, 8),
        "median": round(vmedian, 8),
        "std": round(vstd, 8),
        "p5": round(p5, 8),
        "p25": round(p25, 8),
        "p75": round(p75, 8),
        "p95": round(p95, 8),
        "dynamic_range": round(dynamic_range, 8),
        "nonzero_count": nonzero_count,
        "nonzero_pct": nonzero_pct,
        "nan_count": nan_count,
        "inf_count": inf_count,
        "background_pct": background_pct,
        "mask_coverage_pct": nonzero_pct,
        "histogram_bins": [round(b, 8) for b in bin_centers],
        "histogram_counts": counts.tolist(),
    }


# ── Warning detection ──────────────────────────────────────────────────────────

def _detect_warnings(
    header: dict[str, Any],
    stats: dict[str, Any],
) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []

    if stats["nan_count"] > 0:
        warnings.append({
            "code": "nan_detected",
            "severity": "error",
            "message": f"{stats['nan_count']:,} NaN voxels detected. These voxels have no meaningful value and will be excluded from most analyses.",
        })

    if stats["inf_count"] > 0:
        warnings.append({
            "code": "inf_detected",
            "severity": "error",
            "message": f"{stats['inf_count']:,} Inf voxels detected. Check the source pipeline for numerical issues.",
        })

    dims = header.get("dimensions", [])
    if any(d == 0 for d in dims):
        warnings.append({
            "code": "zero_dimension",
            "severity": "error",
            "message": f"One or more spatial dimensions is zero: {dims}. The image may be empty or corrupted.",
        })

    qfc = header.get("qform_code", 0)
    sfc = header.get("sform_code", 0)
    if qfc > 0 and sfc > 0 and qfc != sfc:
        warnings.append({
            "code": "qform_sform_mismatch",
            "severity": "warning",
            "message": (
                f"qform_code ({qfc}, '{header.get('qform_name')}') and "
                f"sform_code ({sfc}, '{header.get('sform_name')}') differ. "
                "Some tools use qform only, others prefer sform. This can cause spatial misregistration."
            ),
        })

    dr = stats.get("dynamic_range")
    if dr is not None and dr < 1e-9 and stats.get("nonzero_count", 0) > 0:
        warnings.append({
            "code": "zero_dynamic_range",
            "severity": "warning",
            "message": "Dynamic range is effectively zero — all voxels have the same value. The image may be constant or incorrectly generated.",
        })

    if stats.get("nonzero_count", 1) == 0:
        warnings.append({
            "code": "empty_mask",
            "severity": "error",
            "message": "All voxels are zero. If this is a mask, it is empty and will exclude all voxels from analysis.",
        })

    dt = header.get("datatype", "")
    if dt in ("unknown", "binary") and header.get("datatype_code", 0) not in (1, 0):
        warnings.append({
            "code": "unexpected_datatype",
            "severity": "warning",
            "message": f"Unexpected datatype '{dt}'. Most standard neuroimaging tools expect float32, float64, int16, or uint8.",
        })

    if qfc == 0 and sfc == 0:
        warnings.append({
            "code": "no_orientation",
            "severity": "warning",
            "message": "Both qform_code and sform_code are 0. The image has no orientation metadata. Spatial registration may be unreliable.",
        })

    return warnings


# ── Histogram PNG ──────────────────────────────────────────────────────────────

def _write_histogram(
    stats: dict[str, Any],
    output_path: Path,
    title: str,
) -> None:
    bins = stats.get("histogram_bins", [])
    counts = stats.get("histogram_counts", [])
    if not bins or not counts:
        return

    fig, ax = plt.subplots(figsize=(8, 4))
    ax.bar(bins, counts, width=(bins[1] - bins[0]) if len(bins) > 1 else 1.0,
           color="#4f83cc", alpha=0.85, linewidth=0)
    ax.set_xlabel("Intensity")
    ax.set_ylabel("Voxel count")
    ax.set_title(title, fontsize=10)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    # Annotate mean and median
    mean = stats.get("mean")
    median = stats.get("median")
    if mean is not None:
        ax.axvline(mean, color="#e74c3c", linewidth=1.5, linestyle="--", label=f"mean={mean:.3g}")
    if median is not None:
        ax.axvline(median, color="#27ae60", linewidth=1.5, linestyle=":", label=f"median={median:.3g}")
    if mean is not None or median is not None:
        ax.legend(fontsize=8)

    plt.tight_layout()
    plt.savefig(output_path, dpi=120, bbox_inches="tight")
    plt.close(fig)


# ── HTML report ────────────────────────────────────────────────────────────────

def _write_html_report(
    output_path: Path,
    result: dict[str, Any],
) -> None:
    hdr = result["header"]
    stats = result["stats"]
    warnings = result["warnings"]
    provenance = result["provenance"]

    def fmt(v: Any, decimals: int = 4) -> str:
        if v is None:
            return "n/a"
        if isinstance(v, float):
            return f"{v:.{decimals}g}"
        return str(v)

    def severity_color(s: str) -> str:
        return {"error": "#dc2626", "warning": "#d97706"}.get(s, "#374151")

    warn_html = ""
    if warnings:
        items = "".join(
            f"""<li style="color:{severity_color(w['severity'])};margin:4px 0">
                <strong>{w['severity'].upper()}</strong>: {w['message']}
               </li>"""
            for w in warnings
        )
        warn_html = f"""
        <div style="background:#fef9c3;border:1px solid #fde047;padding:12px 16px;
                    border-radius:6px;margin-bottom:20px">
          <strong>Warnings ({len(warnings)})</strong>
          <ul style="margin:8px 0 0 18px;padding:0">{items}</ul>
        </div>"""
    else:
        warn_html = '<div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:10px 14px;border-radius:6px;margin-bottom:20px;color:#166534"><strong>✓ No warnings detected</strong></div>'

    def header_row(label: str, value: Any) -> str:
        return f"<tr><th style='text-align:left;padding:5px 10px;background:#f8fafc'>{label}</th><td style='padding:5px 10px;font-family:monospace'>{fmt(value)}</td></tr>"

    header_table = "".join([
        header_row("Dimensions", hdr.get("dimensions")),
        header_row("Volumes", hdr.get("n_volumes")),
        header_row("Voxel spacing (mm)", hdr.get("voxel_spacing_mm")),
        header_row("TR (seconds)", hdr.get("tr_seconds")),
        header_row("Datatype", f"{hdr.get('datatype')} (code {hdr.get('datatype_code')}, {hdr.get('bitpix')}bit)"),
        header_row("Endianness", hdr.get("endianness")),
        header_row("Orientation", hdr.get("orientation")),
        header_row("qform", f"{hdr.get('qform_code')} ({hdr.get('qform_name')})"),
        header_row("sform", f"{hdr.get('sform_code')} ({hdr.get('sform_name')})"),
        header_row("Intent", f"{hdr.get('intent_name')} (code {hdr.get('intent_code')})"),
        header_row("NIfTI version", hdr.get("header_version")),
        header_row("Total voxels", f"{hdr.get('voxel_count', 0):,}"),
    ])

    def stats_row(label: str, value: Any, decimals: int = 4) -> str:
        return f"<tr><th style='text-align:left;padding:5px 10px;background:#f8fafc'>{label}</th><td style='padding:5px 10px;font-family:monospace'>{fmt(value, decimals)}</td></tr>"

    stats_table = "".join([
        stats_row("Min", stats.get("min")),
        stats_row("Max", stats.get("max")),
        stats_row("Mean", stats.get("mean")),
        stats_row("Median", stats.get("median")),
        stats_row("Std dev", stats.get("std")),
        stats_row("5th percentile", stats.get("p5")),
        stats_row("95th percentile", stats.get("p95")),
        stats_row("Dynamic range", stats.get("dynamic_range")),
        stats_row("Non-zero voxels", f"{stats.get('nonzero_count', 0):,} ({stats.get('nonzero_pct', 0):.2f}%)" if stats.get('nonzero_count') is not None else "n/a", 0),
        stats_row("Background", f"{stats.get('background_pct', 0):.2f}%"),
        stats_row("NaN count", stats.get("nan_count", 0), 0),
        stats_row("Inf count", stats.get("inf_count", 0), 0),
    ])

    input_file = result.get("input_file", "unknown")
    file_size = result.get("file_size_bytes", 0)
    file_size_fmt = f"{file_size / 1024:.1f} KB" if file_size < 1024 * 1024 else f"{file_size / 1024 / 1024:.2f} MB"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>NIfTI Inspector Report</title>
  <style>
    body{{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#1f2937}}
    h1{{font-size:1.4rem;border-bottom:2px solid #e5e7eb;padding-bottom:10px}}
    h2{{font-size:1.05rem;color:#374151;margin-top:28px}}
    table{{border-collapse:collapse;width:100%;margin-bottom:16px}}
    th{{font-weight:600}}
    td,th{{border-top:1px solid #e5e7eb}}
    img{{max-width:100%;border:1px solid #e5e7eb;border-radius:6px;margin-top:8px}}
    code{{background:#f3f4f6;padding:1px 5px;border-radius:3px;font-size:13px}}
  </style>
</head>
<body>
  <h1>NIfTI Inspector Report</h1>
  <p style="color:#6b7280;font-size:13px;margin-bottom:16px">
    <strong>File:</strong> <code>{input_file}</code><br/>
    <strong>Size:</strong> {file_size_fmt} &nbsp;&nbsp;
    <strong>nibabel:</strong> {provenance.get('nibabel_version', '?')} &nbsp;&nbsp;
    <strong>Header hash:</strong> <code>{provenance.get('header_hash', '?')[:16]}…</code>
  </p>

  {warn_html}

  <h2>Header metadata</h2>
  <table>{header_table}</table>

  <h2>Image statistics</h2>
  <table>{stats_table}</table>

  <h2>Intensity histogram</h2>
  <img src="nifti_histogram.png" alt="Intensity histogram" />

  <p style="color:#9ca3af;font-size:11px;margin-top:32px">
    Generated by NeuroForge NIfTI Inspector. Read-only analysis — no data were modified.
    Histogram excludes voxels outside the 5th–95th percentile range for clarity.
  </p>
</body>
</html>"""
    output_path.write_text(html)


# ── Entry point ────────────────────────────────────────────────────────────────

def run(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="neuroforge-nifti-inspector",
        description="Inspect a NIfTI file: parse header, compute image QC stats, write report.",
    )
    parser.add_argument("--input-file", required=True, help="Path to the NIfTI file (.nii or .nii.gz)")
    parser.add_argument("--output-dir", required=True, help="Directory to write outputs into")
    args = parser.parse_args(argv)

    t0 = time.monotonic()
    input_path = Path(args.input_file)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    # Load image
    img = nib.load(str(input_path))

    # Header
    header = _parse_header(img)

    # Header hash (sha256 of raw header bytes for provenance)
    try:
        raw_header = bytes(img.header)
    except Exception:
        raw_header = str(img.header).encode()
    header_hash = "sha256:" + hashlib.sha256(raw_header).hexdigest()

    # Image data — use proxy so we only materialise once
    data = np.asarray(img.dataobj, dtype=np.float64)

    # Stats
    stats = _compute_stats(data)

    # Warnings
    warnings = _detect_warnings(header, stats)

    # Histogram
    filename = input_path.name
    hist_path = output_dir / "nifti_histogram.png"
    _write_histogram(stats, hist_path, title=f"Intensity histogram — {filename}")

    runtime = time.monotonic() - t0

    import nibabel as _nib
    nibabel_version = getattr(_nib, "__version__", "unknown")

    import datetime
    timestamp = datetime.datetime.utcnow().isoformat() + "Z"

    result: dict[str, Any] = {
        "input_file": str(input_path),
        "file_size_bytes": input_path.stat().st_size,
        "header": header,
        "stats": stats,
        "warnings": warnings,
        "provenance": {
            "nibabel_version": nibabel_version,
            "inspection_timestamp": timestamp,
            "header_hash": header_hash,
            "runtime_seconds": round(runtime, 3),
        },
    }

    with open(output_dir / "nifti_inspector.json", "w") as f:
        json.dump(result, f, indent=2)

    _write_html_report(output_dir / "nifti_report.html", result)

    n_warn = len(warnings)
    print(
        f"NIfTI Inspector complete: {filename} | "
        f"{header['dimensions']} | {header['datatype']} | "
        f"{header['orientation']} | {n_warn} warning(s) | "
        f"runtime={runtime:.1f}s"
    )


def main() -> None:
    run(sys.argv[1:])
