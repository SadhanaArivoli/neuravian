"""Functional Connectivity native pipeline.

This module is intentionally narrow: it turns one fMRIPrep preprocessed BOLD
run into Schaefer-100 atlas time series, a Pearson correlation matrix, a PNG
heatmap, and a small HTML report. It is exposed through the
``neuroforge-functional-connectivity`` console script and launched by
NativeExecutor, not by arbitrary user Python.
"""
# ruff: noqa: E402, I001

from __future__ import annotations

import argparse
import html
import json
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

_cache_dir = Path(tempfile.gettempdir()) / "neuroforge-cache"
(_cache_dir / "matplotlib").mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(_cache_dir / "matplotlib"))
os.environ.setdefault("XDG_CACHE_HOME", str(_cache_dir))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import nibabel as nib
import numpy as np
import pandas as pd
from nilearn import __version__ as nilearn_version
from nilearn.connectome import ConnectivityMeasure
from nilearn.datasets import fetch_atlas_schaefer_2018
from nilearn.maskers import NiftiLabelsMasker


ATLAS_ID = "schaefer_100_7"
ATLAS_NAME = "Schaefer 2018, 100 parcels, 7 networks"
CORRELATION_METHOD = "Pearson correlation"
CONFOUND_COLUMNS = [
    "trans_x",
    "trans_y",
    "trans_z",
    "rot_x",
    "rot_y",
    "rot_z",
    "white_matter",
    "csf",
    "global_signal",
]


@dataclass
class BoldSelection:
    bold_path: Path
    confounds_path: Path | None
    subject: str | None
    task: str | None
    run: str | None


def _entity(path: Path, name: str) -> str | None:
    match = re.search(rf"(?:^|_){re.escape(name)}-([^_]+)", path.name)
    return match.group(1) if match else None


def _prefix_for_confounds(path: Path) -> str:
    stem = path.name
    if stem.endswith(".nii.gz"):
        stem = stem[:-7]
    elif stem.endswith(".nii"):
        stem = stem[:-4]
    for marker in ("_space-", "_res-", "_desc-preproc_bold"):
        idx = stem.find(marker)
        if idx != -1:
            stem = stem[:idx]
            break
    return stem


def _matching_confounds(path: Path) -> Path | None:
    prefix = _prefix_for_confounds(path)
    candidates = sorted(path.parent.glob(f"{prefix}*_desc-confounds_timeseries.tsv"))
    return candidates[0] if candidates else None


def _select_bold(
    fmriprep_dir: Path,
    subject_label: str | None,
    task_label: str | None,
    run_label: str | None,
) -> BoldSelection:
    bolds = sorted(fmriprep_dir.glob("sub-*/func/*desc-preproc_bold.nii.gz"))
    if not bolds:
        raise FileNotFoundError(
            "No fMRIPrep preprocessed BOLD files were found. Expected files like "
            "sub-01/func/sub-01_task-rest_space-MNI152NLin2009cAsym_desc-preproc_bold.nii.gz."
        )

    def keep(path: Path) -> bool:
        return (
            (not subject_label or _entity(path, "sub") == subject_label)
            and (not task_label or _entity(path, "task") == task_label)
            and (not run_label or _entity(path, "run") == run_label)
        )

    filtered = [path for path in bolds if keep(path)]
    if not filtered:
        raise FileNotFoundError(
            "No preprocessed BOLD file matched the selected subject/task/run filters."
        )

    bold_path = filtered[0]
    return BoldSelection(
        bold_path=bold_path,
        confounds_path=_matching_confounds(bold_path),
        subject=_entity(bold_path, "sub"),
        task=_entity(bold_path, "task"),
        run=_entity(bold_path, "run"),
    )


def _load_confounds(path: Path | None) -> np.ndarray | None:
    if path is None or not path.exists():
        return None
    frame = pd.read_csv(path, sep="\t")
    selected = [col for col in CONFOUND_COLUMNS if col in frame.columns]
    if not selected:
        return None
    confounds = frame[selected].replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return confounds.to_numpy(dtype=float)


def _decode_label(label: Any) -> str:
    if isinstance(label, bytes):
        return label.decode("utf-8")
    return str(label)


def _write_matrix_csv(path: Path, matrix: np.ndarray, labels: list[str]) -> None:
    pd.DataFrame(matrix, index=labels, columns=labels).to_csv(path)


def _write_timeseries(path: Path, timeseries: np.ndarray, labels: list[str]) -> None:
    pd.DataFrame(timeseries, columns=labels).to_csv(path, sep="\t", index=False)


def _write_heatmap(path: Path, matrix: np.ndarray, labels: list[str]) -> None:
    fig_width = max(8, min(14, len(labels) / 9))
    fig, ax = plt.subplots(figsize=(fig_width, fig_width), dpi=160)
    im = ax.imshow(matrix, vmin=-1, vmax=1, cmap="coolwarm")
    ax.set_title("Functional Connectivity Matrix")
    ax.set_xlabel("ROI")
    ax.set_ylabel("ROI")
    if len(labels) <= 120:
        ticks = np.linspace(0, len(labels) - 1, min(12, len(labels)), dtype=int)
        ax.set_xticks(ticks)
        ax.set_yticks(ticks)
        ax.set_xticklabels([str(i + 1) for i in ticks], rotation=90, fontsize=6)
        ax.set_yticklabels([str(i + 1) for i in ticks], fontsize=6)
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04, label="r")
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def _write_html_report(
    path: Path,
    metadata: dict[str, Any],
    matrix: np.ndarray,
    outputs: dict[str, str],
) -> None:
    rows = "".join(
        f"<tr><th>{html.escape(str(key))}</th><td>{html.escape(str(value))}</td></tr>"
        for key, value in metadata.items()
        if key not in {"roi_labels"}
    )
    files = "".join(
        f'<li><a href="{html.escape(value)}">{html.escape(label)}</a></li>'
        for label, value in outputs.items()
    )
    report = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Functional Connectivity Report</title>
  <style>
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 2rem;
      color: #111827;
    }}
    table {{ border-collapse: collapse; margin: 1rem 0; }}
    th, td {{
      border: 1px solid #d1d5db;
      padding: 0.45rem 0.65rem;
      text-align: left;
    }}
    th {{ background: #f3f4f6; }}
    img {{ max-width: min(900px, 100%); border: 1px solid #e5e7eb; }}
    code {{ background: #f3f4f6; padding: 0.1rem 0.25rem; }}
  </style>
</head>
<body>
  <h1>Functional Connectivity Report</h1>
  <p>Atlas-based Pearson correlation matrix generated by NeuroForge.</p>
  <img src="{html.escape(outputs["Heatmap PNG"])}" alt="Connectivity heatmap" />
  <h2>Summary</h2>
  <table>{rows}</table>
  <h2>Output Files</h2>
  <ul>{files}</ul>
  <p><strong>Interpretation note:</strong> This report computes descriptive
  connectivity only. It does not perform diagnosis, statistical testing, graph
  metrics, or machine learning.</p>
</body>
</html>
"""
    path.write_text(report, encoding="utf-8")


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run NeuroForge functional connectivity."
    )
    parser.add_argument("--fmriprep-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--atlas-name", default=ATLAS_ID, choices=[ATLAS_ID])
    parser.add_argument("--atlas-data-dir", default=None)
    parser.add_argument("--subject-label", default=None)
    parser.add_argument("--task-label", default=None)
    parser.add_argument("--run-label", default=None)
    args = parser.parse_args(argv)

    started = perf_counter()
    fmriprep_dir = Path(args.fmriprep_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"[neuroforge] Functional Connectivity using {ATLAS_NAME}")
    print(f"[neuroforge] fMRIPrep derivatives: {fmriprep_dir}")

    selection = _select_bold(
        fmriprep_dir,
        args.subject_label,
        args.task_label,
        args.run_label,
    )
    print(f"[neuroforge] Selected BOLD: {selection.bold_path}")
    if selection.confounds_path:
        print(f"[neuroforge] Selected confounds: {selection.confounds_path}")
    else:
        print(
            "[neuroforge] No confounds file found; "
            "extracting raw regional time series."
        )

    atlas = fetch_atlas_schaefer_2018(
        n_rois=100,
        yeo_networks=7,
        resolution_mm=2,
        data_dir=args.atlas_data_dir,
        verbose=1,
    )
    labels = [_decode_label(label) for label in atlas.labels]
    roi_labels = labels[1:] if labels and labels[0].lower() == "background" else labels

    confounds = _load_confounds(selection.confounds_path)
    image = nib.load(str(selection.bold_path))
    if len(image.shape) != 4:
        raise ValueError(f"Selected BOLD file is not 4D: shape={image.shape}")

    masker = NiftiLabelsMasker(
        labels_img=atlas.maps,
        labels=labels,
        standardize="zscore_sample",
        detrend=True,
        resampling_target="data",
        reports=False,
    )
    timeseries = masker.fit_transform(str(selection.bold_path), confounds=confounds)
    if timeseries.ndim != 2 or timeseries.shape[1] == 0:
        raise ValueError("Atlas extraction produced no ROI time series.")
    roi_labels = roi_labels[: timeseries.shape[1]]

    connectome = ConnectivityMeasure(kind="correlation", standardize=False)
    matrix = connectome.fit_transform([timeseries])[0]
    matrix = np.nan_to_num(matrix, nan=0.0, posinf=1.0, neginf=-1.0)
    np.fill_diagonal(matrix, 1.0)

    csv_path = output_dir / "connectivity_matrix.csv"
    npy_path = output_dir / "connectivity_matrix.npy"
    png_path = output_dir / "connectivity_heatmap.png"
    ts_path = output_dir / "timeseries.tsv"
    meta_path = output_dir / "connectivity_metadata.json"
    html_path = output_dir / "connectivity_report.html"

    _write_matrix_csv(csv_path, matrix, roi_labels)
    np.save(npy_path, matrix)
    _write_heatmap(png_path, matrix, roi_labels)
    _write_timeseries(ts_path, timeseries, roi_labels)

    off_diag = matrix[~np.eye(matrix.shape[0], dtype=bool)]
    metadata: dict[str, Any] = {
        "atlas": ATLAS_NAME,
        "atlas_id": ATLAS_ID,
        "correlation_method": CORRELATION_METHOD,
        "nilearn_version": nilearn_version,
        "bold_file": str(selection.bold_path),
        "confounds_file": (
            str(selection.confounds_path) if selection.confounds_path else None
        ),
        "subject": selection.subject,
        "task": selection.task,
        "run": selection.run,
        "n_volumes": int(timeseries.shape[0]),
        "n_rois": int(timeseries.shape[1]),
        "matrix_shape": list(matrix.shape),
        "correlation_min": float(off_diag.min()) if off_diag.size else 1.0,
        "correlation_max": float(off_diag.max()) if off_diag.size else 1.0,
        "correlation_mean": float(off_diag.mean()) if off_diag.size else 1.0,
        "runtime_seconds": round(perf_counter() - started, 3),
        "roi_labels": roi_labels,
    }
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    _write_html_report(
        html_path,
        metadata,
        matrix,
        {
            "Connectivity Matrix CSV": csv_path.name,
            "Connectivity Matrix NPY": npy_path.name,
            "Heatmap PNG": png_path.name,
            "ROI Time Series TSV": ts_path.name,
            "Metadata JSON": meta_path.name,
        },
    )

    print(f"[neuroforge] Wrote matrix: {csv_path}")
    print(f"[neuroforge] Wrote heatmap: {png_path}")
    print(f"[neuroforge] Wrote report: {html_path}")
    print(f"[neuroforge] Completed in {metadata['runtime_seconds']}s")
    return 0


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
