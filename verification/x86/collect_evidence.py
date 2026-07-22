#!/usr/bin/env python3
"""Build a small, sanitized, deterministic x86 verification evidence ZIP."""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import subprocess
import tempfile
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = Path(__file__).with_name("evidence-manifest.schema.json")
FIXTURE_MANIFEST = ROOT / "verification/fixtures/fixture-manifest.json"
IMAGE_LOCK = Path(__file__).with_name("image-lock.json")
TEXT_SUFFIXES = {".json", ".txt", ".log", ".html", ".csv", ".tsv", ".sha256"}
SECRET_PATTERNS = [
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----"),
    re.compile(r"(?i)(aws_secret_access_key|secret_access_key|private_key)\s*[:=]"),
]
FORBIDDEN_NAMES = re.compile(r"(?i)(license\.txt|\.pem$|id_rsa|id_ed25519|\.env$)")


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _category(relative: Path) -> str | None:
    text = relative.as_posix()
    if text.startswith("logs/") and relative.suffix == ".log":
        return "log"
    if text.startswith("versions/"):
        return "version"
    if text.startswith("run-state/") and relative.suffix == ".json":
        return "run_metadata"
    if relative.name == "validation-results.json":
        return "validation"
    if text.startswith("reports/") and relative.suffix.lower() == ".html":
        return "report"
    if (
        text.startswith("screenshots/")
        and relative.suffix.lower() == ".png"
        and relative.name.startswith("approved-redacted-")
    ):
        return "screenshot"
    if text.startswith("checksums/"):
        return "checksum"
    if text.startswith("inventories/"):
        return "inventory"
    return None


def _sanitized_name(relative: Path) -> Path:
    return Path(re.sub(r"sub-[A-Za-z0-9]+", "fixture-subject", relative.as_posix()))


def _sanitize_text(data: bytes) -> bytes:
    text = data.decode("utf-8", errors="replace")
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            raise ValueError("Potential secret detected in evidence text")
    text = re.sub(r"sub-[A-Za-z0-9]+", "fixture-subject", text)
    text = re.sub(r"/home/[^/\s\"']+", "/home/<redacted-user>", text)
    text = re.sub(r"/Users/[^/\s\"']+", "/Users/<redacted-user>", text)
    return text.encode("utf-8")


def _command_version(command: list[str]) -> str:
    try:
        return subprocess.run(
            command, check=True, capture_output=True, text=True, timeout=15
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return "unavailable"


def _derived_candidates(
    evidence_dir: Path, generated: Path
) -> list[tuple[Path, Path, str]]:
    candidates: list[tuple[Path, Path, str]] = []
    versions = generated / "system.json"
    versions.parent.mkdir(parents=True, exist_ok=True)
    versions.write_text(
        json.dumps(
            {
                "platform": platform.platform(),
                "machine": platform.machine(),
                "python": platform.python_version(),
                "docker": _command_version(
                    ["docker", "version", "--format", "{{json .}}"]
                ),
                "compose": _command_version(["docker", "compose", "version"]),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    candidates.append((versions, Path("versions/system.json"), "version"))

    for state_path in sorted((evidence_dir / "run-state").glob("run-*-latest.json")):
        state = json.loads(state_path.read_text())
        output_dir = Path(state.get("output_dir") or "")
        pipeline = str(state.get("pipeline_manifest_id") or "unknown")
        if not output_dir.is_dir():
            continue
        inventory: list[dict] = []
        for path in sorted(output_dir.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(output_dir).as_posix()
            item = {"path": relative, "bytes": path.stat().st_size}
            if path.stat().st_size <= 5 * 1024 * 1024:
                item["sha256"] = _sha256(path)
            inventory.append(item)
            if len(inventory) >= 20_000:
                break
        inventory_path = generated / f"{pipeline}-output.json"
        inventory_path.write_text(
            json.dumps(inventory, indent=2, sort_keys=True) + "\n"
        )
        candidates.append(
            (
                inventory_path,
                Path(f"inventories/{pipeline}-output.json"),
                "inventory",
            )
        )
        for index, report in enumerate(sorted(output_dir.rglob("*.html"))[:5], start=1):
            candidates.append(
                (
                    report,
                    Path(f"reports/{pipeline}-report-{index}.html"),
                    "report",
                )
            )
    return candidates


def collect(evidence_dir: Path, output: Path) -> dict:
    fixture = json.loads(FIXTURE_MANIFEST.read_text())
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    manifest = {
        "schema_version": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "git_commit": commit,
        "fixture_id": fixture["fixture_id"],
        "redactions": ["home-directory usernames", "BIDS subject labels"],
        "files": [],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="neuravian-evidence-") as temp:
        temp_root = Path(temp)
        stage = temp_root / "stage"
        generated = temp_root / "generated"
        stage.mkdir()
        generated.mkdir()
        candidates: list[tuple[Path, Path, str]] = []
        for source in sorted(evidence_dir.rglob("*")):
            if not source.is_file():
                continue
            relative = source.relative_to(evidence_dir)
            category = _category(relative)
            if category:
                candidates.append((source, _sanitized_name(relative), category))
        candidates.extend(_derived_candidates(evidence_dir, generated))
        candidates.append((IMAGE_LOCK, Path("image-lock.json"), "image_digest"))
        for source, relative, category in candidates:
            if FORBIDDEN_NAMES.search(relative.name):
                raise ValueError(f"Forbidden evidence filename: {relative}")
            if source.stat().st_size > 25 * 1024 * 1024:
                raise ValueError(f"Evidence file exceeds 25 MiB: {source}")
            data = source.read_bytes()
            if source.suffix.lower() in TEXT_SUFFIXES:
                data = _sanitize_text(data)
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            manifest["files"].append(
                {
                    "path": relative.as_posix(),
                    "bytes": len(data),
                    "sha256": _sha256(destination),
                    "category": category,
                }
            )
        jsonschema.validate(manifest, json.loads(SCHEMA.read_text()))
        manifest_path = stage / "evidence-manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        with zipfile.ZipFile(
            output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
        ) as archive:
            for path in sorted(stage.rglob("*")):
                if not path.is_file():
                    continue
                info = zipfile.ZipInfo(
                    path.relative_to(stage).as_posix(), (2026, 1, 1, 0, 0, 0)
                )
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                archive.writestr(info, path.read_bytes(), compresslevel=9)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = collect(args.evidence_dir, args.output)
    print(
        json.dumps(
            {"output": str(args.output), "files": len(result["files"])}, indent=2
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
