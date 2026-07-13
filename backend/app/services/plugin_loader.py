"""Plugin discovery and loading for NeuroForge.

Plugins extend NeuroForge without modifying core source code. Each plugin
is a directory containing:

  plugin.yaml        — required: plugin identity and metadata
  pipelines/*.yaml   — optional: pipeline manifests (same schema as core)
  artifact_types.yaml — optional: additional artifact type definitions
  backend/           — optional: native tool executables (added to PATH)
  README.md          — optional: developer documentation

Discovery order (first-found wins for conflicts):
  1. Paths listed in NEUROFORGE_PLUGINS_DIRS env var (colon-separated)
  2. /plugins-user  (Docker: user-supplied volume mount)
  3. /plugins       (Docker: core plugins shipped with the image)
  4. <repo-root>/plugins  (local dev)

Plugin pipelines are merged into the central pipeline registry at startup.
Plugin artifact types are merged into the artifact registry at startup.
The native tool executables directory is prepended to PATH so NativeExecutor
can find plugin-provided binaries via shutil.which().

This module is designed for lazy import: pipeline.py and artifact_registry.py
both import it inside function bodies to avoid circular imports.
"""

from __future__ import annotations

import json
import logging
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

import jsonschema
import yaml

log = logging.getLogger(__name__)

# ── Schema paths ──────────────────────────────────────────────────────────────

# In Docker the /pipelines volume is mounted. For local dev, the repo root is
# three levels above this file: backend/app/services/plugin_loader.py
_DOCKER_SCHEMA = Path("/pipelines/schema/plugin.schema.json")
_LOCAL_SCHEMA = Path(__file__).parent.parent.parent.parent / "plugins" / "schema" / "plugin.schema.json"
_PLUGIN_SCHEMA_PATH = _DOCKER_SCHEMA if _DOCKER_SCHEMA.is_file() else _LOCAL_SCHEMA

# ── Discovery paths ───────────────────────────────────────────────────────────

def _candidate_plugin_roots() -> list[Path]:
    """Return ordered list of directories to scan for plugin sub-directories."""
    candidates: list[Path] = []

    env_dirs = os.environ.get("NEUROFORGE_PLUGINS_DIRS", "")
    if env_dirs:
        for p in env_dirs.split(":"):
            p = p.strip()
            if p:
                candidates.append(Path(p))

    candidates.append(Path("/plugins-user"))
    candidates.append(Path("/plugins"))

    # Local dev: repo-root/plugins
    local_plugins = Path(__file__).parent.parent.parent.parent / "plugins"
    candidates.append(local_plugins)

    return candidates


def _find_plugin_dirs() -> list[Path]:
    """Return all directories that contain a plugin.yaml file."""
    found: list[Path] = []
    seen: set[Path] = set()

    for root in _candidate_plugin_roots():
        if not root.is_dir():
            continue
        # Each immediate sub-directory with a plugin.yaml is a plugin
        for subdir in sorted(root.iterdir()):
            if not subdir.is_dir():
                continue
            if subdir.name.startswith(".") or subdir.name == "schema":
                continue
            if not (subdir / "plugin.yaml").is_file():
                continue
            real = subdir.resolve()
            if real in seen:
                continue
            seen.add(real)
            found.append(subdir)

    return found


# ── Data model ────────────────────────────────────────────────────────────────

@dataclass
class PluginInfo:
    """Everything NeuroForge learned about an installed plugin."""

    plugin_dir: Path

    # From plugin.yaml
    id: str
    name: str
    version: str
    author: str
    description: str
    homepage: str | None = None
    neuroforge_version: str | None = None
    license: str | None = None
    dependencies: list[str] = field(default_factory=list)
    enabled: bool = True

    # Loaded content
    pipeline_ids: list[str] = field(default_factory=list)
    artifact_type_slugs: list[str] = field(default_factory=list)

    # Validation outcome
    status: str = "ok"           # "ok" | "disabled" | "error"
    error: str | None = None


class PluginError(ValueError):
    """Raised when a plugin fails validation."""


# ── Schema loader ─────────────────────────────────────────────────────────────

_plugin_schema: dict[str, Any] | None = None


def _get_plugin_schema() -> dict[str, Any]:
    global _plugin_schema
    if _plugin_schema is None:
        try:
            with _PLUGIN_SCHEMA_PATH.open() as f:
                _plugin_schema = json.load(f)
        except Exception as exc:
            log.warning("Could not load plugin schema at %s: %s", _PLUGIN_SCHEMA_PATH, exc)
            _plugin_schema = {}
    return _plugin_schema


# ── Module-level plugin registry ─────────────────────────────────────────────

# Populated by load_all_plugins() at startup.
_plugins: list[PluginInfo] = []
_plugin_manifests: dict[str, dict[str, Any]] = {}   # pipeline_id → manifest
_plugin_artifact_types: dict[str, Any] = {}          # slug → definition
_loaded: bool = False


def get_plugins() -> list[PluginInfo]:
    """Return all discovered plugins (including disabled and errored)."""
    return list(_plugins)


def iter_plugin_manifests() -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield (pipeline_id, manifest) for all enabled plugin pipelines."""
    yield from _plugin_manifests.items()


def iter_plugin_artifact_types() -> Iterator[tuple[str, Any]]:
    """Yield (slug, definition) for all enabled plugin artifact types."""
    yield from _plugin_artifact_types.items()


# ── Individual plugin loading ─────────────────────────────────────────────────

def _load_plugin_yaml(plugin_dir: Path) -> dict[str, Any]:
    """Load and validate plugin.yaml."""
    yaml_path = plugin_dir / "plugin.yaml"
    with yaml_path.open() as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise PluginError(f"{plugin_dir.name}/plugin.yaml: expected a YAML mapping")
    schema = _get_plugin_schema()
    if schema:
        try:
            jsonschema.validate(data, schema)
        except jsonschema.ValidationError as exc:
            raise PluginError(f"{plugin_dir.name}/plugin.yaml: {exc.message}") from exc
    return data


def _load_plugin_manifests(
    plugin_dir: Path,
    known_core_ids: set[str],
    known_plugin_ids: set[str],
) -> dict[str, dict[str, Any]]:
    """Load and validate pipeline manifests from plugin's pipelines/ directory."""
    pipelines_dir = plugin_dir / "pipelines"
    if not pipelines_dir.is_dir():
        return {}

    # Import lazily to avoid circular import; pipeline.py may not be imported yet
    from app.services.pipeline import _load_manifest, _load_schema  # type: ignore[attr-defined]
    schema = _load_schema()

    manifests: dict[str, dict[str, Any]] = {}
    for yaml_path in sorted(pipelines_dir.glob("*.yaml")):
        try:
            manifest = _load_manifest(yaml_path, schema)
        except Exception as exc:
            raise PluginError(f"Pipeline {yaml_path.name}: {exc}") from exc

        pid = manifest["id"]
        if pid in known_core_ids:
            raise PluginError(
                f"Pipeline id '{pid}' in {yaml_path.name} conflicts with a core NeuroForge pipeline. "
                f"Rename it to avoid the conflict (e.g. '{plugin_dir.name}-{pid}')."
            )
        if pid in known_plugin_ids:
            raise PluginError(
                f"Duplicate pipeline id '{pid}' — already registered by another plugin."
            )
        manifests[pid] = manifest
        known_plugin_ids.add(pid)

    return manifests


def _load_plugin_artifact_types(
    plugin_dir: Path,
    known_core_slugs: set[str],
    known_plugin_slugs: set[str],
) -> dict[str, Any]:
    """Load artifact_types.yaml from a plugin directory."""
    types_path = plugin_dir / "artifact_types.yaml"
    if not types_path.is_file():
        return {}

    with types_path.open() as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise PluginError(f"{plugin_dir.name}/artifact_types.yaml: expected a YAML mapping")

    types_dict = data.get("artifact_types", data)
    result: dict[str, Any] = {}
    for slug, defn in types_dict.items():
        if slug in known_core_slugs:
            raise PluginError(
                f"Artifact type slug '{slug}' in {plugin_dir.name}/artifact_types.yaml "
                f"conflicts with a core NeuroForge artifact type."
            )
        if slug in known_plugin_slugs:
            raise PluginError(
                f"Duplicate artifact type slug '{slug}' — already registered by another plugin."
            )
        result[slug] = defn
        known_plugin_slugs.add(slug)

    return result


def _patch_path(plugin_dir: Path) -> None:
    """Prepend plugin's backend/ directory to PATH so NativeExecutor can find tools."""
    backend_dir = plugin_dir / "backend"
    if not backend_dir.is_dir():
        return

    # Make all files in backend/ executable
    for f in backend_dir.iterdir():
        if f.is_file():
            current = f.stat().st_mode
            f.chmod(current | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    current_path = os.environ.get("PATH", "")
    str_dir = str(backend_dir.resolve())
    if str_dir not in current_path.split(":"):
        os.environ["PATH"] = str_dir + ":" + current_path
        log.debug("Plugin backend dir added to PATH: %s", str_dir)


def load_plugin(
    plugin_dir: Path,
    known_core_ids: set[str],
    known_core_slugs: set[str],
    known_plugin_ids: set[str],
    known_plugin_slugs: set[str],
) -> PluginInfo:
    """Load a single plugin directory. Raises PluginError on any validation failure."""
    meta = _load_plugin_yaml(plugin_dir)
    info = PluginInfo(
        plugin_dir=plugin_dir,
        id=meta["id"],
        name=meta["name"],
        version=meta["version"],
        author=meta["author"],
        description=meta["description"],
        homepage=meta.get("homepage"),
        neuroforge_version=meta.get("neuroforge_version"),
        license=meta.get("license"),
        dependencies=meta.get("dependencies", []),
        enabled=meta.get("enabled", True),
    )

    if not info.enabled:
        info.status = "disabled"
        log.info("Plugin '%s' is disabled — skipping pipeline/type registration", info.id)
        return info

    # Validate plugin id uniqueness
    if info.id in {p.id for p in _plugins}:
        raise PluginError(f"Duplicate plugin id '{info.id}' — already loaded from another directory")

    # Load pipeline manifests
    manifests = _load_plugin_manifests(plugin_dir, known_core_ids, known_plugin_ids)
    info.pipeline_ids = list(manifests.keys())

    # Load artifact types
    art_types = _load_plugin_artifact_types(plugin_dir, known_core_slugs, known_plugin_slugs)
    info.artifact_type_slugs = list(art_types.keys())

    # Patch PATH so plugin executables are findable
    _patch_path(plugin_dir)

    info.status = "ok"
    return info, manifests, art_types


# ── Top-level loader ──────────────────────────────────────────────────────────

def load_all_plugins() -> list[PluginInfo]:
    """Discover and load all plugins. Call once at startup before pipeline registry build.

    Safe to call multiple times — subsequent calls are no-ops unless _loaded is reset.
    """
    global _plugins, _plugin_manifests, _plugin_artifact_types, _loaded

    if _loaded:
        return _plugins

    # Collect the current core pipeline IDs to detect conflicts.
    # Lazy import to avoid circular dependency.
    from app.services.pipeline import load_all_manifests as _core_load  # noqa: F401
    from app.services.artifact_registry import _load_artifact_types as _core_arts  # noqa: F401

    # We need core IDs/slugs but can't call the full load yet (would recurse).
    # Instead, scan the core directory directly for IDs.
    from app.services.pipeline import _PIPELINES_DIR, _load_schema, _load_manifest as _lm
    schema = _load_schema()
    core_pipeline_ids: set[str] = set()
    for yaml_path in sorted(_PIPELINES_DIR.glob("*.yaml")):
        try:
            m = _lm(yaml_path, schema)
            core_pipeline_ids.add(m["id"])
        except Exception:
            pass

    # Core artifact type slugs
    from app.services.artifact_registry import _ARTIFACT_TYPES_PATH
    core_artifact_slugs: set[str] = set()
    try:
        with _ARTIFACT_TYPES_PATH.open() as f:
            art_data = yaml.safe_load(f)
        core_artifact_slugs = set(art_data.get("artifact_types", {}).keys())
    except Exception:
        pass

    known_plugin_ids: set[str] = set()
    known_plugin_slugs: set[str] = set()
    result_plugins: list[PluginInfo] = []
    result_manifests: dict[str, dict[str, Any]] = {}
    result_types: dict[str, Any] = {}

    for plugin_dir in _find_plugin_dirs():
        try:
            outcome = load_plugin(
                plugin_dir,
                known_core_ids=core_pipeline_ids,
                known_core_slugs=core_artifact_slugs,
                known_plugin_ids=known_plugin_ids,
                known_plugin_slugs=known_plugin_slugs,
            )
            if isinstance(outcome, tuple):
                info, manifests, art_types = outcome
            else:
                info = outcome
                manifests = {}
                art_types = {}

            result_plugins.append(info)
            result_manifests.update(manifests)
            result_types.update(art_types)

            if info.status == "ok":
                log.info(
                    "Plugin loaded: %s v%s (%d pipelines, %d artifact types)",
                    info.id, info.version, len(info.pipeline_ids), len(info.artifact_type_slugs),
                )
        except PluginError as exc:
            log.error("Plugin in %s failed to load: %s", plugin_dir, exc)
            # Add an errored entry so it shows in the Plugins page
            try:
                meta = yaml.safe_load((plugin_dir / "plugin.yaml").read_text())
                errored = PluginInfo(
                    plugin_dir=plugin_dir,
                    id=meta.get("id", plugin_dir.name),
                    name=meta.get("name", plugin_dir.name),
                    version=meta.get("version", "unknown"),
                    author=meta.get("author", ""),
                    description=meta.get("description", ""),
                    status="error",
                    error=str(exc),
                )
            except Exception:
                errored = PluginInfo(
                    plugin_dir=plugin_dir,
                    id=plugin_dir.name,
                    name=plugin_dir.name,
                    version="unknown",
                    author="",
                    description="",
                    status="error",
                    error=str(exc),
                )
            result_plugins.append(errored)
        except Exception as exc:
            log.error("Unexpected error loading plugin from %s: %s", plugin_dir, exc)
            try:
                meta = yaml.safe_load((plugin_dir / "plugin.yaml").read_text())
                errored = PluginInfo(
                    plugin_dir=plugin_dir,
                    id=meta.get("id", plugin_dir.name) if isinstance(meta, dict) else plugin_dir.name,
                    name=meta.get("name", plugin_dir.name) if isinstance(meta, dict) else plugin_dir.name,
                    version=meta.get("version", "unknown") if isinstance(meta, dict) else "unknown",
                    author=meta.get("author", "") if isinstance(meta, dict) else "",
                    description=meta.get("description", "") if isinstance(meta, dict) else "",
                    status="error",
                    error=str(exc),
                )
            except Exception:
                errored = PluginInfo(
                    plugin_dir=plugin_dir,
                    id=plugin_dir.name,
                    name=plugin_dir.name,
                    version="unknown",
                    author="",
                    description="",
                    status="error",
                    error=str(exc),
                )
            result_plugins.append(errored)

    _plugins = result_plugins
    _plugin_manifests = result_manifests
    _plugin_artifact_types = result_types
    _loaded = True

    return _plugins


def reset_for_testing() -> None:
    """Reset module state. For use in tests only."""
    global _plugins, _plugin_manifests, _plugin_artifact_types, _loaded
    _plugins = []
    _plugin_manifests = {}
    _plugin_artifact_types = {}
    _loaded = False
