"""Shared BIDS path utilities for NeuroForge native functional tools.

These helpers replace private-underscore imports from functional_connectivity
that were previously scattered across alff_falff, regional_homogeneity,
seed_based_connectivity, and atlas_roi_extraction.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class BoldSelection:
    bold_path: Path
    confounds_path: Path | None
    subject: str | None
    task: str | None
    run: str | None


def bids_entity(path: Path, name: str) -> str | None:
    """Extract a BIDS entity value from a filename, e.g. bids_entity(p, 'sub') → '01'."""
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


def find_matching_confounds(path: Path) -> Path | None:
    """Return the fMRIPrep confounds TSV sibling of a preprocessed BOLD file, or None."""
    prefix = _prefix_for_confounds(path)
    candidates = sorted(path.parent.glob(f"{prefix}*_desc-confounds_timeseries.tsv"))
    return candidates[0] if candidates else None


def select_bold_file(
    fmriprep_dir: Path,
    subject_label: str | None,
    task_label: str | None,
    run_label: str | None,
) -> BoldSelection:
    """Return the first preprocessed BOLD file matching the given BIDS entity filters."""
    bolds = sorted(fmriprep_dir.glob("sub-*/func/*desc-preproc_bold.nii.gz"))
    if not bolds:
        raise FileNotFoundError(
            "No fMRIPrep preprocessed BOLD files were found. Expected files like "
            "sub-01/func/sub-01_task-rest_space-MNI152NLin2009cAsym_desc-preproc_bold.nii.gz."
        )

    def keep(p: Path) -> bool:
        return (
            (not subject_label or bids_entity(p, "sub") == subject_label)
            and (not task_label or bids_entity(p, "task") == task_label)
            and (not run_label or bids_entity(p, "run") == run_label)
        )

    filtered = [p for p in bolds if keep(p)]
    if not filtered:
        raise FileNotFoundError(
            "No preprocessed BOLD file matched the selected subject/task/run filters."
        )

    bold_path = filtered[0]
    return BoldSelection(
        bold_path=bold_path,
        confounds_path=find_matching_confounds(bold_path),
        subject=bids_entity(bold_path, "sub"),
        task=bids_entity(bold_path, "task"),
        run=bids_entity(bold_path, "run"),
    )
