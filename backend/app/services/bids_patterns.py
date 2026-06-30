"""
Plain-language pattern matchers for the most common beginner BIDS mistakes.
Each checker receives the dataset path and returns zero or more ValidationIssue dicts.
New patterns can be added here without touching any other service code.
"""

import json
import os
import re
from pathlib import Path
from typing import TypedDict


class RawIssue(TypedDict):
    code: str
    message: str
    friendly: str
    fix_hint: str | None
    files: list[str]


# Canonical BIDS entity order for filenames (sub and ses must always come first)
_ENTITY_ORDER = ["sub", "ses", "task", "acq", "ce", "rec", "dir", "run", "echo", "part", "chunk", "res", "den", "label", "split"]


def _rel(path: Path, root: Path) -> str:
    return str(path.relative_to(root))


def check_missing_dataset_description(root: Path) -> list[RawIssue]:
    if not (root / "dataset_description.json").exists():
        return [
            {
                "code": "MISSING_DATASET_DESCRIPTION",
                "message": "dataset_description.json not found at dataset root",
                "friendly": (
                    "Your dataset is missing the required dataset_description.json file. "
                    "This file tells tools like fMRIPrep what your dataset is called and which "
                    "version of the BIDS specification it follows."
                ),
                "fix_hint": (
                    'Create dataset_description.json at the root of your dataset with at minimum: '
                    '{"Name": "My Dataset", "BIDSVersion": "1.9.0"}'
                ),
                "files": ["dataset_description.json"],
            }
        ]
    return []


def check_missing_participants_tsv(root: Path) -> list[RawIssue]:
    if not (root / "participants.tsv").exists():
        return [
            {
                "code": "MISSING_PARTICIPANTS_TSV",
                "message": "participants.tsv not found at dataset root",
                "friendly": (
                    "Your dataset is missing participants.tsv. This file lists all participants "
                    "and is strongly recommended — many tools expect it to exist."
                ),
                "fix_hint": (
                    "Create participants.tsv at the dataset root with at minimum a "
                    "'participant_id' column listing your subject labels (e.g. sub-01)."
                ),
                "files": ["participants.tsv"],
            }
        ]
    return []


def check_nifti_without_sidecar(root: Path) -> list[RawIssue]:
    """Every NIfTI file should have a matching .json sidecar."""
    missing: list[str] = []
    for nii in root.rglob("*.nii*"):
        # strip .gz then .nii to get the stem
        stem = nii.name
        for ext in (".gz", ".nii"):
            if stem.endswith(ext):
                stem = stem[: -len(ext)]
        sidecar = nii.with_name(stem + ".json")
        if not sidecar.exists():
            missing.append(_rel(nii, root))

    if missing:
        return [
            {
                "code": "MISSING_JSON_SIDECAR",
                "message": f"{len(missing)} NIfTI file(s) are missing a JSON sidecar",
                "friendly": (
                    f"{len(missing)} of your imaging file(s) don't have a matching JSON sidecar. "
                    "BIDS requires a .json file alongside every .nii or .nii.gz that contains "
                    "scan parameters (TR, slice timing, etc.). Many tools will refuse to run "
                    "without these."
                ),
                "fix_hint": (
                    "For each .nii/.nii.gz listed below, create a .json file with the same "
                    "name (just swap the extension). At minimum include RepetitionTime for "
                    "functional data. Your scanner's DICOM-to-BIDS converter (dcm2bids, "
                    "heudiconv) can generate these automatically."
                ),
                "files": missing[:20],  # cap to avoid huge payloads
            }
        ]
    return []


def check_subject_label_mismatch(root: Path) -> list[RawIssue]:
    """Subject labels found in sub-XX folders but not listed in participants.tsv."""
    ptsp = root / "participants.tsv"
    if not ptsp.exists():
        return []  # already caught by check_missing_participants_tsv

    try:
        lines = ptsp.read_text().splitlines()
        if not lines:
            return []
        listed = {
            line.split("\t")[0].strip().removeprefix("sub-")
            for line in lines[1:]  # skip header
            if line.strip()
        }
    except Exception:
        return []

    on_disk = {
        d.name.removeprefix("sub-")
        for d in root.iterdir()
        if d.is_dir() and d.name.startswith("sub-")
    }

    unlisted = on_disk - listed
    if unlisted:
        labels = sorted(unlisted)
        return [
            {
                "code": "SUBJECT_NOT_IN_PARTICIPANTS_TSV",
                "message": f"Subject(s) {labels} found on disk but not in participants.tsv",
                "friendly": (
                    f"The subject folder(s) {labels} exist in your dataset but are not listed "
                    "in participants.tsv. Tools like fMRIPrep filter by participants.tsv, so "
                    "these subjects may be silently skipped."
                ),
                "fix_hint": "Add a row for each missing subject to participants.tsv.",
                "files": [f"sub-{s}" for s in labels],
            }
        ]
    return []


def check_entity_order(root: Path) -> list[RawIssue]:
    """
    Detect filenames where BIDS entities appear in the wrong order.
    E.g. sub-01_run-1_task-rest_bold.nii.gz (task after run is invalid).
    """
    bad: list[str] = []
    entity_re = re.compile(r"([a-z]+)-[a-zA-Z0-9+]+")

    for f in root.rglob("*"):
        if not f.is_file():
            continue
        # Only check files that look like BIDS (have at least sub- in their name)
        if "sub-" not in f.name:
            continue
        # Entities in the order they appear in the filename
        in_file_order = [
            m.group(1)
            for m in entity_re.finditer(f.stem)
            if m.group(1) in set(_ENTITY_ORDER)
        ]
        # What the canonical order of those same entities should be
        canonical = [e for e in _ENTITY_ORDER if e in set(in_file_order)]
        if in_file_order != canonical:
            bad.append(_rel(f, root))

    if bad:
        return [
            {
                "code": "WRONG_ENTITY_ORDER",
                "message": f"{len(bad)} file(s) have BIDS entities in the wrong order",
                "friendly": (
                    f"{len(bad)} filename(s) have BIDS key-value pairs in the wrong order. "
                    "BIDS requires a specific order: sub → ses → task → acq → run → echo → …. "
                    "Most tools will reject files that don't follow this order exactly."
                ),
                "fix_hint": (
                    "Rename the affected files so entities appear in the canonical BIDS order. "
                    "Your DICOM converter likely has an option to enforce this automatically."
                ),
                "files": bad[:20],
            }
        ]
    return []


# Registry — ordered from most to least severe
_ERROR_CHECKERS = [check_missing_dataset_description]
_WARNING_CHECKERS = [
    check_missing_participants_tsv,
    check_nifti_without_sidecar,
    check_subject_label_mismatch,
    check_entity_order,
]


def run_pattern_checks(root: Path) -> tuple[list[RawIssue], list[RawIssue]]:
    """Return (errors, warnings) from all registered pattern checkers."""
    errors: list[RawIssue] = []
    warnings: list[RawIssue] = []
    for checker in _ERROR_CHECKERS:
        errors.extend(checker(root))
    for checker in _WARNING_CHECKERS:
        warnings.extend(checker(root))
    return errors, warnings
