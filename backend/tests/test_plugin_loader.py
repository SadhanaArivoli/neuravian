"""Tests for the Neuravian plugin loader (plugin_loader.py).

Covers:
  - Discovery: env var, /plugins-user, /plugins, repo-root/plugins
  - plugin.yaml schema validation (required fields, type constraints)
  - Duplicate plugin id detection
  - Pipeline manifest loading and conflict detection (core vs plugin, plugin vs plugin)
  - Artifact type loading and conflict detection
  - Disabled plugin: pipelines NOT registered, artifact types NOT registered
  - Error recovery: bad plugin is marked status='error'; others continue loading
  - PATH patching: plugin backend/ directory prepended and executables made +x
  - API endpoint GET /api/plugins
  - Example plugin (plugins/image-statistics) loads correctly
"""

from __future__ import annotations

import json
import os
import stat
import textwrap
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.services import plugin_loader
from app.services.plugin_loader import (
    PluginError,
    PluginInfo,
    load_all_plugins,
    load_plugin,
    reset_for_testing,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_plugin_state():
    """Reset plugin loader module state before and after every test."""
    reset_for_testing()
    yield
    reset_for_testing()


@pytest.fixture()
def minimal_plugin(tmp_path: Path) -> Path:
    """Write a valid minimal plugin to tmp_path/my-plugin/ and return the dir."""
    plugin_dir = tmp_path / "my-plugin"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent("""\
            id: my-plugin
            name: "My Plugin"
            version: "1.0.0"
            author: "Test Author"
            description: "A minimal test plugin with no pipelines."
        """)
    )
    return plugin_dir


@pytest.fixture()
def plugin_with_pipeline(tmp_path: Path, minimal_plugin: Path) -> Path:
    """Add a valid native pipeline manifest to the minimal plugin."""
    pipeline_dir = minimal_plugin / "pipelines"
    pipeline_dir.mkdir()
    (pipeline_dir / "my-tool.yaml").write_text(
        textwrap.dedent("""\
            id: my-plugin-tool
            display_name: "My Plugin Tool"
            description: "A test pipeline provided by a plugin."
            category: quality_control
            input_type: nifti
            execution:
              type: native
              command: my-plugin-tool
            dataset_positional: false
            inputs: [nifti]
            outputs: [json]
            parameters:
              - name: input-file
                type: file_path
                required: true
                positional_suffix: true
                help: "Path to input NIfTI."
              - name: output
                cli_flag: "-o"
                type: string
                required: false
                default: "{output_dir}/out.json"
                help: "Output path."
            accepts:
              - type: nifti_raw
                label: "Input NIfTI"
                param: input-file
            produces:
              - type: my_plugin_output
                label: "Statistics"
                path_hint: "out.json"
                description: "Output statistics"
        """)
    )
    return minimal_plugin


@pytest.fixture()
def plugin_with_artifact_types(tmp_path: Path, minimal_plugin: Path) -> Path:
    """Add an artifact_types.yaml to the minimal plugin."""
    (minimal_plugin / "artifact_types.yaml").write_text(
        textwrap.dedent("""\
            artifact_types:
              my_plugin_output:
                label: "My Plugin Output"
                description: "A test artifact type."
                extensions: [".json"]
        """)
    )
    return minimal_plugin


@pytest.fixture()
def api_client(tmp_path):
    """FastAPI test client with in-memory SQLite and plugin loader mocked."""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    app.dependency_overrides[get_db] = lambda: session

    with patch("app.services.run.seed_pipeline_registry"), \
         patch("app.services.plugin_loader.load_all_plugins"):
        with TestClient(app) as client:
            yield client

    app.dependency_overrides.clear()
    session.close()


# ── Helper to get known core IDs/slugs (minimal sets for tests) ───────────────

def _core_ids() -> set[str]:
    from app.services.pipeline import _PIPELINES_DIR, _load_schema, _load_manifest
    schema = _load_schema()
    ids = set()
    for p in _PIPELINES_DIR.glob("*.yaml"):
        try:
            m = _load_manifest(p, schema)
            ids.add(m["id"])
        except Exception:
            pass
    return ids


def _core_slugs() -> set[str]:
    from app.services.artifact_registry import _ARTIFACT_TYPES_PATH
    try:
        data = yaml.safe_load(_ARTIFACT_TYPES_PATH.read_text())
        return set(data.get("artifact_types", {}).keys())
    except Exception:
        return set()


# ── Discovery tests ───────────────────────────────────────────────────────────


def test_find_plugin_dirs_skips_schema_dir(tmp_path: Path):
    """The 'schema' subdirectory inside a plugins root must be ignored."""
    schema_dir = tmp_path / "schema"
    schema_dir.mkdir()
    (schema_dir / "plugin.yaml").write_text("id: x\nname: x\nversion: 1.0.0\nauthor: x\ndescription: x")

    with patch.dict(os.environ, {"NEURAVIAN_PLUGINS_DIRS": str(tmp_path)}):
        dirs = plugin_loader._find_plugin_dirs()
    assert schema_dir not in dirs


def test_find_plugin_dirs_skips_dirs_without_plugin_yaml(tmp_path: Path):
    """Directories without plugin.yaml are not returned from the env-var root."""
    (tmp_path / "not-a-plugin").mkdir()
    # Patch _candidate_plugin_roots to return only tmp_path so the local
    # plugins/ directory (which contains image-statistics) is not scanned.
    with patch.object(plugin_loader, "_candidate_plugin_roots", return_value=[tmp_path]):
        dirs = plugin_loader._find_plugin_dirs()
    assert not dirs


def test_find_plugin_dirs_env_var(tmp_path: Path, minimal_plugin: Path):
    """NEURAVIAN_PLUGINS_DIRS env var is discovered."""
    with patch.dict(os.environ, {"NEURAVIAN_PLUGINS_DIRS": str(tmp_path)}):
        dirs = plugin_loader._find_plugin_dirs()
    assert minimal_plugin in dirs


def test_find_plugin_dirs_deduplicates_symlinks(tmp_path: Path, minimal_plugin: Path):
    """Symlinks to the same real path are deduplicated."""
    link = tmp_path / "link"
    link.symlink_to(minimal_plugin)
    root2 = tmp_path / "root2"
    root2.mkdir()
    (root2 / "my-plugin").symlink_to(minimal_plugin)

    with patch.dict(os.environ, {"NEURAVIAN_PLUGINS_DIRS": f"{tmp_path}:{root2}"}):
        dirs = plugin_loader._find_plugin_dirs()

    # Should appear at most once
    assert dirs.count(minimal_plugin) + sum(1 for d in dirs if d.resolve() == minimal_plugin.resolve()) <= 2


# ── Schema validation tests ───────────────────────────────────────────────────


def test_load_plugin_missing_required_field(tmp_path: Path):
    """plugin.yaml missing a required field raises PluginError."""
    plugin_dir = tmp_path / "bad-plugin"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text("id: bad\nname: Bad\nversion: 1.0.0\nauthor: Author\n")
    # Missing 'description'
    with pytest.raises(PluginError, match="description"):
        load_plugin(plugin_dir, set(), set(), set(), set())


def test_load_plugin_invalid_version_format(tmp_path: Path):
    """plugin.yaml with malformed version string raises PluginError."""
    plugin_dir = tmp_path / "bad-ver"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        "id: bad-ver\nname: Bad\nversion: not-semver\nauthor: Author\ndescription: desc\n"
    )
    with pytest.raises(PluginError, match="not-semver"):
        load_plugin(plugin_dir, set(), set(), set(), set())


def test_load_plugin_invalid_id_format(tmp_path: Path):
    """plugin.yaml with uppercase id raises PluginError (id must match ^[a-z][a-z0-9_-]*$)."""
    plugin_dir = tmp_path / "BadPlugin"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        "id: BadPlugin\nname: Bad\nversion: 1.0.0\nauthor: Author\ndescription: desc\n"
    )
    with pytest.raises(PluginError, match="BadPlugin"):
        load_plugin(plugin_dir, set(), set(), set(), set())


def test_load_minimal_plugin_returns_plugin_info(minimal_plugin: Path):
    """A valid minimal plugin (no pipelines, no artifact types) loads without error."""
    result = load_plugin(minimal_plugin, set(), set(), set(), set())
    # load_plugin returns (info, manifests, art_types) when enabled
    assert isinstance(result, tuple)
    info, manifests, art_types = result
    assert isinstance(info, PluginInfo)
    assert info.id == "my-plugin"
    assert info.status == "ok"
    assert info.pipeline_ids == []
    assert info.artifact_type_slugs == []
    assert manifests == {}
    assert art_types == {}


# ── Disabled plugin tests ─────────────────────────────────────────────────────


def test_disabled_plugin_not_registered(tmp_path: Path):
    """A plugin with enabled: false is discovered but its pipelines are not merged."""
    plugin_dir = tmp_path / "disabled-plugin"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent("""\
            id: disabled-plugin
            name: "Disabled Plugin"
            version: "1.0.0"
            author: "Test"
            description: "This plugin is disabled."
            enabled: false
        """)
    )
    result = load_plugin(plugin_dir, set(), set(), set(), set())
    # Returns just the PluginInfo for disabled plugins
    assert isinstance(result, PluginInfo)
    info = result
    assert info.status == "disabled"
    assert info.pipeline_ids == []


def test_load_all_plugins_disabled_plugin_not_in_manifests(tmp_path: Path):
    """Disabled plugin's pipeline ID does not appear in _plugin_manifests."""
    plugin_dir = tmp_path / "disabled-with-pipeline"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent("""\
            id: disabled-with-pipeline
            name: "Disabled"
            version: "1.0.0"
            author: "A"
            description: "Disabled."
            enabled: false
        """)
    )
    pipeline_dir = plugin_dir / "pipelines"
    pipeline_dir.mkdir()
    (pipeline_dir / "tool.yaml").write_text(
        textwrap.dedent("""\
            id: disabled-pipeline
            display_name: "Disabled Pipeline"
            description: "Should not be loaded."
            category: quality_control
            input_type: nifti
            execution: {type: native, command: disabled-tool}
            dataset_positional: false
            inputs: []
            outputs: []
            parameters: []
        """)
    )
    with patch.dict(os.environ, {"NEURAVIAN_PLUGINS_DIRS": str(tmp_path)}):
        plugins = load_all_plugins()

    assert any(p.id == "disabled-with-pipeline" and p.status == "disabled" for p in plugins)
    assert "disabled-pipeline" not in plugin_loader._plugin_manifests


# ── Conflict detection tests ──────────────────────────────────────────────────


def test_plugin_pipeline_conflicts_with_core(tmp_path: Path, plugin_with_pipeline: Path):
    """A plugin pipeline that uses a core pipeline id raises PluginError."""
    core_ids = _core_ids()
    if not core_ids:
        pytest.skip("No core pipeline IDs found — cannot test core conflict")

    conflicting_id = next(iter(core_ids))
    pipeline_dir = plugin_with_pipeline / "pipelines"
    # Overwrite the pipeline yaml with a conflicting id
    for f in pipeline_dir.glob("*.yaml"):
        content = yaml.safe_load(f.read_text())
        content["id"] = conflicting_id
        f.write_text(yaml.dump(content))

    with pytest.raises(PluginError, match="conflicts with a core"):
        load_plugin(plugin_with_pipeline, core_ids, set(), set(), set())


def test_plugin_pipeline_conflicts_with_other_plugin(tmp_path: Path):
    """Two plugins with the same pipeline id: second raises PluginError."""
    # Create two plugins both providing pipeline id "shared-pipeline"
    def make_plugin(name: str) -> Path:
        plugin_dir = tmp_path / name
        plugin_dir.mkdir()
        (plugin_dir / "plugin.yaml").write_text(
            textwrap.dedent(f"""\
                id: {name}
                name: "{name}"
                version: "1.0.0"
                author: "Test"
                description: "Test."
            """)
        )
        pipeline_dir = plugin_dir / "pipelines"
        pipeline_dir.mkdir()
        (pipeline_dir / "tool.yaml").write_text(
            textwrap.dedent("""\
                id: shared-pipeline
                display_name: "Shared"
                description: "Conflict test."
                category: quality_control
                input_type: nifti
                execution: {type: native, command: shared-tool}
                dataset_positional: false
                inputs: []
                outputs: []
                parameters: []
            """)
        )
        return plugin_dir

    p1 = make_plugin("plugin-one")
    p2 = make_plugin("plugin-two")

    known_plugin_ids: set[str] = set()
    load_plugin(p1, set(), set(), known_plugin_ids, set())
    with pytest.raises(PluginError, match="already registered"):
        load_plugin(p2, set(), set(), known_plugin_ids, set())


def test_artifact_type_conflicts_with_core(tmp_path: Path, minimal_plugin: Path):
    """A plugin artifact type that matches a core slug raises PluginError."""
    core_slugs = _core_slugs()
    if not core_slugs:
        pytest.skip("No core artifact slugs found — cannot test core conflict")

    conflicting_slug = next(iter(core_slugs))
    (minimal_plugin / "artifact_types.yaml").write_text(
        textwrap.dedent(f"""\
            artifact_types:
              {conflicting_slug}:
                label: "Conflict"
                description: "This conflicts with a core type."
                extensions: [".nii"]
        """)
    )
    with pytest.raises(PluginError, match="conflicts with a core"):
        load_plugin(minimal_plugin, set(), core_slugs, set(), set())


# ── Error recovery tests ──────────────────────────────────────────────────────


def test_load_all_plugins_continues_after_bad_plugin(tmp_path: Path):
    """If one plugin has an error, the remaining plugins still load."""
    # Good plugin
    good_dir = tmp_path / "good-plugin"
    good_dir.mkdir()
    (good_dir / "plugin.yaml").write_text(
        textwrap.dedent("""\
            id: good-plugin
            name: "Good"
            version: "1.0.0"
            author: "A"
            description: "Fine."
        """)
    )

    # Bad plugin (invalid yaml)
    bad_dir = tmp_path / "bad-plugin"
    bad_dir.mkdir()
    (bad_dir / "plugin.yaml").write_text(": invalid: yaml: [\n")

    with patch.dict(os.environ, {"NEURAVIAN_PLUGINS_DIRS": str(tmp_path)}):
        plugins = load_all_plugins()

    statuses = {p.id: p.status for p in plugins}
    assert statuses.get("good-plugin") == "ok"
    # bad-plugin should be present with status error
    assert any(p.status == "error" for p in plugins)


def test_load_all_plugins_idempotent(tmp_path: Path, minimal_plugin: Path):
    """Calling load_all_plugins() twice returns the same result without re-scanning."""
    with patch.dict(os.environ, {"NEURAVIAN_PLUGINS_DIRS": str(tmp_path)}):
        first = load_all_plugins()
        second = load_all_plugins()

    assert first is second  # same list object — no re-run


# ── PATH patching tests ───────────────────────────────────────────────────────


def test_patch_path_adds_backend_dir(tmp_path: Path, minimal_plugin: Path):
    """Plugin with a backend/ directory has it prepended to PATH."""
    backend_dir = minimal_plugin / "backend"
    backend_dir.mkdir()
    script = backend_dir / "my-plugin-tool"
    script.write_text("#!/bin/sh\necho hello\n")

    original_path = os.environ.get("PATH", "")
    try:
        plugin_loader._patch_path(minimal_plugin)
        new_path = os.environ.get("PATH", "")
        assert str(backend_dir.resolve()) in new_path.split(":")
    finally:
        os.environ["PATH"] = original_path


def test_patch_path_makes_files_executable(tmp_path: Path, minimal_plugin: Path):
    """plugin_loader._patch_path() sets execute bits on backend/ files."""
    backend_dir = minimal_plugin / "backend"
    backend_dir.mkdir()
    script = backend_dir / "my-tool"
    script.write_text("#!/bin/sh\necho test\n")
    # Explicitly remove execute bit
    script.chmod(0o644)

    plugin_loader._patch_path(minimal_plugin)

    mode = script.stat().st_mode
    assert mode & stat.S_IXUSR, "Execute bit not set on plugin backend file"


def test_patch_path_no_backend_dir_is_noop(tmp_path: Path, minimal_plugin: Path):
    """_patch_path() with no backend/ directory does not crash and doesn't modify PATH."""
    original_path = os.environ.get("PATH", "")
    try:
        plugin_loader._patch_path(minimal_plugin)  # no backend/
        assert os.environ.get("PATH", "") == original_path
    finally:
        os.environ["PATH"] = original_path


# ── Plugin with pipeline tests ────────────────────────────────────────────────


def test_plugin_with_pipeline_registers_manifest(plugin_with_pipeline: Path):
    """A plugin with a valid pipeline manifest registers its pipeline id."""
    info, manifests, art_types = load_plugin(
        plugin_with_pipeline, set(), set(), set(), set()
    )
    assert info.status == "ok"
    assert "my-plugin-tool" in manifests
    assert info.pipeline_ids == ["my-plugin-tool"]


def test_plugin_with_artifact_types_registers_slugs(plugin_with_artifact_types: Path):
    """A plugin with artifact_types.yaml registers the slug."""
    info, manifests, art_types = load_plugin(
        plugin_with_artifact_types, set(), set(), set(), set()
    )
    assert info.status == "ok"
    assert "my_plugin_output" in art_types
    assert "my_plugin_output" in info.artifact_type_slugs


# ── iter_* functions ──────────────────────────────────────────────────────────


def test_iter_plugin_manifests_empty_before_load():
    """Before load_all_plugins(), iter_plugin_manifests() yields nothing."""
    assert list(plugin_loader.iter_plugin_manifests()) == []


def test_iter_plugin_artifact_types_empty_before_load():
    """Before load_all_plugins(), iter_plugin_artifact_types() yields nothing."""
    assert list(plugin_loader.iter_plugin_artifact_types()) == []


def test_iter_plugin_manifests_after_load(tmp_path: Path, plugin_with_pipeline: Path):
    """After loading, iter_plugin_manifests() yields the plugin pipeline."""
    with patch.object(plugin_loader, "_candidate_plugin_roots", return_value=[tmp_path]):
        load_all_plugins()
    manifests = dict(plugin_loader.iter_plugin_manifests())
    assert "my-plugin-tool" in manifests


# ── reset_for_testing ─────────────────────────────────────────────────────────


def test_reset_for_testing_clears_state(tmp_path: Path, minimal_plugin: Path):
    """reset_for_testing() clears all module state so load_all_plugins() re-runs."""
    with patch.dict(os.environ, {"NEURAVIAN_PLUGINS_DIRS": str(tmp_path)}):
        load_all_plugins()
    assert plugin_loader._loaded is True

    reset_for_testing()

    assert plugin_loader._loaded is False
    assert plugin_loader._plugins == []
    assert plugin_loader._plugin_manifests == {}
    assert plugin_loader._plugin_artifact_types == {}


# ── GET /api/plugins endpoint ─────────────────────────────────────────────────


def test_api_plugins_endpoint_returns_list(api_client: TestClient):
    """GET /api/plugins returns a JSON list."""
    response = api_client.get("/api/plugins")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_api_plugins_endpoint_contains_plugin_info(api_client: TestClient):
    """GET /api/plugins returns plugin entries with expected keys."""
    # Inject a fake plugin into module state
    fake = PluginInfo(
        plugin_dir=Path("/tmp/fake-plugin"),
        id="fake-plugin",
        name="Fake Plugin",
        version="1.0.0",
        author="Test",
        description="A fake plugin for testing.",
        status="ok",
        pipeline_ids=["fake-pipeline"],
        artifact_type_slugs=["fake_artifact"],
    )
    plugin_loader._plugins = [fake]

    response = api_client.get("/api/plugins")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    entry = data[0]
    assert entry["id"] == "fake-plugin"
    assert entry["name"] == "Fake Plugin"
    assert entry["status"] == "ok"
    assert entry["pipeline_ids"] == ["fake-pipeline"]
    assert entry["artifact_type_slugs"] == ["fake_artifact"]


def test_api_plugins_endpoint_empty_without_plugins(api_client: TestClient):
    """GET /api/plugins returns [] when no plugins are loaded."""
    plugin_loader._plugins = []
    response = api_client.get("/api/plugins")
    assert response.status_code == 200
    assert response.json() == []


# ── Example plugin (image-statistics) ────────────────────────────────────────


def test_example_plugin_directory_exists():
    """The example image-statistics plugin directory must exist in the repo."""
    plugin_dir = Path(__file__).parent.parent.parent / "plugins" / "image-statistics"
    assert plugin_dir.is_dir(), f"Example plugin directory not found: {plugin_dir}"


def test_example_plugin_yaml_is_valid():
    """The example plugin's plugin.yaml passes schema validation."""
    plugin_dir = Path(__file__).parent.parent.parent / "plugins" / "image-statistics"
    if not plugin_dir.is_dir():
        pytest.skip("Example plugin directory not found")

    result = load_plugin(plugin_dir, _core_ids(), _core_slugs(), set(), set())
    # Disabled plugins return PluginInfo directly
    if isinstance(result, PluginInfo):
        assert result.status in ("ok", "disabled")
    else:
        info, _, _ = result
        assert info.status == "ok"
        assert info.id == "image-statistics"


def test_example_plugin_pipeline_manifest_is_valid():
    """The example plugin pipeline manifest passes JSON Schema validation."""
    plugin_dir = Path(__file__).parent.parent.parent / "plugins" / "image-statistics"
    pipeline_yaml = plugin_dir / "pipelines" / "image-statistics.yaml"
    if not pipeline_yaml.is_file():
        pytest.skip("Example plugin pipeline manifest not found")

    from app.services.pipeline import _load_manifest, _load_schema
    schema = _load_schema()
    manifest = _load_manifest(pipeline_yaml, schema)
    assert manifest["id"] == "image-statistics"
    assert manifest["execution"]["type"] == "native"


def test_example_plugin_artifact_types_yaml_is_valid():
    """The example plugin artifact_types.yaml is parseable YAML."""
    plugin_dir = Path(__file__).parent.parent.parent / "plugins" / "image-statistics"
    types_yaml = plugin_dir / "artifact_types.yaml"
    if not types_yaml.is_file():
        pytest.skip("Example plugin artifact_types.yaml not found")

    data = yaml.safe_load(types_yaml.read_text())
    assert "artifact_types" in data
    assert "image_statistics_json" in data["artifact_types"]


def test_example_plugin_backend_executable_exists_and_is_executable():
    """The example plugin's backend executable exists and has its execute bit set."""
    exe = (
        Path(__file__).parent.parent.parent
        / "plugins" / "image-statistics" / "backend" / "neuravian-image-statistics"
    )
    if not exe.is_file():
        pytest.skip("Example plugin executable not found")

    mode = exe.stat().st_mode
    assert mode & stat.S_IXUSR, "Execute bit not set on example plugin executable"


def test_example_plugin_loads_via_load_all_plugins(tmp_path: Path):
    """load_all_plugins() discovers and loads the example plugin correctly."""
    # Point NEURAVIAN_PLUGINS_DIRS at the real plugins/ directory (contains image-statistics)
    plugins_root = Path(__file__).parent.parent.parent / "plugins"
    if not plugins_root.is_dir():
        pytest.skip("plugins/ directory not found")

    with patch.dict(os.environ, {"NEURAVIAN_PLUGINS_DIRS": str(plugins_root)}):
        plugins = load_all_plugins()

    ids = [p.id for p in plugins]
    assert "image-statistics" in ids

    img_stats = next(p for p in plugins if p.id == "image-statistics")
    assert img_stats.status == "ok"
    assert "image-statistics" in img_stats.pipeline_ids
    assert "image_statistics_json" in img_stats.artifact_type_slugs


def test_example_plugin_merges_into_pipeline_registry(tmp_path: Path):
    """After loading the example plugin, its pipeline appears in get_registry()."""
    plugins_root = Path(__file__).parent.parent.parent / "plugins"
    if not plugins_root.is_dir():
        pytest.skip("plugins/ directory not found")

    # Reset the pipeline registry cache too
    import app.services.pipeline as pipeline_mod
    original_registry = pipeline_mod._registry
    pipeline_mod._registry = None

    try:
        with patch.dict(os.environ, {"NEURAVIAN_PLUGINS_DIRS": str(plugins_root)}):
            load_all_plugins()
            registry = pipeline_mod.load_all_manifests()
        assert "image-statistics" in registry
    finally:
        pipeline_mod._registry = original_registry
        reset_for_testing()


def test_example_plugin_merges_artifact_types():
    """After loading the example plugin, image_statistics_json appears in the type registry."""
    plugins_root = Path(__file__).parent.parent.parent / "plugins"
    if not plugins_root.is_dir():
        pytest.skip("plugins/ directory not found")

    import app.services.artifact_registry as art_mod
    original_cache = art_mod._artifact_types_cache
    art_mod._artifact_types_cache = None

    try:
        with patch.dict(os.environ, {"NEURAVIAN_PLUGINS_DIRS": str(plugins_root)}):
            load_all_plugins()
            types = art_mod._load_artifact_types()
        assert "image_statistics_json" in types
    finally:
        art_mod._artifact_types_cache = original_cache
        reset_for_testing()
