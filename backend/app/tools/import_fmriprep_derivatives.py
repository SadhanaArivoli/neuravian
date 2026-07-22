"""Validate and register precomputed fMRIPrep derivatives for chaining."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from time import perf_counter
from typing import Any

import nibabel as nib
import pandas as pd


def _entity(path: Path, name: str) -> str | None:
    prefix = f"{name}-"
    for part in path.name.split("_"):
        if part.startswith(prefix):
            return part[len(prefix):]
    return None


def _prefix_for_confounds(path: Path) -> str:
    stem = path.name[:-7] if path.name.endswith(".nii.gz") else path.stem
    for marker in ("_space-", "_res-", "_desc-preproc_bold"):
        idx = stem.find(marker)
        if idx != -1:
            return stem[:idx]
    return stem


def _matching_confounds(path: Path) -> Path | None:
    prefix = _prefix_for_confounds(path)
    candidates = sorted(path.parent.glob(f"{prefix}*_desc-confounds_timeseries.tsv"))
    return candidates[0] if candidates else None


def _read_generated_by(root: Path) -> list[dict[str, Any]]:
    desc = root / "dataset_description.json"
    if not desc.exists():
        return []
    try:
        payload = json.loads(desc.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    generated_by = payload.get("GeneratedBy")
    return generated_by if isinstance(generated_by, list) else []


def _validate_bold(path: Path) -> dict[str, Any]:
    image = nib.load(str(path))
    if len(image.shape) != 4:
        raise ValueError(f"Preprocessed BOLD is not 4D: {path} shape={image.shape}")
    if image.shape[-1] < 2:
        raise ValueError(f"Preprocessed BOLD has fewer than 2 timepoints: {path}")

    confounds = _matching_confounds(path)
    confound_columns: list[str] = []
    if confounds:
        frame = pd.read_csv(confounds, sep="\t", nrows=1)
        confound_columns = list(frame.columns)

    return {
        "path": str(path),
        "subject": _entity(path, "sub"),
        "task": _entity(path, "task"),
        "run": _entity(path, "run"),
        "shape": list(image.shape),
        "confounds_file": str(confounds) if confounds else None,
        "confound_columns": confound_columns,
    }


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Import precomputed fMRIPrep derivatives into Neuravian."
    )
    parser.add_argument("--fmriprep-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)

    started = perf_counter()
    root = Path(args.fmriprep_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not root.exists():
        raise FileNotFoundError(f"fMRIPrep derivatives directory does not exist: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"fMRIPrep derivatives path is not a directory: {root}")

    bolds = sorted(root.glob("sub-*/func/*desc-preproc_bold.nii.gz"))
    if not bolds:
        raise FileNotFoundError(
            "No fMRIPrep preprocessed BOLD files were found. Expected files like "
            "sub-01/func/sub-01_task-rest_space-*_desc-preproc_bold.nii.gz."
        )

    scans = [_validate_bold(path) for path in bolds]
    generated_by = _read_generated_by(root)
    metadata = {
        "fmriprep_dir": str(root),
        "preprocessed_bold_count": len(scans),
        "subjects": sorted({scan["subject"] for scan in scans if scan["subject"]}),
        "tasks": sorted({scan["task"] for scan in scans if scan["task"]}),
        "runs": sorted({scan["run"] for scan in scans if scan["run"]}),
        "generated_by": generated_by,
        "scans": scans,
        "runtime_seconds": round(perf_counter() - started, 3),
    }

    metadata_path = output_dir / "fmriprep_import_metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(f"[neuravian] Imported fMRIPrep derivatives: {root}")
    print(f"[neuravian] Found {len(scans)} preprocessed BOLD file(s)")
    print(f"[neuravian] Wrote import metadata: {metadata_path}")
    return 0


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
