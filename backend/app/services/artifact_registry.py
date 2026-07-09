"""Artifact registry — resolves what a completed run produced.

Given a manifest and a completed run's context (output_dir, params, status),
returns a list of ResolvedArtifact objects describing each artifact the pipeline
declares it produces.

This module is read-only infrastructure. It does not modify runs, write to the
DB, or change execution behavior. It is the backend foundation for workflow
chaining: the UI will eventually call this to populate "Use Output" buttons.
"""

from __future__ import annotations

import fnmatch
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

log = logging.getLogger(__name__)

# Resolved at import time — same pattern as pipeline.py for Docker vs local.
_SCHEMA_DIR = Path("/pipelines/schema")
if not _SCHEMA_DIR.is_dir():
    _SCHEMA_DIR = Path(__file__).parent.parent.parent.parent / "pipelines" / "schema"

_ARTIFACT_TYPES_PATH = _SCHEMA_DIR / "artifact_types.yaml"

_artifact_types_cache: dict[str, Any] | None = None


def _load_artifact_types() -> dict[str, Any]:
    global _artifact_types_cache
    if _artifact_types_cache is None:
        try:
            with _ARTIFACT_TYPES_PATH.open() as f:
                data = yaml.safe_load(f)
            _artifact_types_cache = data.get("artifact_types", {})
        except Exception as exc:
            log.warning("Could not load artifact_types.yaml: %s", exc)
            _artifact_types_cache = {}
    return _artifact_types_cache


@dataclass
class ResolvedArtifact:
    """A single artifact produced by a completed run."""

    # From the manifest's produces[] entry
    type: str
    label: str
    description: str

    # Resolution result
    resolved: bool
    """True if at least one path was found on disk."""

    paths: list[str] = field(default_factory=list)
    """Absolute paths to the artifact file(s) on the host. Empty if not found."""

    resolution_source: str = "output_dir"
    """How the path was resolved: 'output_dir' (glob), 'source_param', or 'directory'."""

    multiple: bool = False
    """Whether the produce slot declared multiple: true."""

    @property
    def path(self) -> str | None:
        """Convenience: the single resolved path, or None."""
        return self.paths[0] if self.paths else None


def resolve_run_artifacts(
    manifest: dict[str, Any],
    output_dir: str,
    params: dict[str, Any],
    status: str,
) -> list[ResolvedArtifact]:
    """Return resolved artifacts for a run.

    Args:
        manifest: The pipeline manifest dict (from the registry).
        output_dir: The run's output directory path on the host.
        params: The run's effective params (parsed from params_json).
        status: The run's status string (e.g. 'success', 'failed').

    Returns:
        List of ResolvedArtifact objects, one per produces[] entry.
        For failed runs, artifacts are returned with resolved=False.
    """
    produce_slots: list[dict[str, Any]] = manifest.get("produces", [])
    if not produce_slots:
        return []

    out_path = Path(output_dir) if output_dir else None
    results: list[ResolvedArtifact] = []

    for slot in produce_slots:
        artifact_type = slot.get("type", "")
        label = slot.get("label", artifact_type)
        description = slot.get("description", "")
        multiple = slot.get("multiple", False)
        path_hint = slot.get("path_hint")
        source_param = slot.get("source_param")

        artifact = ResolvedArtifact(
            type=artifact_type,
            label=label,
            description=description,
            resolved=False,
            paths=[],
            multiple=multiple,
        )

        if status != "success":
            # Do not attempt path resolution for non-successful runs.
            results.append(artifact)
            continue

        # ── Resolution strategy ────────────────────────────────────────────

        if source_param:
            # Semantic artifact: path comes from the run's input params, not output_dir.
            # Example: bids_dataset_validated — the "artifact" is the validated dataset dir.
            # The stored param value is a host path; we try both the raw value and the
            # container-translated path (via from_host_path) so the registry works both
            # inside Docker and in local dev.
            param_val = params.get(source_param) or params.get(source_param.replace("-", "_"))
            if param_val:
                candidates = [str(param_val)]
                try:
                    from app.execution.docker_executor import from_host_path
                    translated = from_host_path(str(param_val))
                    if translated != str(param_val):
                        candidates.append(translated)
                except Exception:
                    pass

                for candidate in candidates:
                    p = Path(candidate)
                    if p.exists():
                        artifact.resolved = True
                        artifact.paths = [str(p)]
                        artifact.resolution_source = "source_param"
                        break
                if not artifact.resolved:
                    log.debug(
                        "Artifact source_param '%s'=%s: none of %s exist on disk",
                        source_param, param_val, candidates,
                    )
            else:
                log.debug(
                    "Artifact source_param '%s' not found in run params: %s",
                    source_param, list(params.keys()),
                )
            results.append(artifact)
            continue

        if out_path is None:
            results.append(artifact)
            continue

        if path_hint == "" or path_hint is None:
            # Empty or absent path_hint: the artifact IS the output directory itself.
            # Used for directory-type outputs: freesurfer_dir, mriqc_report, etc.
            if out_path.exists() and any(out_path.iterdir()):
                artifact.resolved = True
                artifact.paths = [str(out_path)]
                artifact.resolution_source = "directory"
            results.append(artifact)
            continue

        # Glob-based resolution: expand path_hint relative to output_dir.
        try:
            matched = sorted(out_path.glob(path_hint))
        except Exception as exc:
            log.warning("Glob failed for path_hint '%s' in %s: %s", path_hint, out_path, exc)
            matched = []

        if matched:
            artifact.resolved = True
            artifact.paths = [str(p) for p in matched]
            artifact.resolution_source = "output_dir"
        else:
            log.debug(
                "path_hint '%s' matched no files in %s",
                path_hint, out_path,
            )

        results.append(artifact)

    return results


def describe_artifact_type(type_slug: str) -> dict[str, Any]:
    """Return the artifact_types.yaml entry for a slug, or a minimal fallback."""
    types = _load_artifact_types()
    entry = types.get(type_slug)
    if entry:
        return {"slug": type_slug, **entry}
    return {"slug": type_slug, "label": type_slug, "description": "", "extensions": []}


def list_artifact_types() -> dict[str, Any]:
    """Return the full artifact type vocabulary."""
    return _load_artifact_types()
