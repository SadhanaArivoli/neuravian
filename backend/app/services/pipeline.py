"""Pipeline manifest registry.

Loads YAML manifests from the pipelines/ directory at startup, validates
each against the JSON Schema, and exposes them as plain dicts / Pydantic
models for the API layer.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import jsonschema
import yaml

log = logging.getLogger(__name__)

# Resolved at import time so the registry can be built before the FastAPI
# app starts accepting requests.
# In Docker the volume is mounted at /pipelines. For local dev (uv run from
# backend/) the manifests are at ../../pipelines relative to this file.
_DOCKER_PIPELINES = Path("/pipelines")
_LOCAL_PIPELINES = Path(__file__).parent.parent.parent.parent / "pipelines"
_PIPELINES_DIR = _DOCKER_PIPELINES if _DOCKER_PIPELINES.is_dir() else _LOCAL_PIPELINES
_SCHEMA_PATH = _PIPELINES_DIR / "schema" / "manifest.schema.json"


class ManifestError(ValueError):
    """Raised when a manifest file fails schema validation."""


def _load_schema() -> dict[str, Any]:
    with _SCHEMA_PATH.open() as f:
        return json.load(f)


def _load_manifest(path: Path, schema: dict[str, Any]) -> dict[str, Any]:
    with path.open() as f:
        data = yaml.safe_load(f)
    try:
        jsonschema.validate(data, schema)
    except jsonschema.ValidationError as exc:
        raise ManifestError(f"{path.name}: {exc.message}") from exc
    return data


def load_all_manifests() -> dict[str, dict[str, Any]]:
    """Return {pipeline_id: manifest_dict} for every valid .yaml in pipelines/."""
    schema = _load_schema()
    registry: dict[str, dict[str, Any]] = {}
    for yaml_path in sorted(_PIPELINES_DIR.glob("*.yaml")):
        try:
            manifest = _load_manifest(yaml_path, schema)
        except ManifestError as exc:
            # Reject the entire startup if any manifest is malformed.
            raise
        pid = manifest["id"]
        if pid in registry:
            raise ManifestError(f"Duplicate pipeline id '{pid}' in {yaml_path.name}")
        registry[pid] = manifest
        log.info("Loaded pipeline manifest: %s (%s)", pid, manifest["display_name"])
    return registry


# Module-level registry built once at import time.
# Tests that need to inject manifests can replace this directly.
_registry: dict[str, dict[str, Any]] | None = None


def get_registry() -> dict[str, dict[str, Any]]:
    global _registry
    if _registry is None:
        _registry = load_all_manifests()
    return _registry


class PipelineService:
    def __init__(self) -> None:
        self._registry = get_registry()

    def list_all(self) -> list[dict[str, Any]]:
        """Return summary dicts (id, display_name, description, container)."""
        return [
            {
                "id": m["id"],
                "display_name": m["display_name"],
                "description": m["description"],
                "homepage": m.get("homepage"),
                "container": m["container"],
            }
            for m in self._registry.values()
        ]

    def get_by_id(self, pipeline_id: str) -> dict[str, Any] | None:
        return self._registry.get(pipeline_id)
