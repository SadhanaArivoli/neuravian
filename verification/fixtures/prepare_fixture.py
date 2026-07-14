#!/usr/bin/env python3
"""Prepare and validate the small CC0 fixture used for x86_64 verification."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np

DEFAULT_MANIFEST = Path(__file__).with_name("fixture-manifest.json")


class FixtureError(RuntimeError):
    """A fixture is absent, altered, or structurally invalid."""


def load_manifest(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    files = data.get("files")
    if data.get("schema_version") != 1 or not isinstance(files, list) or not files:
        raise FixtureError("Fixture manifest has an unsupported or incomplete schema")
    expected_total = sum(int(item["bytes"]) for item in files)
    transfer = data.get("transfer", {})
    if transfer.get("file_count") != len(files):
        raise FixtureError("Manifest file_count does not match files")
    if transfer.get("total_bytes") != expected_total:
        raise FixtureError("Manifest total_bytes does not match files")
    return data


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_files(root: Path, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for expected in manifest["files"]:
        relative = Path(expected["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise FixtureError(f"Unsafe manifest path: {relative}")
        path = root / relative
        if not path.is_file():
            raise FixtureError(f"Required fixture file is missing: {relative}")
        actual_bytes = path.stat().st_size
        if actual_bytes != expected["bytes"]:
            raise FixtureError(
                f"Size mismatch for {relative}: expected {expected['bytes']}, "
                f"got {actual_bytes}"
            )
        actual_sha = sha256(path)
        if actual_sha != expected["sha256"]:
            raise FixtureError(f"Checksum mismatch for {relative}")
        results.append(
            {"path": relative.as_posix(), "bytes": actual_bytes, "sha256": actual_sha}
        )
    return results


def validate_bids(root: Path, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    description = json.loads((root / "dataset_description.json").read_text())
    if description.get("DatasetDOI") != manifest["source"]["doi"]:
        raise FixtureError("dataset_description.json DOI does not match the manifest")
    if description.get("License") != manifest["source"]["license"]:
        raise FixtureError(
            "dataset_description.json license does not match the manifest"
        )

    images: list[dict[str, Any]] = []
    for item in manifest["files"]:
        if not item["path"].endswith((".nii", ".nii.gz")):
            continue
        relative = Path(item["path"])
        image = nib.load(root / relative)
        shape = tuple(int(value) for value in image.shape)
        if len(shape) not in (3, 4) or any(value <= 0 for value in shape):
            raise FixtureError(f"Invalid NIfTI dimensions for {relative}: {shape}")
        affine_valid = np.isfinite(image.affine).all()
        affine_nonsingular = np.linalg.det(image.affine[:3, :3]) != 0
        if not affine_valid or not affine_nonsingular:
            raise FixtureError(f"Invalid NIfTI affine for {relative}")
        images.append(
            {
                "path": relative.as_posix(),
                "shape": list(shape),
                "dtype": str(image.get_data_dtype()),
            }
        )
    if not any(len(item["shape"]) == 3 for item in images):
        raise FixtureError("Fixture does not contain a 3D anatomical NIfTI")
    if not any(len(item["shape"]) == 4 for item in images):
        raise FixtureError("Fixture does not contain a 4D functional NIfTI")
    return images


def validate(root: Path, manifest_path: Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    manifest = load_manifest(manifest_path)
    files = validate_files(root, manifest)
    images = validate_bids(root, manifest)
    return {
        "status": "valid",
        "fixture_id": manifest["fixture_id"],
        "root": str(root.resolve()),
        "file_count": len(files),
        "total_bytes": sum(item["bytes"] for item in files),
        "images": images,
    }


def prepare(
    source: Path,
    output: Path,
    manifest_path: Path = DEFAULT_MANIFEST,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    manifest = load_manifest(manifest_path)
    source_result = validate(source, manifest_path)
    if dry_run:
        return {
            **source_result,
            "status": "dry-run-valid",
            "output": str(output.resolve()),
        }
    output.mkdir(parents=True, exist_ok=True)
    for item in manifest["files"]:
        relative = Path(item["path"])
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, destination)
    result = validate(output, manifest_path)
    return {**result, "status": "prepared", "source": str(source.resolve())}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=os.getenv("NEUROFORGE_FIXTURE_SOURCE"),
        help="OpenNeuro ds000001 v1.0.0 root (or set NEUROFORGE_FIXTURE_SOURCE)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).parent / "prepared" / "x86-minimal-bids",
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.source is None:
        print(
            "error: --source or NEUROFORGE_FIXTURE_SOURCE is required",
            file=sys.stderr,
        )
        return 2
    try:
        if args.validate_only:
            result = validate(args.source, args.manifest)
        else:
            result = prepare(
                args.source, args.output, args.manifest, dry_run=args.dry_run
            )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (FixtureError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
