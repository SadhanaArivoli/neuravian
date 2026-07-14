"""Native voxelwise ALFF/fALFF analysis for fMRIPrep BOLD derivatives."""
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
plt.style.use("dark_background")
import nibabel as nib
import numpy as np
import pandas as pd
import scipy
from scipy import signal
from scipy.fft import rfft, rfftfreq

from app.reporting import citation_block, document_shell, figure_block, footer, key_value_table, methods_block, save_dark_figure, statistics_cards
from app.tools.bids_utils import bids_entity as _entity, find_matching_confounds as _matching_confounds
from app.tools.confounds import select_confounds

PIPELINE_VERSION = "1.0.0"
MIN_TIMEPOINTS = 50


def validate_frequency_band(low: float, high: float, tr: float) -> float:
    if not np.isfinite(tr) or tr <= 0:
        raise ValueError("TR must be a finite positive number of seconds")
    nyquist = 1.0 / (2.0 * tr)
    if low < 0 or high < 0:
        raise ValueError("Frequency bounds cannot be negative")
    if low >= high:
        raise ValueError("Low frequency must be less than high frequency")
    if high > nyquist + np.finfo(float).eps:
        raise ValueError(f"High frequency {high:g} Hz exceeds Nyquist {nyquist:g} Hz")
    return nyquist


def compute_alff_falff(timeseries: np.ndarray, tr: float, low: float, high: float):
    """Return ALFF, fALFF, frequencies, and mean spectrum for T x V data."""
    if timeseries.ndim != 2:
        raise ValueError("Timeseries must have shape timepoints x voxels")
    n = timeseries.shape[0]
    validate_frequency_band(low, high, tr)
    frequencies = rfftfreq(n, d=tr)
    amplitude = np.abs(rfft(timeseries, axis=0)) / n
    positive = frequencies > 0
    low_band = positive & (frequencies >= low) & (frequencies <= high)
    if not np.any(low_band):
        raise ValueError("Selected band contains no FFT bins; use a longer run or wider band")
    alff = amplitude[low_band].sum(axis=0)
    denominator = amplitude[positive].sum(axis=0)
    falff = np.divide(alff, denominator, out=np.zeros_like(alff), where=denominator > 0)
    return alff, falff, frequencies, amplitude.mean(axis=1)


def normalize_map(values: np.ndarray, method: str) -> np.ndarray:
    if method == "none":
        return values.copy()
    if method == "mean":
        mean = float(values.mean())
        return np.divide(values, mean, out=np.zeros_like(values), where=mean != 0)
    if method == "zscore":
        std = float(values.std())
        return np.divide(values - values.mean(), std, out=np.zeros_like(values), where=std != 0)
    raise ValueError(f"Unknown normalization '{method}'")


def _find_bold(root: Path, subject: str | None, task: str | None, run: str | None) -> Path:
    candidates = sorted(root.glob("sub-*/func/*desc-preproc_bold.nii.gz"))
    candidates += sorted(root.glob("sub-*/func/*desc-preproc_bold.nii"))
    candidates = [p for p in candidates if (not subject or _entity(p, "sub") == subject)
                  and (not task or _entity(p, "task") == task)
                  and (not run or _entity(p, "run") == run)]
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
        "min": np.min, "max": np.max, "mean": np.mean, "median": np.median, "std": np.std
    }.items()}


def _save_map(path: Path, values: np.ndarray, mask: np.ndarray, source: nib.Nifti1Image):
    volume = np.zeros(mask.shape, dtype=np.float32)
    volume[mask] = values.astype(np.float32)
    header = source.header.copy()
    header.set_data_dtype(np.float32)
    header.set_slope_inter(1.0, 0.0)
    header.set_data_shape(mask.shape)
    # Set cal_min=0 so viewers (e.g. NiiVue) anchor the colormap at zero.
    # Without this, viewers auto-scale from min-nonzero, mapping background zeros
    # to the colormap maximum (e.g. yellow for inferno).
    header["cal_min"] = 0.0
    header["cal_max"] = float(np.nanmax(volume))
    nib.save(nib.Nifti1Image(volume, source.affine, header), path)


def _hist(values: np.ndarray, title: str, path: Path):
    fig, ax = plt.subplots(figsize=(6, 4)); ax.hist(values, bins=60, color="#315b7d")
    ax.set(title=title, xlabel=title, ylabel="Voxels"); fig.tight_layout(); save_dark_figure(fig, path, dpi=140); plt.close(fig)


def run(args: argparse.Namespace) -> dict[str, Any]:
    started = perf_counter(); root = Path(args.fmriprep_dir); out = Path(args.output_dir); out.mkdir(parents=True, exist_ok=True)
    bold = _find_bold(root, args.subject_label, args.task_label, args.run_label)
    image = nib.load(bold)
    if len(image.shape) != 4:
        raise ValueError("Selected BOLD file is not 4D")
    n = image.shape[3]
    if n < MIN_TIMEPOINTS:
        raise ValueError(f"BOLD has {n} timepoints; at least {MIN_TIMEPOINTS} are required")
    tr = _derive_tr(image, bold, args.tr); nyquist = validate_frequency_band(args.low_frequency, args.high_frequency, tr)
    data = np.nan_to_num(image.get_fdata(dtype=np.float32), nan=0.0, posinf=0.0, neginf=0.0)
    mask_path = _find_mask(bold)
    if mask_path:
        mask_img = nib.load(mask_path)
        if mask_img.shape != image.shape[:3] or not np.allclose(mask_img.affine, image.affine, atol=1e-4):
            raise ValueError("Brain mask geometry does not match BOLD geometry")
        mask = np.asarray(mask_img.dataobj) > 0
    else:
        mask = np.any(data != 0, axis=3)
    if not np.any(mask): raise ValueError("Brain mask is empty")
    timeseries = data[mask].T
    confounds_path = _matching_confounds(bold)
    selected = select_confounds(confounds_path, args.confound_strategy, n)
    if selected.missing:
        raise ValueError("Missing required confound columns: " + ", ".join(selected.missing))
    if selected.values is not None:
        design = np.column_stack([np.ones(n), selected.values])
        timeseries = timeseries - design @ np.linalg.lstsq(design, timeseries, rcond=None)[0]
    if args.detrend:
        timeseries = signal.detrend(timeseries, axis=0, type="linear")
    alff, falff, frequencies, spectrum = compute_alff_falff(timeseries, tr, args.low_frequency, args.high_frequency)
    warnings: list[str] = []
    constant = np.ptp(timeseries, axis=0) <= np.finfo(np.float32).eps
    if np.any(constant): warnings.append(f"{int(constant.sum())} constant voxel time series produced zero ALFF/fALFF")
    _save_map(out / "alff_map.nii.gz", alff, mask, image); _save_map(out / "falff_map.nii.gz", falff, mask, image)
    if args.normalization != "none":
        _save_map(out / "alff_normalized_map.nii.gz", normalize_map(alff, args.normalization), mask, image)
        _save_map(out / "falff_normalized_map.nii.gz", normalize_map(falff, args.normalization), mask, image)
    _hist(alff, "ALFF", out / "alff_histogram.png"); _hist(falff, "fALFF", out / "falff_histogram.png")
    fig, ax = plt.subplots(figsize=(7, 4)); ax.plot(frequencies, spectrum, color="#67e8f9"); ax.axvspan(args.low_frequency, args.high_frequency, alpha=.25, color="#f59e0b"); ax.set(xlabel="Frequency (Hz)", ylabel="Mean FFT amplitude", title="Mean masked spectrum"); fig.tight_layout(); save_dark_figure(fig, out / "spectral_summary.png", dpi=140); plt.close(fig)
    metadata = {
        "source_run_id": args.source_run_id, "source_bold_path": str(bold), "source_mask_path": str(mask_path) if mask_path else None,
        "source_confounds_path": str(confounds_path) if confounds_path else None, "tr": tr, "number_of_timepoints": n,
        "nyquist_frequency": nyquist, "frequency_resolution": 1/(n*tr), "frequency_band": [args.low_frequency, args.high_frequency],
        "spectral_method": "abs(scipy.fft.rfft)/N; DC excluded; positive bins through Nyquist; inclusive band endpoints",
        "confound_strategy": args.confound_strategy, "confound_columns_used": selected.used, "missing_confound_columns": selected.missing,
        "number_of_regressors": len(selected.used), "timepoints_before_cleaning": n, "timepoints_after_cleaning": n,
        "detrending": "linear" if args.detrend else "none", "timeseries_standardization": "none", "normalization": args.normalization,
        "mask_voxel_count": int(mask.sum()), "alff_statistics": _stats(alff), "falff_statistics": _stats(falff),
        "software_versions": {"python": platform.python_version(), "numpy": np.__version__, "scipy": scipy.__version__, "nibabel": nib.__version__},
        "pipeline_version": PIPELINE_VERSION, "runtime_seconds": perf_counter()-started, "command": "neuroforge-alff-falff", "warnings": warnings,
        "citations": ["Zang et al. (2007), doi:10.1016/j.braindev.2006.07.002", "Zou et al. (2008), doi:10.1016/j.jneumeth.2008.04.012"]
    }
    (out / "alff_falff_metadata.json").write_text(json.dumps(metadata, indent=2))
    subject = _entity(bold, "sub") or "—"
    task = _entity(bold, "task") or "—"
    run_label = _entity(bold, "run") or "—"
    space = _entity(bold, "space") or "native / unspecified"
    display_rows = [
        ("Source run", args.source_run_id), ("Subject", subject), ("Task", task),
        ("Run", run_label), ("Space", space), ("TR (seconds)", f"{tr:g}"),
        ("Timepoints", n), ("Frequency band (Hz)", f"{args.low_frequency:g}–{args.high_frequency:g}"),
        ("Frequency resolution (Hz)", f"{1/(n*tr):.6g}"),
        ("Confound strategy", args.confound_strategy),
        ("Confound regressors", len(selected.used)),
        ("Regressors used", ", ".join(selected.used) if selected.used else "None"),
        ("Detrending", "Linear" if args.detrend else "None"),
        ("Map normalization", args.normalization), ("Mask voxels", int(mask.sum())),
        ("Pipeline version", PIPELINE_VERSION),
    ]
    body = (
        "<p>Descriptive resting-state maps; no clinical or biological interpretation is inferred.</p>"
        "<h2>Parameters and provenance</h2>"
        + key_value_table(display_rows)
        + "<h2>Descriptive statistics</h2>"
        + statistics_cards({"Mean ALFF": f"{metadata['alff_statistics']['mean']:.4g}", "Mean fALFF": f"{metadata['falff_statistics']['mean']:.4g}", "Maximum ALFF": f"{metadata['alff_statistics']['max']:.4g}", "Maximum fALFF": f"{metadata['falff_statistics']['max']:.4g}"})
        + "<h2>Figures</h2>"
        + figure_block("alff_histogram.png", "ALFF distribution", "Distribution of ALFF values within the analysis mask.")
        + figure_block("falff_histogram.png", "fALFF distribution", "Distribution of fALFF values within the analysis mask.")
        + figure_block("spectral_summary.png", "Mean amplitude spectrum", "Mean voxelwise amplitude spectrum.")
        + methods_block(f"After optional nuisance regression and linear detrending, voxelwise FFT amplitude spectra were calculated. ALFF is summed amplitude from {args.low_frequency:g}–{args.high_frequency:g} Hz. fALFF is that amplitude divided by summed positive-frequency amplitude excluding DC.")
        + citation_block(metadata["citations"])
    )
    (out / "alff_falff_report.html").write_text(document_shell("ALFF / fALFF Analysis", "Descriptive resting-state frequency amplitude report", body, footer_html=footer()), encoding="utf-8")
    return metadata


def parser():
    p=argparse.ArgumentParser(); p.add_argument("--fmriprep-dir", required=True); p.add_argument("--output-dir", required=True)
    p.add_argument("--low-frequency", type=float, default=.01); p.add_argument("--high-frequency", type=float, default=.08); p.add_argument("--tr", type=float)
    p.add_argument("--confound-strategy", choices=["none","motion6","motion6_wm_csf","motion6_wm_csf_global"], default="none")
    p.add_argument("--normalization", choices=["none","mean","zscore"], default="none"); p.add_argument("--detrend", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--subject-label"); p.add_argument("--task-label"); p.add_argument("--run-label"); p.add_argument("--source-run-id", type=int)
    return p


def main(): run(parser().parse_args())
if __name__ == "__main__": main()
