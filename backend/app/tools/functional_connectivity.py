"""Functional Connectivity native pipeline.

This module is intentionally narrow: it turns one fMRIPrep preprocessed BOLD
run into atlas time series, a Pearson correlation matrix, a PNG heatmap, and a
small HTML report. It is exposed through the
``neuroforge-functional-connectivity`` console script and launched by
NativeExecutor, not by arbitrary user Python.
"""
# ruff: noqa: E402, I001

from __future__ import annotations

import argparse
import html
import json
import os
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
plt.style.use("dark_background")
import nibabel as nib
import numpy as np
import pandas as pd
from nilearn import __version__ as nilearn_version
from nilearn.connectome import ConnectivityMeasure
from nilearn.datasets import (
    fetch_atlas_aal,
    fetch_atlas_harvard_oxford,
    fetch_atlas_schaefer_2018,
)
from nilearn.maskers import NiftiLabelsMasker

from app.reporting import document_shell, figure_block, footer, info_box, key_value_table, save_dark_figure, statistics_cards
from app.tools.bids_utils import (
    BoldSelection,
    bids_entity,
    find_matching_confounds,
    select_bold_file,
)
from app.tools.confounds import CONFOUND_STRATEGIES, ConfoundSelection, select_confounds


DEFAULT_ATLAS_ID = "schaefer100_7"
LEGACY_ATLAS_ALIASES = {"schaefer_100_7": DEFAULT_ATLAS_ID}
CORRELATION_METHOD = "Pearson correlation"
DEFAULT_CONFOUND_STRATEGY = "motion6_wm_csf_gsr"


@dataclass(frozen=True)
class AtlasSpec:
    id: str
    display_name: str
    expected_roi_count: int
    fetcher_name: str
    atlas_type: str
    space: str
    resolution: str
    label_source: str
    source: str
    citation: str
    network_count: int | None = None


@dataclass
class LoadedAtlas:
    spec: AtlasSpec
    labels_img: str
    roi_labels: list[str]
    label_values: list[int]
    masker_labels: list[str] | None = None
    lut: Any | None = None
    version: str | None = None
    template: str | None = None
    atlas_type: str | None = None


@dataclass
class BoldSelection:
    bold_path: Path
    confounds_path: Path | None
    subject: str | None
    task: str | None
    run: str | None


ATLAS_REGISTRY: dict[str, AtlasSpec] = {
    "schaefer100_7": AtlasSpec(
        id="schaefer100_7",
        display_name="Schaefer 2018, 100 parcels, 7 networks",
        expected_roi_count=100,
        fetcher_name="fetch_atlas_schaefer_2018",
        atlas_type="deterministic label atlas",
        space="MNI152",
        resolution="2 mm",
        label_source="Schaefer parcel names with Yeo 7-network annotations",
        source="https://nilearn.github.io/stable/modules/generated/nilearn.datasets.fetch_atlas_schaefer_2018.html",
        citation="Schaefer et al. 2018; Yeo et al. 2011",
        network_count=7,
    ),
    "schaefer200_7": AtlasSpec(
        id="schaefer200_7",
        display_name="Schaefer 2018, 200 parcels, 7 networks",
        expected_roi_count=200,
        fetcher_name="fetch_atlas_schaefer_2018",
        atlas_type="deterministic label atlas",
        space="MNI152",
        resolution="2 mm",
        label_source="Schaefer parcel names with Yeo 7-network annotations",
        source="https://nilearn.github.io/stable/modules/generated/nilearn.datasets.fetch_atlas_schaefer_2018.html",
        citation="Schaefer et al. 2018; Yeo et al. 2011",
        network_count=7,
    ),
    "aal": AtlasSpec(
        id="aal",
        display_name="AAL 3v2",
        expected_roi_count=166,
        fetcher_name="fetch_atlas_aal",
        atlas_type="deterministic label atlas",
        space="MNI",
        resolution="2 mm",
        label_source="AAL 3v2 label lookup table",
        source="https://nilearn.github.io/stable/modules/generated/nilearn.datasets.fetch_atlas_aal.html",
        citation="Rolls et al. 2020; Tzourio-Mazoyer et al. 2002",
    ),
    "harvard_oxford_cortical": AtlasSpec(
        id="harvard_oxford_cortical",
        display_name="Harvard-Oxford cortical atlas",
        expected_roi_count=48,
        fetcher_name="fetch_atlas_harvard_oxford",
        atlas_type="deterministic max-probability label atlas",
        space="MNI152",
        resolution="2 mm",
        label_source="Harvard-Oxford cortical label list",
        source="https://nilearn.github.io/stable/modules/generated/nilearn.datasets.fetch_atlas_harvard_oxford.html",
        citation="Frazier et al. 2005; Makris et al. 2006; Desikan et al. 2006; FSL Harvard-Oxford atlas",
    ),
}


def normalize_atlas_id(atlas_id: str | None) -> str:
    selected = atlas_id or DEFAULT_ATLAS_ID
    selected = LEGACY_ATLAS_ALIASES.get(selected, selected)
    if selected not in ATLAS_REGISTRY:
        allowed = ", ".join(sorted(ATLAS_REGISTRY))
        raise ValueError(f"Unknown atlas '{atlas_id}'. Allowed values: {allowed}")
    return selected


# Backward-compat aliases — external modules should import from bids_utils directly.
_entity = bids_entity
_matching_confounds = find_matching_confounds
_select_bold = select_bold_file


def _decode_label(label: Any) -> str:
    if isinstance(label, bytes):
        return label.decode("utf-8")
    return str(label)


def _labels_without_background(labels: list[str]) -> list[str]:
    if labels and labels[0].strip().lower() in {"background", "bg", "0"}:
        return labels[1:]
    return labels


def _label_values_without_background(values: list[int], labels: list[str]) -> list[int]:
    if labels and labels[0].strip().lower() in {"background", "bg", "0"}:
        return values[1:]
    return values


def _consecutive_label_values(labels: list[str]) -> list[int]:
    if labels and labels[0].strip().lower() in {"background", "bg", "0"}:
        return list(range(len(labels)))
    return list(range(1, len(labels) + 1))


def load_atlas(atlas_id: str, data_dir: str | None) -> LoadedAtlas:
    normalized_id = normalize_atlas_id(atlas_id)
    spec = ATLAS_REGISTRY[normalized_id]

    if normalized_id.startswith("schaefer"):
        n_rois = spec.expected_roi_count
        atlas = fetch_atlas_schaefer_2018(
            n_rois=n_rois,
            yeo_networks=7,
            resolution_mm=2,
            data_dir=data_dir,
            verbose=1,
        )
        labels = [_decode_label(label) for label in atlas.labels]
        label_values = _consecutive_label_values(labels)
        return LoadedAtlas(
            spec=spec,
            labels_img=atlas.maps,
            roi_labels=_labels_without_background(labels),
            label_values=_label_values_without_background(label_values, labels),
            masker_labels=labels,
            lut=None,
            version=None,
            template=getattr(atlas, "template", None),
            atlas_type=getattr(atlas, "atlas_type", None),
        )

    if normalized_id == "aal":
        atlas = fetch_atlas_aal(version="3v2", data_dir=data_dir, verbose=1)
        labels = [_decode_label(label) for label in atlas.labels]
        indices = [int(index) for index in atlas.indices]
        # AAL image values are not consecutive; pass the BIDS-like LUT so
        # Nilearn preserves label/value mapping and ordering.
        lut = pd.DataFrame({"index": indices, "name": labels})
        return LoadedAtlas(
            spec=spec,
            labels_img=atlas.maps,
            roi_labels=_labels_without_background(labels),
            label_values=_label_values_without_background(indices, labels),
            lut=lut,
            version="3v2",
            template=getattr(atlas, "template", None),
            atlas_type=getattr(atlas, "atlas_type", None),
        )

    if normalized_id == "harvard_oxford_cortical":
        atlas = fetch_atlas_harvard_oxford(
            "cort-maxprob-thr25-2mm",
            data_dir=data_dir,
            symmetric_split=False,
            verbose=1,
        )
        labels = [_decode_label(label) for label in atlas.labels]
        label_values = _consecutive_label_values(labels)
        return LoadedAtlas(
            spec=spec,
            labels_img=atlas.maps,
            roi_labels=_labels_without_background(labels),
            label_values=_label_values_without_background(label_values, labels),
            masker_labels=labels,
            lut=None,
            version="cort-maxprob-thr25-2mm",
            template=getattr(atlas, "template", None),
            atlas_type=getattr(atlas, "atlas_type", None),
        )

    raise AssertionError(f"Unhandled atlas id: {normalized_id}")


_load_atlas = load_atlas  # backward-compat alias


def _write_matrix_csv(path: Path, matrix: np.ndarray, labels: list[str]) -> None:
    pd.DataFrame(matrix, index=labels, columns=labels).to_csv(path)


def _write_timeseries(path: Path, timeseries: np.ndarray, labels: list[str]) -> None:
    pd.DataFrame(timeseries, columns=labels).to_csv(path, sep="\t", index=False)


def network_from_label(label: str) -> str | None:
    parts = label.split("_")
    if len(parts) >= 3 and parts[0].endswith("Networks"):
        return parts[2]
    return None


_network_from_label = network_from_label  # backward-compat alias


def _voxel_counts(labels_img: str, label_values: list[int]) -> list[int]:
    data = np.asanyarray(nib.load(labels_img).dataobj)
    return [int(np.count_nonzero(data == value)) for value in label_values]


def build_roi_statistics(
    *,
    atlas: LoadedAtlas,
    timeseries: np.ndarray,
    labels: list[str],
) -> list[dict[str, Any]]:
    voxel_counts = _voxel_counts(atlas.labels_img, atlas.label_values[: len(labels)])
    rows: list[dict[str, Any]] = []
    for index, label in enumerate(labels):
        series = timeseries[:, index]
        rows.append({
            "roi_number": index + 1,
            "roi_label": label,
            "network": _network_from_label(label),
            "voxel_count": voxel_counts[index] if index < len(voxel_counts) else 0,
            "mean_signal": float(np.mean(series)),
            "std_signal": float(np.std(series, ddof=1)) if series.size > 1 else 0.0,
            "min_signal": float(np.min(series)),
            "max_signal": float(np.max(series)),
            "median_signal": float(np.median(series)),
        })
    return rows


def _write_roi_statistics(csv_path: Path, json_path: Path, rows: list[dict[str, Any]]) -> None:
    pd.DataFrame(rows).to_csv(csv_path, index=False)
    json_path.write_text(json.dumps(rows, indent=2), encoding="utf-8")


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
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)


def _write_html_report(
    path: Path,
    metadata: dict[str, Any],
    matrix: np.ndarray,
    outputs: dict[str, str],
) -> None:
    visible_metadata = [
        ("Subject", metadata.get("subject")), ("Task", metadata.get("task")),
        ("Run", metadata.get("run")), ("Atlas", metadata.get("atlas_display_name")),
        ("Atlas space", metadata.get("atlas_space")), ("Atlas version", metadata.get("atlas_version")),
        ("Regions", metadata.get("n_rois")), ("Volumes", metadata.get("n_volumes")),
        ("Volumes after cleaning", metadata.get("n_volumes_after_cleaning")),
        ("Correlation", "Pearson r"), ("Confound strategy", metadata.get("confound_strategy")),
        ("Confound regressors", metadata.get("n_confound_regressors")),
        ("Detrending", metadata.get("detrending")),
        ("Standardization", metadata.get("standardize")),
        ("Runtime (seconds)", metadata.get("runtime_seconds")),
    ]
    links = "".join(f'<li>{label}: <a href="{html.escape(value.rsplit("/", 1)[-1])}">{html.escape(value.rsplit("/", 1)[-1])}</a></li>' for label, value in outputs.items())
    body = (
        "<p>Atlas-based Pearson correlation matrix generated by NeuroForge.</p>"
        + figure_block(outputs["Heatmap PNG"], "Functional connectivity heatmap", "Pairwise ROI Pearson correlation matrix.")
        + "<h2>Summary</h2>" + key_value_table(visible_metadata)
        + statistics_cards({"Minimum r": f"{metadata.get('correlation_min', 0):.3f}", "Mean r": f"{metadata.get('correlation_mean', 0):.3f}", "Maximum r": f"{metadata.get('correlation_max', 0):.3f}"})
        + "<h2>Output files</h2><ul class=\"nf-downloads\">" + links + "</ul>"
        + info_box("Interpretation note", "This report computes descriptive connectivity only. It does not perform diagnosis, statistical testing, graph metrics, or machine learning.")
    )
    report = document_shell("Functional Connectivity Report", "Atlas-based descriptive connectivity", body, footer_html=footer())
    path.write_text(report, encoding="utf-8")


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run NeuroForge functional connectivity."
    )
    parser.add_argument("--fmriprep-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--atlas-name",
        default=DEFAULT_ATLAS_ID,
        choices=[*ATLAS_REGISTRY.keys(), *LEGACY_ATLAS_ALIASES.keys()],
    )
    parser.add_argument("--atlas-data-dir", default=None)
    parser.add_argument("--subject-label", default=None)
    parser.add_argument("--task-label", default=None)
    parser.add_argument("--run-label", default=None)
    parser.add_argument(
        "--confound-strategy",
        default=DEFAULT_CONFOUND_STRATEGY,
        choices=list(CONFOUND_STRATEGIES.keys()),
        help=(
            "Nuisance-regressor strategy applied before connectivity estimation. "
            "motion6_wm_csf_gsr includes global signal regression (GSR), which "
            "changes correlation sign and magnitude — apply consistently across runs."
        ),
    )
    args = parser.parse_args(argv)

    started = perf_counter()
    fmriprep_dir = Path(args.fmriprep_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    atlas_id = normalize_atlas_id(args.atlas_name)
    loaded_atlas = load_atlas(atlas_id, args.atlas_data_dir)
    confound_strategy: str = args.confound_strategy

    print(f"[neuroforge] Functional Connectivity using {loaded_atlas.spec.display_name}")
    print(f"[neuroforge] fMRIPrep derivatives: {fmriprep_dir}")
    print(f"[neuroforge] Confound strategy: {confound_strategy}")

    selection = select_bold_file(
        fmriprep_dir,
        args.subject_label,
        args.task_label,
        args.run_label,
    )
    print(f"[neuroforge] Selected BOLD: {selection.bold_path}")
    if selection.confounds_path:
        print(f"[neuroforge] Selected confounds: {selection.confounds_path}")
    else:
        if confound_strategy != "none":
            print(
                f"[neuroforge] WARNING: confound strategy '{confound_strategy}' requested "
                "but no confounds file was found. Proceeding without confound regression."
            )

    image = nib.load(str(selection.bold_path))
    if len(image.shape) != 4:
        raise ValueError(f"Selected BOLD file is not 4D: shape={image.shape}")
    n_vols = int(image.shape[3])

    # Resolve confounds — strict mode: fail loudly if requested columns are absent.
    cs: ConfoundSelection = select_confounds(
        selection.confounds_path,
        confound_strategy,
        n_vols,
        strict=True,
    )
    if cs.used:
        print(f"[neuroforge] Using {cs.n_regressors} confound regressors: {cs.used}")
    elif confound_strategy != "none":
        print("[neuroforge] No confound regressors applied (TSV not found).")

    masker = NiftiLabelsMasker(
        labels_img=loaded_atlas.labels_img,
        labels=loaded_atlas.masker_labels,
        lut=loaded_atlas.lut,
        standardize="zscore_sample",
        detrend=True,
        resampling_target="labels",
        reports=False,
    )
    timeseries = masker.fit_transform(str(selection.bold_path), confounds=cs.values)
    if timeseries.ndim != 2 or timeseries.shape[1] == 0:
        raise ValueError("Atlas extraction produced no ROI time series.")
    roi_labels = loaded_atlas.roi_labels[: timeseries.shape[1]]
    if timeseries.shape[1] != loaded_atlas.spec.expected_roi_count:
        raise ValueError(
            f"Atlas extraction produced {timeseries.shape[1]} ROI time series, "
            f"expected {loaded_atlas.spec.expected_roi_count} for "
            f"{loaded_atlas.spec.display_name}."
        )

    connectome = ConnectivityMeasure(kind="correlation", standardize=False)
    matrix = connectome.fit_transform([timeseries])[0]
    matrix = np.nan_to_num(matrix, nan=0.0, posinf=1.0, neginf=-1.0)
    np.fill_diagonal(matrix, 1.0)

    csv_path = output_dir / "connectivity_matrix.csv"
    npy_path = output_dir / "connectivity_matrix.npy"
    png_path = output_dir / "connectivity_heatmap.png"
    ts_path = output_dir / "timeseries.tsv"
    roi_stats_csv_path = output_dir / "roi_statistics.csv"
    roi_stats_json_path = output_dir / "roi_statistics.json"
    meta_path = output_dir / "connectivity_metadata.json"
    html_path = output_dir / "connectivity_report.html"

    roi_statistics = build_roi_statistics(
        atlas=loaded_atlas,
        timeseries=timeseries,
        labels=roi_labels,
    )
    _write_matrix_csv(csv_path, matrix, roi_labels)
    np.save(npy_path, matrix)
    _write_heatmap(png_path, matrix, roi_labels)
    _write_timeseries(ts_path, timeseries, roi_labels)
    _write_roi_statistics(roi_stats_csv_path, roi_stats_json_path, roi_statistics)

    off_diag = matrix[~np.eye(matrix.shape[0], dtype=bool)]
    metadata: dict[str, Any] = {
        "atlas": loaded_atlas.spec.display_name,
        "atlas_id": loaded_atlas.spec.id,
        "canonical_atlas_id": loaded_atlas.spec.id,
        "atlas_display_name": loaded_atlas.spec.display_name,
        "atlas_source": loaded_atlas.spec.source,
        "atlas_version": loaded_atlas.version,
        "atlas_fetcher": loaded_atlas.spec.fetcher_name,
        "atlas_type": loaded_atlas.atlas_type or loaded_atlas.spec.atlas_type,
        "atlas_space": loaded_atlas.template or loaded_atlas.spec.space,
        "atlas_resolution": loaded_atlas.spec.resolution,
        "atlas_citation": loaded_atlas.spec.citation,
        "atlas_network_count": loaded_atlas.spec.network_count,
        "correlation_method": CORRELATION_METHOD,
        "nilearn_version": nilearn_version,
        "bold_file": str(selection.bold_path),
        "confounds_file": (
            str(selection.confounds_path) if selection.confounds_path else None
        ),
        "subject": selection.subject,
        "task": selection.task,
        "run": selection.run,
        # ── Confound provenance ───────────────────────────────────────────────
        "confound_strategy": confound_strategy,
        "confounds_used": cs.used,
        "confounds_missing": cs.missing,
        "n_confound_regressors": cs.n_regressors,
        "global_signal_included": cs.global_signal_included,
        "detrending": "linear (NiftiLabelsMasker)",
        "standardize": "zscore_sample (NiftiLabelsMasker)",
        "scrubbing": "none",
        # ── Timepoints ───────────────────────────────────────────────────────
        "n_volumes": n_vols,
        "n_volumes_before_cleaning": n_vols,
        "n_volumes_after_cleaning": int(timeseries.shape[0]),
        "n_rois": int(timeseries.shape[1]),
        "roi_count": int(timeseries.shape[1]),
        "roi_statistics_generated": True,
        "roi_statistics_files": {
            "csv": roi_stats_csv_path.name,
            "json": roi_stats_json_path.name,
        },
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
            "ROI Statistics CSV": roi_stats_csv_path.name,
            "ROI Statistics JSON": roi_stats_json_path.name,
            "Metadata JSON": meta_path.name,
        },
    )

    print(f"[neuroforge] Wrote matrix: {csv_path}")
    print(f"[neuroforge] Wrote ROI statistics: {roi_stats_csv_path}")
    print(f"[neuroforge] Wrote heatmap: {png_path}")
    print(f"[neuroforge] Wrote report: {html_path}")
    print(f"[neuroforge] Completed in {metadata['runtime_seconds']}s")
    return 0


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
