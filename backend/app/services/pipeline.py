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
    has_container = "container" in data
    has_execution = "execution" in data
    if not has_container and not has_execution:
        raise ManifestError(f"{path.name}: must have either 'container' or 'execution' block")
    if has_container and has_execution:
        raise ManifestError(f"{path.name}: cannot have both 'container' and 'execution' blocks")
    if data.get("run_as_host_user") and data.get("run_as_user") is not None:
        raise ManifestError(
            f"{path.name}: run_as_host_user and run_as_user are mutually exclusive"
        )
    _validate_chaining_fields(path.name, data)
    return data


def _validate_chaining_fields(filename: str, data: dict[str, Any]) -> None:
    """Emit startup warnings (not errors) for invalid accepts/produces fields.

    Validates that:
    - accepts[].param refers to an existing parameters[].name, unless dataset_slot is true
    - accepts[] entries have either param or dataset_slot: true, not neither
    - produces[] entries with source_param have that param in parameters[]
    """
    param_names = {p["name"] for p in data.get("parameters", [])}
    pid = data.get("id", filename)

    for i, slot in enumerate(data.get("accepts", [])):
        is_dataset_slot = slot.get("dataset_slot", False)
        param = slot.get("param")
        if is_dataset_slot:
            if param:
                log.warning(
                    "Manifest %s: accepts[%d] has both dataset_slot:true and param:'%s' — "
                    "param is ignored when dataset_slot is true",
                    pid, i, param,
                )
        else:
            if not param:
                log.warning(
                    "Manifest %s: accepts[%d] (type:'%s') has no param and dataset_slot is false — "
                    "this accept slot cannot be used for chaining",
                    pid, i, slot.get("type", "?"),
                )
            elif param not in param_names:
                log.warning(
                    "Manifest %s: accepts[%d].param '%s' does not match any parameters[].name — "
                    "chaining to this slot will fail at runtime. Valid names: %s",
                    pid, i, param, sorted(param_names),
                )

    for i, slot in enumerate(data.get("produces", [])):
        src = slot.get("source_param")
        if src and src not in param_names:
            log.warning(
                "Manifest %s: produces[%d].source_param '%s' does not match any parameters[].name — "
                "semantic artifact path resolution will fail. Valid names: %s",
                pid, i, src, sorted(param_names),
            )


def load_all_manifests() -> dict[str, dict[str, Any]]:
    """Return {pipeline_id: manifest_dict} for core and all enabled plugin pipelines."""
    schema = _load_schema()
    registry: dict[str, dict[str, Any]] = {}

    # Core manifests
    for yaml_path in sorted(_PIPELINES_DIR.glob("*.yaml")):
        manifest = _load_manifest(yaml_path, schema)
        pid = manifest["id"]
        if pid in registry:
            raise ManifestError(f"Duplicate pipeline id '{pid}' in {yaml_path.name}")
        registry[pid] = manifest
        log.info("Loaded pipeline manifest: %s (%s)", pid, manifest["display_name"])

    # Plugin manifests (lazy import avoids circular dependency at module level)
    try:
        from app.services.plugin_loader import iter_plugin_manifests
        for pid, manifest in iter_plugin_manifests():
            if pid in registry:
                raise ManifestError(
                    f"Plugin pipeline id '{pid}' conflicts with an existing pipeline"
                )
            registry[pid] = manifest
            log.info(
                "Loaded plugin pipeline manifest: %s (%s)",
                pid, manifest.get("display_name", pid),
            )
    except ImportError:
        pass

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
        """Return summary dicts (id, display_name, description, container or execution)."""
        return [
            {
                "id": m["id"],
                "display_name": m["display_name"],
                "description": m["description"],
                "homepage": m.get("homepage"),
                "container": m.get("container"),
                "execution": m.get("execution"),
                "compute_profile": m.get("compute_profile"),
                "category": m.get("category"),
                "input_type": m.get("input_type"),
            }
            for m in self._registry.values()
        ]

    def get_by_id(self, pipeline_id: str) -> dict[str, Any] | None:
        return self._registry.get(pipeline_id)
