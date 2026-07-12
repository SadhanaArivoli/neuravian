"""Native voxelwise Regional Homogeneity (ReHo) analysis — Zang et al. (2004).

Computes Kendall's Coefficient of Concordance (KCC) for each brain voxel
across its spatial neighborhood (7, 19, or 27 voxels). No FSL/AFNI/SPM
required; pure Python using scipy, nibabel, and numpy.

KCC formula: W = 12·S / [K²·(T³ - T)]
  S = Σ_t (R_t - R̄)²   (R_t = sum of ranks across K neighbors at timepoint t)
  K = neighborhood size (voxel count including center)
  T = number of timepoints

Reference: Zang et al. (2004), doi:10.1016/S1053-8119(04)00168-0
"""
from __future__ import annotations

import argparse
import html
import json
import os
import platform
import tempfile
from pathlib import Path
from time import perf_counter
from typing import Any

_cache = Path(tempfile.gettempdir()) / "neuroforge-cache" / "matplotlib"
_cache.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(_cache))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import nibabel as nib
import numpy as np
import scipy
from scipy import ndimage, stats

from app.tools.confounds import select_confounds
from app.tools.functional_connectivity import _entity, _matching_confounds

PIPELINE_VERSION = "1.0.0"
MIN_TIMEPOINTS = 30


# ── Neighborhood kernels ───────────────────────────────────────────────────────

def _neighborhood_kernel(size: int) -> np.ndarray:
    """Return 3×3×3 binary kernel for 7-, 19-, or 27-voxel neighborhoods."""
    k = np.zeros((3, 3, 3), dtype=np.float32)
    for i in range(3):
        for j in range(3):
            for kk in range(3):
                d_cheb = max(abs(i - 1), abs(j - 1), abs(kk - 1))
                d_l1 = abs(i - 1) + abs(j - 1) + abs(kk - 1)
                if size == 7 and d_l1 <= 1:    # center + 6 face
                    k[i, j, kk] = 1.0
                elif size == 19 and d_l1 <= 2:  # center + 6 face + 12 edge
                    k[i, j, kk] = 1.0
                elif size == 27 and d_cheb <= 1:  # full 3×3×3
                    k[i, j, kk] = 1.0
    return k


# ── KCC computation ────────────────────────────────────────────────────────────

def compute_reho(data: np.ndarray, mask: np.ndarray, neighborhood: int) -> tuple[np.ndarray, np.ndarray]:
    """Compute voxelwise KCC-ReHo map.

    Parameters
    ----------
    data : float32 array, shape [X, Y, Z, T]
    mask : bool array, shape [X, Y, Z]
    neighborhood : 7, 19, or 27

    Returns
    -------
    reho_map : float32 array, shape [X, Y, Z] — KCC values in [0,1] within mask
    valid_mask : bool array — voxels where all K neighbors were inside mask
    """
    X, Y, Z, T = data.shape
    kernel = _neighborhood_kernel(neighborhood)
    K = int(kernel.sum())

    # Rank each voxel timeseries independently (ties: average rank)
    # Process only masked voxels to save memory; reconstruct 4D rank volume
    coords = np.argwhere(mask)  # [N, 3]
    N = len(coords)
    xs, ys, zs = coords[:, 0], coords[:, 1], coords[:, 2]

    # ranks_vol: [X, Y, Z, T] float32 — 0 outside mask, ranks inside
    ranks_vol = np.zeros((X, Y, Z, T), dtype=np.float32)
    voxel_ts = data[xs, ys, zs, :]  # [N, T]
    ranked = np.apply_along_axis(lambda v: stats.rankdata(v, method="average"), 1, voxel_ts)
    ranks_vol[xs, ys, zs, :] = ranked.astype(np.float32)

    # Identify valid voxels: all K neighborhood voxels must lie within mask
    neighbor_count = ndimage.convolve(
        mask.astype(np.float32), kernel, mode="constant", cval=0.0
    )
    valid_mask = mask & (neighbor_count >= K - 0.5)  # float tolerance

    # Sum ranks across neighborhood at each timepoint via 3D convolution
    # Result rank_sum[x,y,z,t] = Σ_k rank_k(t) over K neighbors
    rank_sum = np.zeros((X, Y, Z, T), dtype=np.float64)
    for t in range(T):
        rank_sum[..., t] = ndimage.convolve(
            ranks_vol[..., t], kernel, mode="constant", cval=0.0
        )

    # Extract only valid voxels for KCC formula
    vxs, vys, vzs = np.where(valid_mask)
    rs = rank_sum[vxs, vys, vzs, :]  # [M, T]

    mean_rs = rs.mean(axis=1, keepdims=True)
    S = ((rs - mean_rs) ** 2).sum(axis=1)  # [M]
    denom = float(K) ** 2 * (float(T) ** 3 - float(T))
    W = np.where(denom > 0, 12.0 * S / denom, 0.0).astype(np.float32)
    W = np.clip(W, 0.0, 1.0)

    reho_map = np.zeros((X, Y, Z), dtype=np.float32)
    reho_map[vxs, vys, vzs] = W

    return reho_map, valid_mask


# ── Helpers shared with alff_falff pattern ────────────────────────────────────

def _find_bold(root: Path, subject: str | None, task: str | None, run: str | None) -> Path:
    candidates = sorted(root.glob("sub-*/func/*desc-preproc_bold.nii.gz"))
    candidates += sorted(root.glob("sub-*/func/*desc-preproc_bold.nii"))
    candidates = [
        p for p in candidates
        if (not subject or _entity(p, "sub") == subject)
        and (not task or _entity(p, "task") == task)
        and (not run or _entity(p, "run") == run)
    ]
    if not candidates:
        raise FileNotFoundError("No matching fMRIPrep desc-preproc_bold NIfTI was found")
    return candidates[0]


def _find_mask(bold: Path) -> Path | None:
    stem = bold.name.split("_desc-preproc_bold")[0]
    candidates = sorted(bold.parent.glob(f"{stem}*_desc-brain_mask.nii*"))
    return candidates[0] if candidates else None


def _derive_tr(image: nib.Nifti1Image, bold: Path, explicit: float | None) -> float:
    if explicit is not None:
        return explicit
    sidecar = Path(str(bold).removesuffix(".gz")).with_suffix(".json")
    if not sidecar.exists():
        sidecar = Path(str(bold).replace("_desc-preproc_bold.nii.gz", "_bold.json")
                       .replace("_desc-preproc_bold.nii", "_bold.json"))
    if sidecar.exists():
        value = json.loads(sidecar.read_text()).get("RepetitionTime")
        if value is not None:
            return float(value)
    return float(image.header.get_zooms()[3])


def _stats(values: np.ndarray) -> dict[str, float]:
    return {name: float(func(values)) for name, func in {
        "min": np.min, "max": np.max, "mean": np.mean,
        "median": np.median, "std": np.std,
    }.items()}


def _save_map(path: Path, volume: np.ndarray, source: nib.Nifti1Image) -> None:
    header = source.header.copy()
    header.set_data_dtype(np.float32)
    header.set_slope_inter(1.0, 0.0)
    header.set_data_shape(volume.shape)
    nib.save(nib.Nifti1Image(volume.astype(np.float32), source.affine, header), path)


def _hist(values: np.ndarray, title: str, path: Path) -> None:
    fig, ax = plt.subplots(figsize=(6, 4))
    ax.hist(values, bins=60, color="#315b7d")
    ax.set(title=title, xlabel="KCC (W)", ylabel="Voxels")
    fig.tight_layout()
    fig.savefig(path, dpi=140)
    plt.close(fig)


# ── Entry point ────────────────────────────────────────────────────────────────

def run(args: argparse.Namespace) -> dict[str, Any]:
    started = perf_counter()
    root = Path(args.fmriprep_dir)
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    bold = _find_bold(root, args.subject_label, args.task_label, args.run_label)
    image = nib.load(bold)

    if len(image.shape) != 4:
        raise ValueError("Selected BOLD file is not 4D — ReHo requires a timeseries")
    T = image.shape[3]
    if T < MIN_TIMEPOINTS:
        raise ValueError(f"BOLD has {T} timepoints; at least {MIN_TIMEPOINTS} are required for reliable KCC")

    tr = _derive_tr(image, bold, args.tr)
    if not (0 < tr < 60):
        raise ValueError(f"TR = {tr} s appears invalid; use --tr to set it explicitly")

    data = np.nan_to_num(
        image.get_fdata(dtype=np.float32), nan=0.0, posinf=0.0, neginf=0.0
    )

    mask_path = _find_mask(bold)
    if mask_path:
        mask_img = nib.load(mask_path)
        if mask_img.shape != image.shape[:3] or not np.allclose(mask_img.affine, image.affine, atol=1e-4):
            raise ValueError("Brain mask geometry does not match BOLD geometry")
        mask = np.asarray(mask_img.dataobj) > 0
    else:
        mask = np.any(data != 0, axis=3)
    if not np.any(mask):
        raise ValueError("Brain mask is empty — cannot compute ReHo")

    # Optional nuisance regression
    n = T
    confounds_path = _matching_confounds(bold)
    selected = select_confounds(confounds_path, args.confound_strategy, n)
    if selected.missing:
        raise ValueError("Missing required confound columns: " + ", ".join(selected.missing))

    warnings: list[str] = []

    if selected.values is not None or args.detrend:
        xs, ys, zs = np.where(mask)
        ts = data[xs, ys, zs, :].T  # [T, N]
        if args.detrend:
            from scipy import signal as sig
            ts = sig.detrend(ts, axis=0, type="linear")
        if selected.values is not None:
            design = np.column_stack([np.ones(n), selected.values])
            ts = ts - design @ np.linalg.lstsq(design, ts, rcond=None)[0]
        data = np.zeros_like(data)
        data[xs, ys, zs, :] = ts.T

    # Core KCC computation
    neighborhood = args.neighborhood
    reho_map, valid_mask = compute_reho(data, mask, neighborhood)
    K = int(_neighborhood_kernel(neighborhood).sum())

    reho_values = reho_map[valid_mask]
    if len(reho_values) == 0:
        raise ValueError("No valid voxels after neighborhood filtering — mask may be too small")

    constant_vox = int(np.sum(np.ptp(data[mask], axis=1) <= np.finfo(np.float32).eps))
    if constant_vox > 0:
        warnings.append(f"{constant_vox} constant voxel timeseries in mask (possible acquisition artifact)")

    excluded = int(mask.sum()) - int(valid_mask.sum())
    if excluded > 0:
        warnings.append(
            f"{excluded} mask-edge voxels excluded (incomplete {neighborhood}-voxel neighborhood)"
        )

    # Z-score normalization (optional)
    if args.z_normalize:
        mean_w = float(reho_map[valid_mask].mean())
        std_w = float(reho_map[valid_mask].std())
        reho_norm = np.zeros_like(reho_map)
        if std_w > 0:
            reho_norm[valid_mask] = (reho_map[valid_mask] - mean_w) / std_w
        _save_map(out / "reho_normalized_map.nii.gz", reho_norm, image)

    _save_map(out / "reho_map.nii.gz", reho_map, image)
    _hist(reho_values, "ReHo (KCC W)", out / "reho_histogram.png")

    reho_stats = _stats(reho_values)
    metadata: dict[str, Any] = {
        "source_run_id": args.source_run_id,
        "source_bold_path": str(bold),
        "source_mask_path": str(mask_path) if mask_path else None,
        "source_confounds_path": str(confounds_path) if confounds_path else None,
        "tr": tr,
        "number_of_timepoints": T,
        "neighborhood": neighborhood,
        "neighborhood_voxels": K,
        "neighborhood_label": {7: "7 (face)", 19: "19 (face+edge)", 27: "27 (3×3×3 cube)"}[neighborhood],
        "kcc_formula": "W = 12·S / [K²·(T³ - T)]  (Zang et al. 2004)",
        "confound_strategy": args.confound_strategy,
        "confound_columns_used": selected.used,
        "detrending": "linear" if args.detrend else "none",
        "z_normalize": args.z_normalize,
        "mask_voxel_count": int(mask.sum()),
        "valid_voxel_count": int(valid_mask.sum()),
        "excluded_edge_voxels": excluded,
        "reho_statistics": reho_stats,
        "software_versions": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
            "nibabel": nib.__version__,
        },
        "pipeline_version": PIPELINE_VERSION,
        "runtime_seconds": perf_counter() - started,
        "command": "neuroforge-regional-homogeneity",
        "warnings": warnings,
        "citations": [
            "Zang et al. (2004). Regional homogeneity approach to fMRI data analysis. "
            "NeuroImage 22(1):394–400. doi:10.1016/S1053-8119(04)00168-0"
        ],
    }
    (out / "reho_metadata.json").write_text(json.dumps(metadata, indent=2))

    rows = "".join(
        f"<tr><th>{html.escape(str(k))}</th><td>{html.escape(str(v))}</td></tr>"
        for k, v in metadata.items()
        if k != "command"
    )
    norm_section = (
        "<p>Z-score normalized map also saved as <code>reho_normalized_map.nii.gz</code>.</p>"
        if args.z_normalize else ""
    )
    report_html = f"""<!doctype html><html><head><meta charset='utf-8'>
<title>Regional Homogeneity (ReHo) Report</title>
<style>body{{font:15px system-ui;max-width:900px;margin:auto;padding:2rem}}
th{{text-align:left;width:14rem}}td,th{{padding:.4rem;border-bottom:1px solid #ddd}}
img{{max-width:100%}}</style></head><body>
<h1>Regional Homogeneity (ReHo)</h1>
<p>Descriptive resting-state map; no clinical or biological interpretation is inferred.</p>
<p>KCC W ranges from 0 (no agreement among neighbors) to 1 (perfect temporal rank agreement).
Neighborhood: {metadata['neighborhood_label']} · Timepoints: {T} · Valid voxels: {valid_mask.sum():,}</p>
{norm_section}
<h2>Parameters</h2><table>{rows}</table>
<h2>ReHo Distribution</h2><img src='reho_histogram.png'>
<h2>Method</h2>
<p>At each brain voxel, the timeseries of the voxel and its {K-1} spatial neighbors were
rank-transformed independently. Kendall's Coefficient of Concordance (W) was computed as
W = 12·S / [K²·(T³−T)], where S is the sum of squared deviations of per-timepoint rank
sums from their mean (Zang et al. 2004). Only voxels with a complete {neighborhood}-voxel
neighborhood within the brain mask were retained.</p>
</body></html>"""
    (out / "reho_report.html").write_text(report_html)

    return metadata


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Regional Homogeneity (ReHo) — KCC voxelwise analysis")
    p.add_argument("--fmriprep-dir", required=True, help="fMRIPrep derivatives root")
    p.add_argument("--output-dir", required=True, help="Directory for output files")
    p.add_argument("--neighborhood", type=int, choices=[7, 19, 27], default=27,
                   help="Neighborhood size: 7 (face), 19 (face+edge), 27 (3×3×3 cube, default)")
    p.add_argument("--tr", type=float, default=None, help="Repetition time in seconds (auto-detected if omitted)")
    p.add_argument("--confound-strategy",
                   choices=["none", "motion6", "motion6_wm_csf", "motion6_wm_csf_global"],
                   default="none", help="Nuisance regressor strategy")
    p.add_argument("--detrend", action=argparse.BooleanOptionalAction, default=True,
                   help="Linear detrending before KCC (default: True)")
    p.add_argument("--z-normalize", action=argparse.BooleanOptionalAction, default=False,
                   help="Also save z-score normalized ReHo map")
    p.add_argument("--subject-label", default=None)
    p.add_argument("--task-label", default=None)
    p.add_argument("--run-label", default=None)
    p.add_argument("--source-run-id", type=int, default=None)
    return p


def main() -> None:
    run(parser().parse_args())


if __name__ == "__main__":
    main()
