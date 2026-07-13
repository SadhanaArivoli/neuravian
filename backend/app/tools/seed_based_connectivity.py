"""Seed-Based Functional Connectivity native pipeline.

Extracts a single seed ROI time series from an fMRIPrep preprocessed BOLD
run and computes a voxelwise Pearson correlation map with Fisher z-transform.
Exposed through the ``neuroforge-seed-based-connectivity`` console script and
launched by NativeExecutor.

Scientific steps
----------------
1. Load atlas with NiftiLabelsMasker and extract seed ROI time series.
2. Apply NiftiMasker to extract whole-brain voxel time series.
3. Compute Pearson r between the seed and every brain voxel.
4. Apply Fisher z-transform (arctanh) element-wise.
5. Reconstruct a NIfTI image in MNI space.
6. Produce a glass-brain PNG, a seed time series TSV, and an HTML report.
"""
# ruff: noqa: E402, I001

from __future__ import annotations

import argparse
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

import matplotlib

matplotlib.use("Agg")
import nibabel as nib
import numpy as np
import pandas as pd
from nilearn import __version__ as nilearn_version
from nilearn.maskers import NiftiLabelsMasker, NiftiMasker
from nilearn.plotting import plot_glass_brain

from app.tools.bids_utils import BoldSelection, select_bold_file
from app.tools.confounds import select_confounds
from app.tools.functional_connectivity import (
    ATLAS_REGISTRY,
    LoadedAtlas,
    load_atlas,
    normalize_atlas_id,
)


def _extract_seed_timeseries(
    bold_path: Path,
    loaded_atlas: LoadedAtlas,
    seed_idx: int,  # 0-based into roi_labels
    confounds: np.ndarray | None,
) -> np.ndarray:
    """Return the seed ROI time series (shape: [n_volumes])."""
    masker = NiftiLabelsMasker(
        labels_img=loaded_atlas.labels_img,
        labels=loaded_atlas.masker_labels,
        lut=loaded_atlas.lut,
        standardize="zscore_sample",
        detrend=True,
        resampling_target="labels",
        reports=False,
    )
    all_ts = masker.fit_transform(str(bold_path), confounds=confounds)
    if all_ts.ndim != 2 or all_ts.shape[1] == 0:
        raise ValueError("Atlas extraction produced no ROI time series.")
    if seed_idx >= all_ts.shape[1]:
        raise ValueError(
            f"Seed ROI index {seed_idx + 1} is out of range. "
            f"The '{loaded_atlas.spec.display_name}' atlas has "
            f"{all_ts.shape[1]} ROI(s) after extraction."
        )
    return all_ts[:, seed_idx]


def _compute_connectivity_map(
    bold_path: Path,
    seed_ts: np.ndarray,
    confounds: np.ndarray | None,
) -> nib.Nifti1Image:
    """Compute voxelwise Pearson r with seed, apply Fisher z-transform, return NIfTI."""
    brain_masker = NiftiMasker(
        standardize="zscore_sample",
        detrend=True,
        reports=False,
    )
    brain_ts = brain_masker.fit_transform(str(bold_path), confounds=confounds)
    # brain_ts shape: [n_volumes, n_voxels]
    # seed_ts shape: [n_volumes]
    seed_mean = seed_ts.mean()
    seed_std = seed_ts.std()
    if seed_std == 0:
        raise ValueError("Seed ROI time series has zero variance; cannot compute correlation.")

    seed_z = (seed_ts - seed_mean) / seed_std
    brain_mean = brain_ts.mean(axis=0)
    brain_std = brain_ts.std(axis=0)

    # Compute Pearson r for each voxel with the seed
    n = seed_ts.shape[0]
    numerator = (brain_ts - brain_mean).T @ seed_z / n
    denominator = brain_std
    denominator = np.where(denominator == 0, np.nan, denominator)
    r_map = numerator / denominator

    # Fisher z-transform
    r_clipped = np.clip(r_map, -0.9999, 0.9999)
    z_map = np.arctanh(r_clipped)
    z_map = np.nan_to_num(z_map, nan=0.0)

    return brain_masker.inverse_transform(z_map)


def _write_seed_png(path: Path, img: nib.Nifti1Image, seed_label: str) -> None:
    display = plot_glass_brain(
        img,
        display_mode="lzr",
        colorbar=True,
        cmap="cold_hot",
        vmax=1.5,
        title=f"Seed: {seed_label[:60]}",
        annotate=True,
    )
    display.savefig(str(path), dpi=120)
    display.close()


def _write_seed_timeseries(path: Path, seed_ts: np.ndarray, seed_label: str) -> None:
    pd.DataFrame({seed_label: seed_ts}).to_csv(path, sep="\t", index=False)


def _write_html_report(
    path: Path,
    metadata: dict[str, Any],
    files: dict[str, str],
) -> None:
    seed_label = html.escape(metadata.get("seed_label", "unknown"))
    atlas_name = html.escape(metadata.get("atlas", "—"))
    z_min = metadata.get("z_min", 0.0)
    z_max = metadata.get("z_max", 0.0)
    z_mean = metadata.get("z_mean", 0.0)
    n_vols = metadata.get("n_volumes", "—")
    nilearn_ver = html.escape(metadata.get("nilearn_version", "—"))

    file_rows = "".join(
        f"<tr><td>{html.escape(label)}</td>"
        f"<td><a href='{html.escape(fname)}'>{html.escape(fname)}</a></td></tr>"
        for label, fname in files.items()
    )

    content = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Seed-Based Connectivity: {seed_label}</title>
<style>
  body {{ font-family: sans-serif; max-width: 900px; margin: 2em auto; padding: 0 1em; }}
  h1 {{ font-size: 1.4em; }} h2 {{ font-size: 1.1em; color: #444; border-bottom: 1px solid #ddd; padding-bottom: .3em; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1em 0; }}
  td, th {{ border: 1px solid #ddd; padding: .4em .7em; text-align: left; font-size: .88em; }}
  th {{ background: #f5f5f5; }}
  img {{ max-width: 100%; border: 1px solid #ddd; border-radius: 4px; margin: .5em 0; }}
  .stat {{ display: inline-block; padding: .4em .8em; margin: .2em; background: #f0f4ff;
           border-radius: 4px; font-size: .9em; }}
  .stat b {{ display: block; font-size: 1.3em; }}
</style>
</head>
<body>
<h1>Seed-Based Connectivity Report</h1>
<p><strong>Seed:</strong> {seed_label} &nbsp;|&nbsp;
   <strong>Atlas:</strong> {atlas_name} &nbsp;|&nbsp;
   <strong>Nilearn:</strong> {nilearn_ver}</p>

<h2>Connectivity Map Statistics</h2>
<div>
  <span class="stat"><b>{z_min:.3f}</b>Min z</span>
  <span class="stat"><b>{z_max:.3f}</b>Max z</span>
  <span class="stat"><b>{z_mean:.3f}</b>Mean z</span>
  <span class="stat"><b>{n_vols}</b>Volumes</span>
</div>

<h2>Connectivity Map</h2>
<img src="{html.escape(files.get('Connectivity Map PNG', ''))}" alt="Seed connectivity map">

<h2>Output Files</h2>
<table><tr><th>File</th><th>Path</th></tr>{file_rows}</table>

<h2>Methods</h2>
<p>
The seed ROI time series was extracted from {atlas_name} using
<code>NiftiLabelsMasker</code> (Nilearn {nilearn_ver}) with z-score
standardization and linear detrending. A voxelwise Pearson correlation was
computed between the seed time series and every brain voxel extracted by
<code>NiftiMasker</code> with the same preprocessing. Correlation values were
Fisher z-transformed (arctanh) to yield an approximately normal distribution.
The resulting map is in the space of the input BOLD image (MNI152NLin2009cAsym
if standard fMRIPrep preprocessing was used).
</p>

<p style="color:#888;font-size:.8em">Generated by NeuroForge seed-based-connectivity pipeline.</p>
</body>
</html>
"""
    path.write_text(content, encoding="utf-8")


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run NeuroForge seed-based connectivity."
    )
    parser.add_argument("--fmriprep-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--atlas-name",
        default="schaefer100_7",
        choices=list(ATLAS_REGISTRY.keys()),
    )
    parser.add_argument("--seed-roi", required=True, type=int, help="1-based ROI index")
    parser.add_argument("--atlas-data-dir", default=None)
    parser.add_argument("--subject-label", default=None)
    parser.add_argument("--task-label", default=None)
    parser.add_argument("--run-label", default=None)
    args = parser.parse_args(argv)

    started = perf_counter()
    fmriprep_dir = Path(args.fmriprep_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    atlas_id = normalize_atlas_id(args.atlas_name)
    loaded_atlas = load_atlas(atlas_id, args.atlas_data_dir)

    seed_idx = args.seed_roi - 1  # convert to 0-based
    if seed_idx < 0:
        raise ValueError(f"--seed-roi must be >= 1 (got {args.seed_roi}).")

    roi_labels = loaded_atlas.roi_labels
    if seed_idx >= len(roi_labels):
        raise ValueError(
            f"Seed ROI index {args.seed_roi} is out of range. "
            f"The '{loaded_atlas.spec.display_name}' atlas has {len(roi_labels)} ROI(s)."
        )
    seed_label = roi_labels[seed_idx]

    print(f"[neuroforge] Seed-Based Connectivity using {loaded_atlas.spec.display_name}")
    print(f"[neuroforge] Seed ROI: {args.seed_roi} — {seed_label}")
    print(f"[neuroforge] fMRIPrep derivatives: {fmriprep_dir}")

    selection: BoldSelection = select_bold_file(
        fmriprep_dir,
        args.subject_label,
        args.task_label,
        args.run_label,
    )
    print(f"[neuroforge] Selected BOLD: {selection.bold_path}")
    if selection.confounds_path:
        print(f"[neuroforge] Selected confounds: {selection.confounds_path}")
    else:
        print("[neuroforge] No confounds file found; extracting raw time series.")

    # Use the same confound strategy as FC (motion6_wm_csf_gsr default).
    image = nib.load(str(selection.bold_path))
    n_vols = image.shape[3] if len(image.shape) == 4 else 0
    cs = select_confounds(selection.confounds_path, "motion6_wm_csf_gsr", n_vols)
    confounds = cs.values

    print("[neuroforge] Extracting seed ROI time series…")
    seed_ts = _extract_seed_timeseries(
        selection.bold_path, loaded_atlas, seed_idx, confounds
    )
    print(f"[neuroforge] Seed time series: {seed_ts.shape[0]} volumes")

    print("[neuroforge] Computing voxelwise connectivity map…")
    z_img = _compute_connectivity_map(selection.bold_path, seed_ts, confounds)

    z_data = np.asanyarray(z_img.dataobj)
    z_finite = z_data[np.isfinite(z_data)]

    map_path = output_dir / "seed_connectivity_map.nii.gz"
    png_path = output_dir / "seed_connectivity_map.png"
    ts_path = output_dir / "seed_timeseries.tsv"
    html_path = output_dir / "seed_report.html"
    meta_path = output_dir / "seed_connectivity_metadata.json"

    nib.save(z_img, str(map_path))
    print(f"[neuroforge] Wrote connectivity map: {map_path}")

    _write_seed_png(png_path, z_img, seed_label)
    print(f"[neuroforge] Wrote connectivity map PNG: {png_path}")

    _write_seed_timeseries(ts_path, seed_ts, seed_label)
    print(f"[neuroforge] Wrote seed time series: {ts_path}")

    metadata: dict[str, Any] = {
        "pipeline": "seed-based-connectivity",
        "atlas": loaded_atlas.spec.display_name,
        "atlas_id": loaded_atlas.spec.id,
        "atlas_display_name": loaded_atlas.spec.display_name,
        "atlas_source": loaded_atlas.spec.source,
        "atlas_version": getattr(loaded_atlas, "version", None),
        "atlas_type": getattr(loaded_atlas, "atlas_type", None) or loaded_atlas.spec.atlas_type,
        "atlas_space": getattr(loaded_atlas, "template", None) or loaded_atlas.spec.space,
        "atlas_resolution": loaded_atlas.spec.resolution,
        "atlas_citation": loaded_atlas.spec.citation,
        "atlas_network_count": loaded_atlas.spec.network_count,
        "seed_roi_index": args.seed_roi,
        "seed_label": seed_label,
        "correlation_method": "Pearson correlation (Fisher z-transformed)",
        "nilearn_version": nilearn_version,
        "bold_file": str(selection.bold_path),
        "confounds_file": str(selection.confounds_path) if selection.confounds_path else None,
        "subject": selection.subject,
        "task": selection.task,
        "run": selection.run,
        "n_volumes": int(seed_ts.shape[0]),
        "n_rois": len(roi_labels),
        "z_min": float(z_finite.min()) if z_finite.size else 0.0,
        "z_max": float(z_finite.max()) if z_finite.size else 0.0,
        "z_mean": float(z_finite.mean()) if z_finite.size else 0.0,
        "runtime_seconds": round(perf_counter() - started, 3),
    }
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    _write_html_report(
        html_path,
        metadata,
        {
            "Connectivity Map NIfTI": map_path.name,
            "Connectivity Map PNG": png_path.name,
            "Seed Time Series TSV": ts_path.name,
            "Metadata JSON": meta_path.name,
        },
    )
    print(f"[neuroforge] Wrote report: {html_path}")
    print(f"[neuroforge] Completed in {metadata['runtime_seconds']}s")
    return 0


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
