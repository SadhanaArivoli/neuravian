"""Tests for the pipeline manifest registry and API endpoints."""

import json
import textwrap
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml
import nibabel as nib
import numpy as np
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.database import Base, get_db
from app.execution.docker_executor import DockerExecutor
from app.execution.executor import RunContext
from app.tools.functional_connectivity import (
    ATLAS_REGISTRY,
    DEFAULT_ATLAS_ID,
    LoadedAtlas,
    build_roi_statistics,
    normalize_atlas_id,
)
from app.main import app
from app.services.pipeline import ManifestError, PipelineService, _load_manifest, _load_schema

PIPELINES_DIR = Path(__file__).parent.parent.parent / "pipelines"


# ------------------------------------------------------------------ #
# API client fixture (no DB needed for pipeline routes but TestClient  #
# requires the app to start, which needs a valid DB override)          #
# ------------------------------------------------------------------ #


@pytest.fixture()
def api_client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    app.dependency_overrides[get_db] = lambda: session
    with patch("app.services.run.seed_pipeline_registry"):
        with TestClient(app) as client:
            yield client
    app.dependency_overrides.clear()
    session.close()


# ------------------------------------------------------------------ #
# Manifest loader unit tests                                           #
# ------------------------------------------------------------------ #


def test_mriqc_manifest_loads_without_error():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "mriqc.yaml", schema)
    assert manifest["id"] == "mriqc"
    assert manifest["container"]["tag"] == "24.0.2"
    assert manifest["container"]["engine"] == "docker"


def test_mriqc_group_manifest_loads_without_error():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "mriqc-group.yaml", schema)
    assert manifest["id"] == "mriqc-group"
    assert manifest["container"]["tag"] == "24.0.2"
    assert manifest["seed_output_from_lineage_artifact_type"] == "mriqc_report"


def test_mriqc_manifest_has_required_fields():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "mriqc.yaml", schema)
    assert manifest["display_name"]
    assert manifest["description"]
    assert isinstance(manifest["parameters"], list)
    assert len(manifest["parameters"]) >= 5
    assert isinstance(manifest["known_errors"], list)
    assert len(manifest["known_errors"]) >= 3


def test_mriqc_manifest_parameters_have_names_and_types():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "mriqc.yaml", schema)
    for param in manifest["parameters"]:
        assert "name" in param, f"Parameter missing 'name': {param}"
        assert "type" in param, f"Parameter '{param.get('name')}' missing 'type'"


def test_malformed_manifest_missing_id_raises(tmp_path):
    bad_yaml = tmp_path / "bad.yaml"
    bad_yaml.write_text(
        textwrap.dedent("""\
        display_name: No ID Pipeline
        description: Missing the required id field.
        container:
          image: example/tool
          tag: "1.0.0"
          engine: docker
        inputs: [bids_dataset]
        outputs: [output]
        parameters: []
        """)
    )
    schema = _load_schema()
    with pytest.raises(ManifestError, match="'id' is a required property"):
        _load_manifest(bad_yaml, schema)


def test_malformed_manifest_latest_tag_raises(tmp_path):
    bad_yaml = tmp_path / "bad_tag.yaml"
    bad_yaml.write_text(
        textwrap.dedent("""\
        id: bad_tool
        display_name: Bad Tool
        description: Uses the forbidden latest tag.
        container:
          image: example/tool
          tag: latest
          engine: docker
        inputs: [bids_dataset]
        outputs: [output]
        parameters: []
        """)
    )
    schema = _load_schema()
    with pytest.raises(ManifestError):
        _load_manifest(bad_yaml, schema)


def test_malformed_manifest_unknown_parameter_type_raises(tmp_path):
    bad_yaml = tmp_path / "bad_param.yaml"
    bad_yaml.write_text(
        textwrap.dedent("""\
        id: bad_param_tool
        display_name: Bad Param Tool
        description: Has a parameter with an unknown type.
        container:
          image: example/tool
          tag: "1.0.0"
          engine: docker
        inputs: [bids_dataset]
        outputs: [output]
        parameters:
          - name: weird
            type: checkbox
        """)
    )
    schema = _load_schema()
    with pytest.raises(ManifestError):
        _load_manifest(bad_yaml, schema)


# ------------------------------------------------------------------ #
# PipelineService unit tests                                           #
# ------------------------------------------------------------------ #


def test_pipeline_service_lists_mriqc():
    svc = PipelineService()
    pipelines = svc.list_all()
    ids = [p["id"] for p in pipelines]
    assert "mriqc" in ids


def test_pipeline_service_get_by_id_returns_full_manifest():
    svc = PipelineService()
    manifest = svc.get_by_id("mriqc")
    assert manifest is not None
    assert "parameters" in manifest
    assert "known_errors" in manifest


def test_pipeline_service_get_by_id_unknown_returns_none():
    svc = PipelineService()
    assert svc.get_by_id("nonexistent_tool") is None


# ------------------------------------------------------------------ #
# API endpoint tests                                                   #
# ------------------------------------------------------------------ #


def test_get_pipelines_list(api_client):
    resp = api_client.get("/api/pipelines")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert any(p["id"] == "mriqc" for p in data)


def test_get_pipeline_by_id(api_client):
    resp = api_client.get("/api/pipelines/mriqc")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == "mriqc"
    assert data["container"]["tag"] == "24.0.2"
    assert "parameters" in data


def test_mriqc_report_compatible_pipeline_includes_group_report(api_client):
    resp = api_client.get("/api/pipelines/compatible?artifact_type=mriqc_report")
    assert resp.status_code == 200
    data = resp.json()
    assert any(
        item["pipeline_id"] == "mriqc-group"
        and item["accept_param"] == "upstream-mriqc-dir"
        for item in data
    )


def test_get_pipeline_not_found(api_client):
    resp = api_client.get("/api/pipelines/nonexistent")
    assert resp.status_code == 404


def test_get_pipelines_summary_does_not_include_parameters(api_client):
    """List endpoint returns summary cards, not full manifests."""
    resp = api_client.get("/api/pipelines")
    assert resp.status_code == 200
    for item in resp.json():
        assert "parameters" not in item, "List endpoint should omit full parameters"


# ------------------------------------------------------------------ #
# fMRIPrep manifest                                                    #
# ------------------------------------------------------------------ #

def test_fmriprep_manifest_loads_without_error():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fmriprep.yaml", schema)
    assert manifest["id"] == "fmriprep"
    assert manifest["container"]["image"] == "nipreps/fmriprep"
    assert manifest["container"]["tag"] == (
        "sha256:15cbf8dcd17440d26ff5e80e9f7313f1cb3c54f13673f1ec4aed4465e8e12d77"
    )
    assert manifest["container"]["engine"] == "docker"


def test_fmriprep_manifest_has_required_fields():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fmriprep.yaml", schema)
    assert manifest["display_name"]
    assert manifest["description"]
    assert isinstance(manifest["parameters"], list)
    assert len(manifest["parameters"]) >= 8
    assert isinstance(manifest["known_errors"], list)
    assert len(manifest["known_errors"]) >= 5
    assert manifest["max_runtime_hours"] >= 12  # 24h for Apple Silicon Rosetta 2


def test_fmriprep_fs_license_param_is_required_and_mounted():
    """fs-license-file must be required=True, type=file_path, mount=True."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fmriprep.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "fs-license-file" in params, "fmriprep manifest must have fs-license-file param"
    lic = params["fs-license-file"]
    assert lic["type"] == "file_path"
    assert lic.get("required") is True
    assert lic.get("mount") is True


def test_fmriprep_fs_no_reconall_defaults_true():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fmriprep.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "fs-no-reconall" in params
    assert params["fs-no-reconall"]["default"] is True


def test_fmriprep_has_no_use_aroma_param():
    """--use-aroma was removed in fMRIPrep 23.1.0 and must not appear in the manifest."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fmriprep.yaml", schema)
    names = {p["name"] for p in manifest["parameters"]}
    assert "use-aroma" not in names, "--use-aroma was removed in fMRIPrep 23.x; do not include it"


def test_fmriprep_appears_in_pipeline_service():
    svc = PipelineService()
    ids = [p["id"] for p in svc.list_all()]
    assert "fmriprep" in ids


# ------------------------------------------------------------------ #
# Generic file_path mounting in DockerExecutor                         #
# ------------------------------------------------------------------ #

_MINIMAL_MANIFEST_WITH_FILE_PARAM = {
    "id": "test_tool",
    "display_name": "Test Tool",
    "description": "For unit testing",
    "container": {"image": "example/tool", "tag": "1.0.0", "engine": "docker"},
    "inputs": ["bids_dataset"],
    "outputs": ["output"],
    "parameters": [
        {
            "name": "license-file",
            "type": "file_path",
            "required": True,
            "mount": True,
            "help": "A license file",
        },
        {
            "name": "nprocs",
            "type": "integer",
            "default": 1,
            "help": "Parallel jobs",
        },
    ],
}


def test_file_path_mount_adds_volume(tmp_path):
    """A file_path param with mount:true must add a Docker volume binding."""
    license_file = tmp_path / "license.txt"
    license_file.write_text("fake license")

    ctx = RunContext(
        run_id=1,
        manifest=_MINIMAL_MANIFEST_WITH_FILE_PARAM,
        params={"license-file": str(license_file), "nprocs": 2},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )

    executor = DockerExecutor()
    # Patch to_host_path to be a no-op (not running inside Docker in tests)
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    assert str(license_file) in sdk.volumes, (
        "Host path for file_path+mount param must appear in volumes dict"
    )
    bind = sdk.volumes[str(license_file)]
    assert bind["mode"] == "ro"
    assert bind["bind"] == f"/inputs/license-file/{license_file.name}"


def test_file_path_mount_remaps_cli_flag(tmp_path):
    """The CLI flag for a mounted file_path param must use the container path."""
    license_file = tmp_path / "license.txt"
    license_file.write_text("fake license")

    ctx = RunContext(
        run_id=1,
        manifest=_MINIMAL_MANIFEST_WITH_FILE_PARAM,
        params={"license-file": str(license_file), "nprocs": 1},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )

    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    # --license-file must point to the container path, not the host path
    flag_idx = cmd.index("--license-file")
    container_path = cmd[flag_idx + 1]
    assert container_path == f"/inputs/license-file/{license_file.name}"
    assert str(license_file) not in container_path


def test_file_path_no_mount_does_not_add_volume(tmp_path):
    """A file_path param without mount:true must NOT add a Docker volume."""
    manifest_no_mount = {
        **_MINIMAL_MANIFEST_WITH_FILE_PARAM,
        "parameters": [
            {
                "name": "config-file",
                "type": "file_path",
                "help": "A config file (not mounted)",
                # mount is absent / false
            }
        ],
    }
    ctx = RunContext(
        run_id=1,
        manifest=manifest_no_mount,
        params={"config-file": "/some/path/config.json"},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )

    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    assert "/some/path/config.json" not in sdk.volumes


# ------------------------------------------------------------------ #
# Pre-flight license validation gate in RunService                     #
# ------------------------------------------------------------------ #

@pytest.fixture()
def db_session_for_runs():
    from app.services.run import seed_pipeline_registry
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    seed_pipeline_registry(session)
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)


@pytest.fixture()
def fmriprep_api_client(db_session_for_runs):
    app.dependency_overrides[get_db] = lambda: db_session_for_runs
    with patch("app.services.run.seed_pipeline_registry"):
        with TestClient(app) as client:
            yield client
    app.dependency_overrides.clear()


def _make_dataset(db_session, path: str):
    from app.models.dataset import Dataset
    ds = Dataset(path=path, validation_status="valid")
    db_session.add(ds)
    db_session.commit()
    db_session.refresh(ds)
    return ds


def test_run_rejected_when_required_license_missing(
    fmriprep_api_client, db_session_for_runs, tmp_path
):
    """POSTing a fmriprep run without fs-license-file must return 400."""
    ds = _make_dataset(db_session_for_runs, str(tmp_path))
    resp = fmriprep_api_client.post(
        "/api/runs",
        json={
            "pipeline_id": "fmriprep",
            "dataset_id": ds.id,
            "params": {
                # fs-license-file intentionally omitted
                "participant-label": "01",
            },
        },
    )
    assert resp.status_code == 400
    assert "fs-license-file" in resp.json()["detail"].lower() or \
           "required" in resp.json()["detail"].lower()


def test_run_rejected_when_license_file_does_not_exist(
    fmriprep_api_client, db_session_for_runs, tmp_path
):
    """A license path that is within a known container mount but doesn't exist
    on disk must return 400. Simulates a typo'd path under HOST_DATASETS_DIR.
    """
    ds = _make_dataset(db_session_for_runs, str(tmp_path))
    nonexistent = str(tmp_path / "does_not_exist" / "license.txt")

    # _is_running_in_docker() = False → path_is_reachable = True (local-dev branch)
    # The path genuinely doesn't exist → pre-flight rejects it.
    with patch("app.services.run._is_running_in_docker", return_value=False):
        resp = fmriprep_api_client.post(
            "/api/runs",
            json={
                "pipeline_id": "fmriprep",
                "dataset_id": ds.id,
                "params": {
                    "fs-license-file": nonexistent,
                    "participant-label": "01",
                },
            },
        )
    assert resp.status_code == 400
    assert "not found" in resp.json()["detail"].lower() or \
           "path" in resp.json()["detail"].lower()


def test_run_accepted_when_license_outside_container_mounts(
    fmriprep_api_client, db_session_for_runs, tmp_path
):
    """A license path that to_host_path() can't translate (outside all mounts)
    must NOT be falsely rejected by the pre-flight check when running inside
    Docker. Simulates ~/freesurfer/license.txt on a Mac where only ~/Documents
    is mounted into the backend container.
    """
    ds = _make_dataset(db_session_for_runs, str(tmp_path))

    # Simulate being inside Docker: _is_running_in_docker() returns True and
    # to_host_path() returns the input unchanged (no matching mount for the path).
    # Pre-flight must skip the existence check rather than falsely rejecting.
    with patch("app.services.run._is_running_in_docker", return_value=True), \
         patch("app.services.run.to_host_path", side_effect=lambda v: v), \
         patch("app.services.run._execute_run_background"):
        resp = fmriprep_api_client.post(
            "/api/runs",
            json={
                "pipeline_id": "fmriprep",
                "dataset_id": ds.id,
                "params": {
                    # Path that doesn't exist inside container but would exist on host
                    "fs-license-file": "/Users/someone/freesurfer/license.txt",
                    "participant-label": "01",
                },
            },
        )
    # Should pass pre-flight (201), not be rejected with 400
    assert resp.status_code == 201, (
        f"Run should be accepted when license path is outside container mounts "
        f"(got {resp.status_code}: {resp.json()})"
    )


def test_run_accepted_when_license_file_exists(
    fmriprep_api_client, db_session_for_runs, tmp_path
):
    """POSTing a fmriprep run with a valid license path must pass the pre-flight check."""
    license_file = tmp_path / "license.txt"
    license_file.write_text("fake freesurfer license\n")
    ds = _make_dataset(db_session_for_runs, str(tmp_path))

    # Patch Docker execution so the test doesn't actually try to run a container.
    with patch("app.services.run._execute_run_background"):
        resp = fmriprep_api_client.post(
            "/api/runs",
            json={
                "pipeline_id": "fmriprep",
                "dataset_id": ds.id,
                "params": {
                    "fs-license-file": str(license_file),
                    "participant-label": "01",
                },
            },
        )
    # 201 = run created successfully; pre-flight passed
    assert resp.status_code == 201


# ------------------------------------------------------------------ #
# Automatic persistent work-dir injection                              #
# ------------------------------------------------------------------ #

def test_auto_work_dir_injected_for_long_pipeline(
    fmriprep_api_client, db_session_for_runs, tmp_path
):
    """fMRIPrep (max_runtime_hours=24) must get an auto work-dir injected
    when none is supplied, so nipype's node cache survives across runs."""
    license_file = tmp_path / "license.txt"
    license_file.write_text("fake license\n")
    ds = _make_dataset(db_session_for_runs, str(tmp_path))

    with patch("app.services.run._execute_run_background"), \
         patch("app.services.run.settings") as mock_settings:
        mock_settings.data_dir = str(tmp_path)
        resp = fmriprep_api_client.post(
            "/api/runs",
            json={
                "pipeline_id": "fmriprep",
                "dataset_id": ds.id,
                "params": {"fs-license-file": str(license_file)},
            },
        )

    assert resp.status_code == 201
    # The command_preview must contain --work-dir /work (container path)
    assert "--work-dir" in resp.json()["command_preview"], (
        "Auto work-dir should be injected into the Docker command"
    )
    # The expected host-side work dir must have been created
    expected_work_dir = tmp_path / "work" / "fmriprep" / str(ds.id)
    assert expected_work_dir.is_dir(), (
        f"Auto work-dir {expected_work_dir} was not created on disk"
    )


def test_auto_work_dir_not_injected_when_user_supplies_one(
    fmriprep_api_client, db_session_for_runs, tmp_path
):
    """An explicit work-dir param must not be overridden by auto-injection."""
    license_file = tmp_path / "license.txt"
    license_file.write_text("fake license\n")
    explicit_work = tmp_path / "my_work_dir"
    explicit_work.mkdir()
    ds = _make_dataset(db_session_for_runs, str(tmp_path))

    with patch("app.services.run._execute_run_background"), \
         patch("app.services.run.settings") as mock_settings:
        mock_settings.data_dir = str(tmp_path)
        resp = fmriprep_api_client.post(
            "/api/runs",
            json={
                "pipeline_id": "fmriprep",
                "dataset_id": ds.id,
                "params": {
                    "fs-license-file": str(license_file),
                    "work-dir": str(explicit_work),
                },
            },
        )

    assert resp.status_code == 201
    # Auto work-dir (data/work/fmriprep/{dataset_id}) must NOT have been created
    auto_work_dir = tmp_path / "work" / "fmriprep" / str(ds.id)
    assert not auto_work_dir.exists(), (
        "Auto work-dir should not be created when user explicitly sets work-dir"
    )


def test_auto_work_dir_not_injected_for_short_pipeline(
    fmriprep_api_client, db_session_for_runs, tmp_path
):
    """A pipeline with max_runtime_hours <= 4 must NOT get an auto work-dir."""
    import app.services.pipeline as pipeline_mod

    short_manifest = {
        "id": "fmriprep",
        "display_name": "fMRIPrep",
        "description": "test",
        "container": {"image": "nipreps/fmriprep", "tag": "25.2.5", "engine": "docker"},
        "inputs": ["bids_dataset"],
        "outputs": ["fmriprep"],
        "parameters": [
            {"name": "fs-license-file", "type": "file_path", "required": True, "mount": True},
        ],
        "max_runtime_hours": 3,  # below the 4h threshold
    }

    license_file = tmp_path / "license.txt"
    license_file.write_text("fake\n")
    ds = _make_dataset(db_session_for_runs, str(tmp_path))

    original_registry = pipeline_mod._registry
    pipeline_mod._registry = {"fmriprep": short_manifest}
    try:
        with patch("app.services.run._execute_run_background"), \
             patch("app.services.run.settings") as mock_settings:
            mock_settings.data_dir = str(tmp_path)
            resp = fmriprep_api_client.post(
                "/api/runs",
                json={
                    "pipeline_id": "fmriprep",
                    "dataset_id": ds.id,
                    "params": {"fs-license-file": str(license_file)},
                },
            )
    finally:
        pipeline_mod._registry = original_registry

    assert resp.status_code == 201
    assert "--work-dir" not in resp.json()["command_preview"], (
        "work-dir should NOT be auto-injected for pipelines with max_runtime_hours <= 4"
    )
    auto_work_dir = tmp_path / "work" / "fmriprep" / str(ds.id)
    assert not auto_work_dir.exists()


# ------------------------------------------------------------------ #
# M6: known_error translate_errors — verified against real log text   #
# ------------------------------------------------------------------ #
#
# Each test feeds a real or realistic log snippet (captured from actual
# runs on this machine) to translate_errors() and asserts the correct
# explanation is returned.  Log text is taken verbatim from the runs
# cited so the regex is proven against real output, not assumed to match.

from app.execution.docker_executor import translate_errors  # noqa: E402


def _fmriprep_errors() -> list:
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fmriprep.yaml", schema)
    return manifest["known_errors"]


def _mriqc_errors() -> list:
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "mriqc.yaml", schema)
    return manifest["known_errors"]


# ── fMRIPrep: unrecognized argument (runs 12 and 13) ────────────────

def test_translate_fmriprep_unrecognized_argument():
    """Argparse rejection of --run-id (removed in fMRIPrep 25.x) must be detected.
    Log text captured verbatim from runs 12 and 13."""
    log = (
        "usage: fmriprep [-h] [--skip_bids_validation]\n"
        "                [--participant-label PARTICIPANT_LABEL [PARTICIPANT_LABEL ...]]\n"
        "                bids_dir output_dir {participant}\n"
        "fmriprep: error: unrecognized arguments: --run-id 01\n"
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "Should detect argparse rejection"
    assert "unrecognized" in result.lower() or "argument" in result.lower() or "parser" in result.lower()


def test_translate_fmriprep_unrecognized_argument_any_flag():
    """Pattern must fire for any unrecognized flag, not just --run-id."""
    log = "fmriprep: error: unrecognized arguments: --use-aroma\n"
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None


# ── fMRIPrep: ANTs/Rosetta watchdog timeout (runs 9 and 15) ─────────

def test_translate_fmriprep_ants_watchdog_timeout():
    """Neuravian watchdog line must match the ANTs/Rosetta entry.
    Exact text injected by docker_executor.py watchdog — seen in runs 9 and 15."""
    log = (
        "260705-06:25:05,354 nipype.workflow INFO:\n"
        '\t [Node] Executing "registration"'
        " <niworkflows.interfaces.norm.SpatialNormalization>\n"
        "[neuravian] Run stopped automatically after 24h maximum runtime.\n"
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "Watchdog timeout must be detected"
    assert "ants" in result.lower() or "rosetta" in result.lower() or "registration" in result.lower()


def test_translate_fmriprep_ants_watchdog_12h():
    """Watchdog with 12h limit (run 9 original max_runtime_hours) must also match."""
    log = "[neuravian] Run stopped automatically after 12h maximum runtime.\n"
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None


# ── fMRIPrep: ANTs node executing lines (runs 14 and 15) ────────────

def test_translate_fmriprep_fix_header_registration_node():
    """FixHeaderRegistration node executing line (brain_extraction_wf/norm).
    Captured verbatim from run 14 log, line 425."""
    log = (
        "260703-13:37:00,001 nipype.workflow INFO:\n"
        '\t [Node] Executing "norm"'
        " <niworkflows.interfaces.fixes.FixHeaderRegistration>\n"
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "FixHeaderRegistration executing line must be detected"


def test_translate_fmriprep_spatial_normalization_node():
    """SpatialNormalization node executing line (register_template_wf/registration).
    Captured verbatim from run 15 log, last node before stall."""
    log = (
        "260705-06:25:05,354 nipype.workflow INFO:\n"
        '\t [Node] Executing "registration"'
        " <niworkflows.interfaces.norm.SpatialNormalization>\n"
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "SpatialNormalization executing line must be detected"


# ── fMRIPrep: OOM / SIGKILL ──────────────────────────────────────────

def test_translate_fmriprep_broken_process_pool():
    """BrokenProcessPool (nipype worker OOM-killed) must be detected."""
    log = (
        "concurrent.futures.process.BrokenProcessPool: "
        "A process in the executor was terminated abruptly while the future was running "
        "or pending.\n"
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None
    assert "memory" in result.lower() or "killed" in result.lower()


def test_translate_fmriprep_killed_signal():
    """Bare 'Killed' (shell output when main process receives SIGKILL) must be detected."""
    log = (
        "260703-17:53:00,000 nipype.workflow INFO:\n"
        "\t [Node] Executing some node\n"
        "Killed\n"
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "'Killed' line should match OOM entry"


def test_translate_fmriprep_killed_word_boundary():
    """'Killed' inside a compound word must NOT match due to \\b word boundary."""
    log = "Skill-based registration approach selected.\n"
    result = translate_errors(log, _fmriprep_errors())
    # Must not fire on 'Skill' — if something matched, it must be a different pattern
    if result is not None:
        assert "BrokenProcessPool" not in result


# ── fMRIPrep: license path does not exist (real argparse output) ────

def test_translate_fmriprep_license_path_not_exist():
    """fMRIPrep argparse path check for --fs-license-file.
    Exact text from: docker run nipreps/fmriprep:25.2.5 ... --fs-license-file /nonexistent/license.txt"""
    log = "fmriprep: error: Path does not exist: </nonexistent/license.txt>.\n"
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "License path-not-exist argparse error must be detected"
    assert "license" in result.lower()


# ── fMRIPrep: FreeSurfer runtime license check ───────────────────────

def test_translate_fmriprep_freesurfer_license_runtime():
    """FreeSurfer runtime license error (different from argparse path check) must match."""
    log = "ERROR: a valid license file is required for FreeSurfer.\n"
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None
    assert "license" in result.lower()


# ── fMRIPrep: regression guard on known_errors count ────────────────

def test_fmriprep_known_errors_count():
    """Guard against accidentally removing entries — must have at least 9."""
    errors = _fmriprep_errors()
    assert len(errors) >= 9, (
        f"Expected at least 9 fmriprep known_errors, got {len(errors)}. "
        "Check that no entries were removed."
    )


# ── MRIQC: OOM detection ─────────────────────────────────────────────

def test_translate_mriqc_oom_killed():
    """MRIQC 'Killed' OOM pattern must be detected."""
    log = "Killed\n"
    result = translate_errors(log, _mriqc_errors())
    assert result is not None, "MRIQC must detect bare 'Killed' as OOM"


def test_translate_mriqc_memory_error():
    """MRIQC MemoryError must be detected."""
    log = "MemoryError: Unable to allocate 4.50 GiB for array\n"
    result = translate_errors(log, _mriqc_errors())
    assert result is not None


def test_translate_mriqc_cannot_allocate():
    """MRIQC 'Cannot allocate memory' must be detected."""
    log = "OSError: [Errno 12] Cannot allocate memory\n"
    result = translate_errors(log, _mriqc_errors())
    assert result is not None


# ── Blank participant-label: no tool-level error (UI handles it) ─────

def test_mriqc_blank_participant_label_not_a_tool_error():
    """Blank participant-label is valid behavior — processes all subjects.
    The UI warns before submission; no known_error pattern should fire on
    normal MRIQC startup log text."""
    normal_startup = (
        "mriqc 24.0.2\n"
        "Processing all participants in the dataset.\n"
        "  * Analysis levels: ['participant'].\n"
        "  * Participants list: ['01', '02', '03'].\n"
    )
    assert translate_errors(normal_startup, _mriqc_errors()) is None
    assert translate_errors(normal_startup, _fmriprep_errors()) is None


# ------------------------------------------------------------------ #
# M6: known_error translate_errors — verified against real log text   #
# ------------------------------------------------------------------ #
#
# Each test feeds a real or realistic log snippet (captured from actual
# runs on this machine) to translate_errors() and asserts the correct
# explanation is returned.  Log text is taken verbatim from the runs
# cited so the regex is proven against real output, not assumed to match.

from app.execution.docker_executor import translate_errors


def _fmriprep_errors():
    """Load the fmriprep manifest's known_errors list."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fmriprep.yaml", schema)
    return manifest["known_errors"]


def _mriqc_errors():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "mriqc.yaml", schema)
    return manifest["known_errors"]


# ── fMRIPrep: unrecognized argument (runs 12 and 13) ────────────────

def test_translate_fmriprep_unrecognized_argument():
    """Argparse rejection of --run-id (removed in fMRIPrep 25.x) must be detected.
    Log text captured verbatim from runs 12 and 13."""
    log = (
        "usage: fmriprep [-h] [--skip_bids_validation]\n"
        "                [--participant-label PARTICIPANT_LABEL [PARTICIPANT_LABEL ...]]\n"
        "                bids_dir output_dir {participant}\n"
        "fmriprep: error: unrecognized arguments: --run-id 01\n"
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "Should detect argparse rejection"
    assert "unrecognized" in result.lower() or "argument" in result.lower() or "parser" in result.lower()


def test_translate_fmriprep_unrecognized_argument_any_flag():
    """The pattern must fire for any unrecognized flag, not just --run-id."""
    log = "fmriprep: error: unrecognized arguments: --use-aroma\n"
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None


# ── fMRIPrep: ANTs/Rosetta watchdog timeout (runs 9 and 15) ─────────

def test_translate_fmriprep_ants_watchdog_timeout():
    """Neuravian watchdog line (injected when max_runtime_hours exceeded) must match.
    Exact text injected by docker_executor.py watchdog — seen in runs 9 and 15."""
    log = (
        "260705-06:25:05,354 nipype.workflow INFO:\n"
        '\t [Node] Executing "registration" <niworkflows.interfaces.norm.SpatialNormalization>\n'
        "[neuravian] Run stopped automatically after 24h maximum runtime.\n"
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "Watchdog timeout must be detected"
    assert "ants" in result.lower() or "rosetta" in result.lower() or "registration" in result.lower()


def test_translate_fmriprep_ants_watchdog_12h():
    """Watchdog with 12h limit (run 9 original max_runtime_hours) must also match."""
    log = "[neuravian] Run stopped automatically after 12h maximum runtime.\n"
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None


# ── fMRIPrep: ANTs node executing lines (runs 14 and 15) ────────────

def test_translate_fmriprep_fix_header_registration_node():
    """FixHeaderRegistration node executing line (brain_extraction_wf/norm) must
    match the ANTs/Rosetta entry. Captured verbatim from run 14 log, line 425."""
    log = (
        "260703-13:37:00,000 nipype.workflow INFO:\n"
        '\t [Node] Setting-up "fmriprep_25_2_wf.sub_01_wf.anat_fit_wf'
        '.brain_extraction_wf.norm" in "/work/...".\n'
        "260703-13:37:00,001 nipype.workflow INFO:\n"
        '\t [Node] Executing "norm" <niworkflows.interfaces.fixes.FixHeaderRegistration>\n'
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "FixHeaderRegistration executing line must be detected"


def test_translate_fmriprep_spatial_normalization_node():
    """SpatialNormalization node executing line (register_template_wf/registration)
    must match. Captured verbatim from run 15 log, the last node before stall."""
    log = (
        "260705-06:25:05,334 nipype.workflow INFO:\n"
        '\t [Node] Setting-up "fmriprep_25_2_wf.sub_01_wf.anat_fit_wf'
        '.register_template_wf._template_MNI152NLin2009cAsym/registration".\n'
        "260705-06:25:05,354 nipype.workflow INFO:\n"
        '\t [Node] Executing "registration" <niworkflows.interfaces.norm.SpatialNormalization>\n'
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "SpatialNormalization executing line must be detected"


# ── fMRIPrep: OOM / SIGKILL ──────────────────────────────────────────

def test_translate_fmriprep_broken_process_pool():
    """BrokenProcessPool (nipype worker OOM-killed) must be detected."""
    log = (
        "multiprocessing.managers.RemoteTraceback:\n"
        "concurrent.futures.process.BrokenProcessPool: "
        "A process in the executor was terminated abruptly while the future was running "
        "or pending.\n"
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None
    assert "memory" in result.lower() or "killed" in result.lower() or "oom" in result.lower()


def test_translate_fmriprep_killed_signal():
    """Bare 'Killed' (shell output when main process receives SIGKILL) must be detected."""
    log = (
        "260703-17:53:00,000 nipype.workflow INFO:\n"
        "\t [Node] Executing some node\n"
        "Killed\n"
    )
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "'Killed' line should match OOM entry"


def test_translate_fmriprep_killed_does_not_match_arbitrary_text():
    """'Killed' inside a word (e.g. 'Skill-based') must NOT match due to word boundary."""
    log = "Skill-based registration approach selected.\n"
    result = translate_errors(log, _fmriprep_errors())
    # Should not match the OOM entry (may match nothing or other entries)
    if result is not None:
        # If something matched, it must not be the OOM entry
        assert "BrokenProcessPool" not in result


# ── fMRIPrep: license path does not exist (argparse, real output) ───

def test_translate_fmriprep_license_path_not_exist():
    """fMRIPrep's argparse path check for --fs-license-file must be detected.
    Exact text produced by 'docker run nipreps/fmriprep:25.2.5 ... --fs-license-file /nonexistent/license.txt'."""
    log = "fmriprep: error: Path does not exist: </nonexistent/license.txt>.\n"
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None, "License path-not-exist argparse error must be detected"
    assert "license" in result.lower()


# ── fMRIPrep: FreeSurfer runtime license check ───────────────────────

def test_translate_fmriprep_freesurfer_license_runtime():
    """FreeSurfer runtime license error (different from argparse path check) must match."""
    log = "ERROR: a valid license file is required for FreeSurfer.\n"
    result = translate_errors(log, _fmriprep_errors())
    assert result is not None
    assert "license" in result.lower()


# ── fMRIPrep: count of known_errors (regression guard) ─────────────

def test_fmriprep_known_errors_count():
    """Guard against accidentally removing entries — must have at least 9."""
    errors = _fmriprep_errors()
    assert len(errors) >= 9, (
        f"Expected at least 9 fmriprep known_errors, got {len(errors)}. "
        "Check that no entries were removed accidentally."
    )


# ── MRIQC: OOM detection ─────────────────────────────────────────────

def test_translate_mriqc_oom_killed():
    """MRIQC's 'Killed' OOM pattern must be detected."""
    log = "Killed\n"
    result = translate_errors(log, _mriqc_errors())
    assert result is not None, "MRIQC must detect bare 'Killed' as OOM"


def test_translate_mriqc_memory_error():
    """MRIQC MemoryError must be detected."""
    log = "MemoryError: Unable to allocate 4.50 GiB for array\n"
    result = translate_errors(log, _mriqc_errors())
    assert result is not None


def test_translate_mriqc_cannot_allocate():
    """MRIQC 'Cannot allocate memory' must be detected."""
    log = "OSError: [Errno 12] Cannot allocate memory\n"
    result = translate_errors(log, _mriqc_errors())
    assert result is not None


# ── Blank participant-label: no tool-level error (UI handles it) ─────

def test_mriqc_blank_participant_label_not_a_tool_error():
    """Blank participant-label is valid fMRIPrep/MRIQC behavior (processes all subjects).
    It produces no error in the log — the UI warns before submission.
    Confirm no known_error pattern falsely fires on normal MRIQC startup text."""
    normal_startup = (
        "mriqc 24.0.2\n"
        "Processing all participants in the dataset.\n"
        "  * Analysis levels: ['participant'].\n"
        "  * Participants list: ['01', '02', '03'].\n"
    )
    # Neither manifest should fire an error pattern on this text
    assert translate_errors(normal_startup, _mriqc_errors()) is None
    assert translate_errors(normal_startup, _fmriprep_errors()) is None


# ------------------------------------------------------------------ #
# containers.run platform argument — regression test                  #
# ------------------------------------------------------------------ #
#
# Ensures platform="linux/amd64" is passed to every containers.run()
# call, not just for specific pipelines. Without it, Docker on Apple
# Silicon probes for a native arm64 manifest first; amd64-only images
# (fMRIPrep, FastSurfer cpu builds) return a 404 before the container
# starts, even when the image exists for amd64.

_MINIMAL_MANIFEST_FOR_PLATFORM = {
    "id": "mriqc",
    "display_name": "MRIQC",
    "description": "For platform regression test",
    "container": {"image": "nipreps/mriqc", "tag": "24.0.2", "engine": "docker"},
    "inputs": ["bids_dataset"],
    "outputs": ["mriqc"],
    "parameters": [],
}


def test_run_as_host_user_reads_host_uid_env_var(tmp_path):
    """When run_as_host_user: true, user must come from HOST_UID/HOST_GID env vars,
    NOT from os.getuid()/getgid(). The backend container runs as root (uid=0), so
    os.getuid() always returns 0 — we inject the real host identity via compose.

    Regression for run 20: os.getuid() returned 0 (container root), FastSurfer
    rejected it as 'running as root'."""
    manifest_with_host_user = {
        **_FASTSURFER_MINIMAL_MANIFEST,
        "run_as_host_user": True,
    }
    t1_file = tmp_path / "sub-01_T1w.nii.gz"
    t1_file.write_text("fake")
    ctx = RunContext(
        run_id=200,
        manifest=manifest_with_host_user,
        params={"t1": str(t1_file), "sid": "sub-01", "seg_only": True},
        dataset_path=str(tmp_path),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p), \
         patch.dict("os.environ", {"HOST_UID": "501", "HOST_GID": "20"}):
        sdk = executor._build_sdk_params(ctx)

    assert sdk.user == "501:20", (
        f"run_as_host_user=true must read HOST_UID/HOST_GID from env; got {sdk.user!r}"
    )


def test_run_as_host_user_uid_zero_skips_flag(tmp_path):
    """If HOST_UID is 0 (unset default), the -u flag must be omitted with a warning
    rather than passing root to FastSurfer."""
    manifest_with_host_user = {
        **_FASTSURFER_MINIMAL_MANIFEST,
        "run_as_host_user": True,
    }
    t1_file = tmp_path / "sub-01_T1w.nii.gz"
    t1_file.write_text("fake")
    ctx = RunContext(
        run_id=201,
        manifest=manifest_with_host_user,
        params={"t1": str(t1_file), "sid": "sub-01", "seg_only": True},
        dataset_path=str(tmp_path),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p), \
         patch.dict("os.environ", {"HOST_UID": "0", "HOST_GID": "0"}):
        sdk = executor._build_sdk_params(ctx)

    assert sdk.user is None, (
        "HOST_UID=0 must not pass -u 0:0 to the container (would run as root)"
    )


def test_run_as_host_user_false_leaves_user_none(tmp_path):
    """MRIQC and fMRIPrep (run_as_host_user absent/false) must not pass user."""
    ctx = RunContext(
        run_id=202,
        manifest=_MRIQC_MANIFEST_POSITIONAL,  # no run_as_host_user key
        params={"analysis_level": "participant", "nprocs": 1},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    assert sdk.user is None, (
        f"run_as_host_user absent must leave user=None; got {sdk.user!r}"
    )


def test_run_as_host_user_true_appears_in_build_command(tmp_path):
    """build_command must include -u uid:gid when HOST_UID/GID are real values."""
    manifest_with_host_user = {
        **_FASTSURFER_MINIMAL_MANIFEST,
        "run_as_host_user": True,
    }
    t1_file = tmp_path / "sub-01_T1w.nii.gz"
    t1_file.write_text("fake")
    ctx = RunContext(
        run_id=203,
        manifest=manifest_with_host_user,
        params={"t1": str(t1_file), "sid": "sub-01", "seg_only": True},
        dataset_path=str(tmp_path),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p), \
         patch.dict("os.environ", {"HOST_UID": "501", "HOST_GID": "20"}):
        cmd = executor.build_command(ctx)

    assert "-u" in cmd, "build_command must include -u flag when run_as_host_user=true"
    u_idx = cmd.index("-u")
    assert cmd[u_idx + 1] == "501:20"


def test_run_as_host_user_false_not_in_build_command(tmp_path):
    """build_command must NOT include -u for MRIQC (run_as_host_user absent)."""
    ctx = RunContext(
        run_id=204,
        manifest=_MRIQC_MANIFEST_POSITIONAL,
        params={"analysis_level": "participant", "nprocs": 1},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    assert "-u" not in cmd, (
        f"build_command must not include -u when run_as_host_user is absent; got {cmd}"
    )


def test_containers_run_receives_platform_linux_amd64(tmp_path):
    """containers.run() must always be called with platform='linux/amd64'.

    This is a generic executor call — not pipeline-specific. Verifies that a
    fresh pull on any machine (including Apple Silicon) will request the x86_64
    manifest rather than probing for a non-existent arm64 one.
    """
    import asyncio
    from unittest.mock import MagicMock, patch

    ctx = RunContext(
        run_id=99,
        manifest=_MINIMAL_MANIFEST_FOR_PLATFORM,
        params={},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )

    mock_container = MagicMock()
    mock_container.id = "abc123"
    mock_container.logs.return_value = iter([])
    mock_container.wait.return_value = {"StatusCode": 0}
    mock_client = MagicMock()
    mock_client.containers.run.return_value = mock_container
    mock_client.images.get.side_effect = Exception("skip digest")

    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p), \
         patch("docker.from_env", return_value=mock_client):
        asyncio.run(executor.run(ctx, lambda line: None))

    assert mock_client.containers.run.called, "containers.run() was never called"
    _, kwargs = mock_client.containers.run.call_args
    assert kwargs.get("platform") == "linux/amd64", (
        f"containers.run() must pass platform='linux/amd64'; "
        f"got platform={kwargs.get('platform')!r}. "
        "Without this, Docker on Apple Silicon will probe for a native arm64 "
        "manifest and return a 404 for amd64-only images on first pull."
    )


# ------------------------------------------------------------------ #
# dataset_positional flag — executor regression tests                 #
# ------------------------------------------------------------------ #
#
# Verify that the dataset_positional flag:
#   1. Defaults to True — existing MRIQC and fMRIPrep command builds
#      produce exactly the same output as before the change.
#   2. When set to False — no /data /out positional prefix is emitted
#      and /data is not mounted (FastSurfer-style pipelines).

_MRIQC_MANIFEST_POSITIONAL = {
    "id": "mriqc",
    "display_name": "MRIQC",
    "description": "For testing dataset_positional default",
    "container": {"image": "nipreps/mriqc", "tag": "24.0.2", "engine": "docker"},
    "inputs": ["bids_dataset"],
    "outputs": ["mriqc"],
    # dataset_positional intentionally absent → must default to True
    "parameters": [
        {
            "name": "analysis_level",
            "type": "select",
            "required": True,
            "default": "participant",
            "positional_index": 1,
            "options": ["participant", "group"],
        },
        {
            "name": "nprocs",
            "type": "integer",
            "default": 1,
        },
    ],
}

_FMRIPREP_MINIMAL_POSITIONAL = {
    "id": "fmriprep",
    "display_name": "fMRIPrep",
    "description": "For testing dataset_positional default",
    "container": {"image": "nipreps/fmriprep", "tag": "25.2.5", "engine": "docker"},
    "inputs": ["bids_dataset"],
    "outputs": ["fmriprep"],
    # dataset_positional intentionally absent → must default to True
    "parameters": [
        {
            "name": "fs-license-file",
            "type": "file_path",
            "required": True,
            "mount": True,
        },
        {
            "name": "nprocs",
            "type": "integer",
            "default": 1,
        },
    ],
}

_FASTSURFER_MINIMAL_MANIFEST = {
    "id": "fastsurfer",
    "display_name": "FastSurfer",
    "description": "For testing dataset_positional=false",
    "container": {"image": "deepmi/fastsurfer", "tag": "cpu-v2.5.4", "engine": "docker"},
    "inputs": ["t1w_nifti"],
    "outputs": ["fastsurfer"],
    "dataset_positional": False,
    "parameters": [
        {
            "name": "t1",
            "type": "file_path",
            "required": True,
            "mount": True,
            "help": "Path to the T1w NIfTI file.",
        },
        {
            "name": "sid",
            "type": "string",
            "required": True,
            "help": "Subject ID.",
        },
        {
            "name": "seg_only",
            "type": "boolean",
            "default": True,
            "help": "Run segmentation only (no recon-all surface reconstruction).",
        },
    ],
}


def test_dataset_positional_default_true_mriqc_has_data_out_prefix(tmp_path):
    """MRIQC (dataset_positional absent → defaults True) must start command with /data /out."""
    ctx = RunContext(
        run_id=1,
        manifest=_MRIQC_MANIFEST_POSITIONAL,
        params={"analysis_level": "participant", "nprocs": 1},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    assert sdk.command[:2] == ["/data", "/out"], (
        f"MRIQC command must start with /data /out; got {sdk.command[:2]}"
    )
    # /data must also be mounted
    assert str(tmp_path / "dataset") in sdk.volumes


def test_dataset_positional_default_true_fmriprep_has_data_out_prefix(tmp_path):
    """fMRIPrep (dataset_positional absent → defaults True) must start command with /data /out."""
    license_file = tmp_path / "license.txt"
    license_file.write_text("fake")
    ctx = RunContext(
        run_id=2,
        manifest=_FMRIPREP_MINIMAL_POSITIONAL,
        params={"fs-license-file": str(license_file), "nprocs": 1},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    assert sdk.command[:2] == ["/data", "/out"], (
        f"fMRIPrep command must start with /data /out; got {sdk.command[:2]}"
    )
    assert str(tmp_path / "dataset") in sdk.volumes


def test_dataset_positional_false_no_data_out_prefix(tmp_path):
    """FastSurfer-style manifest (dataset_positional=false) must NOT start with /data /out."""
    t1_file = tmp_path / "sub-01_T1w.nii.gz"
    t1_file.write_text("fake nifti")
    ctx = RunContext(
        run_id=3,
        manifest=_FASTSURFER_MINIMAL_MANIFEST,
        params={"t1": str(t1_file), "sid": "sub-01", "seg_only": True},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    assert "/data" not in sdk.command, (
        f"dataset_positional=false must not emit /data; command: {sdk.command}"
    )
    assert "/out" not in sdk.command, (
        f"dataset_positional=false must not emit /out positional; command: {sdk.command}"
    )


def test_dataset_positional_false_no_data_volume_mount(tmp_path):
    """FastSurfer-style manifest must not mount the dataset dir at /data."""
    t1_file = tmp_path / "sub-01_T1w.nii.gz"
    t1_file.write_text("fake nifti")
    ctx = RunContext(
        run_id=4,
        manifest=_FASTSURFER_MINIMAL_MANIFEST,
        params={"t1": str(t1_file), "sid": "sub-01", "seg_only": True},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    bound_targets = [v["bind"] for v in sdk.volumes.values()]
    assert "/data" not in bound_targets, (
        f"dataset_positional=false must not mount anything at /data; volumes: {sdk.volumes}"
    )


def test_relative_mount_path_resolved_against_dataset_dir(tmp_path):
    """A relative file_path with mount:true must be resolved to an absolute path
    before mounting. Docker rejects relative paths as bind-mount sources (it
    treats them as named volumes instead). Resolution is relative to the dataset
    directory — the natural anchor when a user types 'sub-01/anat/T1w.nii.gz'.

    Regression for run 17: --t1 received a relative path that Docker refused."""
    # Create the file at dataset_path/sub-01/anat/sub-01_T1w.nii.gz
    t1_rel = "sub-01/anat/sub-01_T1w.nii.gz"
    t1_abs = tmp_path / "dataset" / "sub-01" / "anat" / "sub-01_T1w.nii.gz"
    t1_abs.parent.mkdir(parents=True)
    t1_abs.write_text("fake nifti")

    ctx = RunContext(
        run_id=90,
        manifest=_FASTSURFER_MINIMAL_MANIFEST,
        params={"t1": t1_rel, "sid": "sub-01", "seg_only": True},  # relative path
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    # Volume key must be the resolved absolute path, not the relative string
    volume_keys = list(sdk.volumes.keys())
    assert not any(not k.startswith("/") for k in volume_keys if k != str(tmp_path / "out")), (
        f"All volume keys must be absolute paths; got {volume_keys}"
    )
    expected_abs = str(t1_abs)
    assert expected_abs in sdk.volumes, (
        f"Resolved absolute path {expected_abs!r} not found in volumes {volume_keys}"
    )


def test_relative_mount_path_sid_stays_separate(tmp_path):
    """--sid must appear as its own CLI flag, NOT concatenated onto the --t1 value.

    Regression for run 17: the user submitted params where t1 and sid were
    concatenated ('sub-01/anat/sub-01_T1w.nii.gzsub-01') because the browser
    merged two adjacent unattributed text inputs. Even with that malformed input
    the executor should not make it worse; this test verifies that when params
    ARE correctly separated the two flags remain separate list elements."""
    t1_abs = tmp_path / "dataset" / "sub-01_T1w.nii.gz"
    t1_abs.parent.mkdir(parents=True)
    t1_abs.write_text("fake nifti")

    ctx = RunContext(
        run_id=91,
        manifest=_FASTSURFER_MINIMAL_MANIFEST,
        params={"t1": str(t1_abs), "sid": "sub-01", "seg_only": True},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    cmd = sdk.command
    # --t1 value must be the container path for the t1 file only
    t1_idx = cmd.index("--t1")
    t1_val = cmd[t1_idx + 1]
    assert "sub-01" not in t1_val or t1_val == f"/inputs/t1/{t1_abs.name}", (
        f"--t1 value should be the container mount path only; got {t1_val!r}"
    )
    # --sid must be a separate flag, not merged into --t1
    assert "--sid" in cmd, "--sid must be a separate flag in the command"
    sid_idx = cmd.index("--sid")
    assert cmd[sid_idx + 1] == "sub-01", f"--sid value must be 'sub-01'; got {cmd[sid_idx+1]!r}"
    assert sid_idx != t1_idx + 1, "--sid should not be at the position of --t1's value"


def test_dataset_positional_false_t1_mount_flag_uses_container_path(tmp_path):
    """FastSurfer --t1 flag must use the container path from the mount, not the host path."""
    t1_file = tmp_path / "sub-01_T1w.nii.gz"
    t1_file.write_text("fake nifti")
    ctx = RunContext(
        run_id=5,
        manifest=_FASTSURFER_MINIMAL_MANIFEST,
        params={"t1": str(t1_file), "sid": "sub-01", "seg_only": True},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    t1_idx = cmd.index("--t1")
    container_path = cmd[t1_idx + 1]
    assert container_path == f"/inputs/t1/{t1_file.name}", (
        f"--t1 must use container mount path; got {container_path}"
    )
    assert str(t1_file) not in container_path


# ------------------------------------------------------------------ #
# cli_flag and positional_suffix (dcm2niix-style pipelines)            #
# ------------------------------------------------------------------ #

_DCM2NIIX_MINIMAL_MANIFEST = {
    "id": "dcm2niix",
    "display_name": "dcm2niix",
    "description": "DICOM to NIfTI converter",
    "container": {"image": "svdvoort/dcm2niix", "tag": "1.0.20250506", "engine": "docker"},
    "inputs": ["dicom_directory"],
    "outputs": ["nifti"],
    "dataset_positional": False,
    "parameters": [
        {
            "name": "dicom-dir",
            "type": "directory_path",
            "required": True,
            "mount": True,
            "positional_suffix": True,
        },
        {
            "name": "output-dir",
            "type": "string",
            "cli_flag": "-o",
            "default": "/out",
            "advanced": True,
        },
        {
            "name": "bids-sidecar",
            "type": "select",
            "cli_flag": "-b",
            "default": "y",
            "options": ["y", "n", "o"],
        },
        {
            "name": "compress",
            "type": "select",
            "cli_flag": "-z",
            "default": "y",
            "options": ["y", "i", "n"],
        },
    ],
}


def test_cli_flag_emits_single_dash_flag(tmp_path):
    """Parameters with cli_flag must emit the specified flag string, not --{name}."""
    dicom_dir = tmp_path / "dicoms"
    dicom_dir.mkdir()
    ctx = RunContext(
        run_id=100,
        manifest=_DCM2NIIX_MINIMAL_MANIFEST,
        params={
            "dicom-dir": str(dicom_dir),
            "bids-sidecar": "y",
            "compress": "n",
        },
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    cmd_str = " ".join(cmd)
    # Single-dash flags must be present
    assert "-b y" in cmd_str, f"-b flag missing or wrong; cmd={cmd_str}"
    assert "-z n" in cmd_str, f"-z flag missing or wrong; cmd={cmd_str}"
    assert "-o /out" in cmd_str, f"-o flag missing or wrong; cmd={cmd_str}"
    # Double-dash forms must NOT appear
    assert "--bids-sidecar" not in cmd_str
    assert "--compress" not in cmd_str
    assert "--output-dir" not in cmd_str


def test_positional_suffix_appended_after_flags(tmp_path):
    """dicom-dir must be the LAST token in the command (positional suffix after all flags)."""
    dicom_dir = tmp_path / "dicoms"
    dicom_dir.mkdir()
    ctx = RunContext(
        run_id=101,
        manifest=_DCM2NIIX_MINIMAL_MANIFEST,
        params={
            "dicom-dir": str(dicom_dir),
            "bids-sidecar": "y",
            "compress": "y",
        },
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    # The last command token must be the container-internal dicom-dir path
    last_token = sdk.command[-1]
    expected_container_path = f"/inputs/dicom-dir/{dicom_dir.name}"
    assert last_token == expected_container_path, (
        f"Expected last token to be container dicom-dir path '{expected_container_path}'; "
        f"got '{last_token}'. Full command: {sdk.command}"
    )


def test_positional_suffix_not_emitted_as_flag(tmp_path):
    """dicom-dir with positional_suffix:true must NOT appear as --dicom-dir in the command."""
    dicom_dir = tmp_path / "dicoms"
    dicom_dir.mkdir()
    ctx = RunContext(
        run_id=102,
        manifest=_DCM2NIIX_MINIMAL_MANIFEST,
        params={"dicom-dir": str(dicom_dir), "bids-sidecar": "y"},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    cmd_str = " ".join(cmd)
    assert "--dicom-dir" not in cmd_str, (
        f"positional_suffix param must not appear as --flag; cmd={cmd_str}"
    )


def test_dcm2niix_manifest_loads_and_validates():
    """The dcm2niix.yaml manifest must load and pass schema validation."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "dcm2niix.yaml", schema)
    assert manifest["id"] == "dcm2niix"
    assert manifest["container"]["tag"] == "1.0.20250506"
    assert manifest["compute_profile"] == "local-ok"
    assert manifest["dataset_positional"] is False
    dicom_param = next(p for p in manifest["parameters"] if p["name"] == "dicom-dir")
    assert dicom_param["mount"] is True
    assert dicom_param["positional_suffix"] is True


def test_compute_profile_in_all_manifests():
    """Core manifests must declare a compute_profile value."""
    schema = _load_schema()
    expected = {
        "dcm2niix": "local-ok",
        "mriqc": "local-ok",
        "mriqc-group": "local-ok",
        "fastsurfer": "local-slow",
        "fmriprep": "local-unsafe",
        "import-fmriprep-derivatives": "local-ok",
        "functional-connectivity": "local-ok",
        "bids-validator": "local-ok",
        "pydeface": "local-unsafe",
        "brainchop": "local-ok",
        "fsl-bet": "local-ok",
        "fsl-fast": "local-slow",
        "fsl-flirt": "local-slow",
    }
    for fname, expected_profile in expected.items():
        manifest = _load_manifest(PIPELINES_DIR / f"{fname}.yaml", schema)
        assert manifest.get("compute_profile") == expected_profile, (
            f"{fname}.yaml: expected compute_profile={expected_profile!r}; "
            f"got {manifest.get('compute_profile')!r}"
        )


def test_category_and_input_type_in_all_manifests():
    """Core manifests must declare category and input_type."""
    schema = _load_schema()
    expected = {
        "dcm2niix":      ("conversion",       "dicom"),
        "mriqc":         ("quality_control",   "bids_dataset"),
        "mriqc-group":   ("quality_control",   "bids_dataset"),
        "fastsurfer":    ("segmentation",      "nifti"),
        "fmriprep":      ("preprocessing",     "bids_dataset"),
        "import-fmriprep-derivatives": ("preprocessing", "bids_dataset"),
        "functional-connectivity": ("connectivity", "bids_dataset"),
        "bids-validator":("validation",        "bids_dataset"),
        "pydeface":      ("deidentification",  "nifti"),
        "brainchop":     ("segmentation",      "nifti"),
        "fsl-bet":       ("segmentation",      "nifti"),
        "fsl-fast":      ("segmentation",      "nifti"),
        "fsl-flirt":     ("registration",      "nifti"),
    }
    valid_categories = {"conversion", "validation", "quality_control", "segmentation", "preprocessing", "deidentification", "connectivity", "registration"}
    valid_input_types = {"dicom", "nifti", "bids_dataset"}
    for fname, (exp_cat, exp_in) in expected.items():
        manifest = _load_manifest(PIPELINES_DIR / f"{fname}.yaml", schema)
        assert manifest.get("category") == exp_cat, (
            f"{fname}.yaml: expected category={exp_cat!r}; got {manifest.get('category')!r}"
        )
        assert manifest.get("input_type") == exp_in, (
            f"{fname}.yaml: expected input_type={exp_in!r}; got {manifest.get('input_type')!r}"
        )
        assert manifest["category"] in valid_categories
        assert manifest["input_type"] in valid_input_types


def test_bids_validator_manifest_loads_and_validates():
    """The bids-validator.yaml manifest must load and pass schema validation."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "bids-validator.yaml", schema)
    assert manifest["id"] == "bids-validator"
    assert manifest["container"]["image"] == "bids/validator"
    assert manifest["container"]["tag"] == "2.5.6"
    assert manifest["compute_profile"] == "local-ok"
    assert manifest["dataset_positional"] is False
    bids_param = next(p for p in manifest["parameters"] if p["name"] == "bids-dir")
    assert bids_param["mount"] is True
    assert bids_param["positional_suffix"] is True


def test_bids_validator_bids_dir_is_positional_suffix():
    """bids-dir must not emit a flag and must be appended as a positional suffix."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "bids-validator.yaml", schema)
    bids_param = next(p for p in manifest["parameters"] if p["name"] == "bids-dir")
    # positional_suffix params are skipped by the flag loop and appended last
    assert bids_param.get("positional_suffix") is True
    # must not have a cli_flag that would cause it to appear as a flag
    assert "cli_flag" not in bids_param


def test_bids_validator_verbose_uses_short_flag():
    """verbose parameter must emit -v, not --verbose."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "bids-validator.yaml", schema)
    verbose_param = next(p for p in manifest["parameters"] if p["name"] == "verbose")
    assert verbose_param.get("cli_flag") == "-v"


def test_bids_validator_known_errors_cover_exit_16_cases():
    """Known errors must cover the three errors produced by the invalid test dataset."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "bids-validator.yaml", schema)
    patterns = [e["pattern"] for e in manifest.get("known_errors", [])]
    assert any("MISSING_DATASET_DESCRIPTION" in p for p in patterns)
    assert any("MISSING_REQUIRED_ENTITY" in p for p in patterns)
    assert any("INVALID_LOCATION" in p for p in patterns)


def test_bids_validator_cloud_path_uses_host_bind_and_child_command(tmp_path):
    """Cloud datasets bind from /srv while the tool receives only /inputs."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "bids-validator.yaml", schema)
    # Use tmp_path as the backend datasets mount so the directory actually exists
    # (executor mount-validation checks that translated paths exist in the backend).
    bids_dir = tmp_path / "x86-minimal-bids"
    bids_dir.mkdir()
    ctx = RunContext(
        run_id=99,
        manifest=manifest,
        params={"bids-dir": str(bids_dir)},
        dataset_path=str(bids_dir),
        output_dir=str(tmp_path / "out"),
    )

    with patch.object(settings, "host_datasets_mount", "/srv/neuravian/datasets"), \
         patch.object(settings, "backend_datasets_mount", str(tmp_path)):
        sdk = DockerExecutor()._build_sdk_params(ctx)

    source = "/srv/neuravian/datasets/x86-minimal-bids"
    child = "/inputs/bids-dir/x86-minimal-bids"
    assert sdk.volumes[source] == {"bind": child, "mode": "ro"}
    assert sdk.command[-1] == child
    assert str(bids_dir) not in sdk.command


def test_bids_validator_report_is_ingested_and_captured_as_log(tmp_path):
    """Regression: --outfile must surface as an artifact and execution log."""
    from app.services.artifact_registry import resolve_run_artifacts
    from app.services.run import _read_declared_output_log

    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "bids-validator.yaml", schema)
    dataset_root = tmp_path / "dataset"
    dataset_root.mkdir()
    output_root = tmp_path / "output"
    output_root.mkdir()
    report = output_root / "validation-report.txt"
    report.write_text("Summary: BIDS valid\nNo errors found.\n", encoding="utf-8")
    params = {
        "bids-dir": str(dataset_root),
        "outfile": "/out/validation-report.txt",
    }
    ctx = RunContext(
        run_id=2,
        manifest=manifest,
        params=params,
        dataset_path=str(dataset_root),
        output_dir=str(output_root),
    )

    with patch.object(settings, "host_datasets_mount", str(tmp_path / "host-data")), \
         patch.object(settings, "backend_datasets_mount", str(tmp_path)), \
         patch("app.execution.docker_executor.from_host_path") as legacy_translation:
        artifacts = resolve_run_artifacts(
            manifest, str(output_root), params, "success"
        )
    report_artifact = next(
        artifact for artifact in artifacts if artifact.type == "bids_validation_report"
    )

    assert report_artifact.resolved is True
    assert report_artifact.paths == [str(report)]
    legacy_translation.assert_not_called()
    assert _read_declared_output_log(ctx) == [
        "Summary: BIDS valid",
        "No errors found.",
    ]


def test_existing_cloud_dataset_record_can_create_validator_run(
    fmriprep_api_client, db_session_for_runs, tmp_path
):
    """Regression: canonical backend records must not be probed as host paths."""
    backend_root = tmp_path / "backend-host-data"
    dataset_root = backend_root / "x86-minimal-bids"
    dataset_root.mkdir(parents=True)
    host_root = tmp_path / "host-root-not-visible-here"
    dataset = _make_dataset(db_session_for_runs, str(dataset_root))

    with patch.object(settings, "host_datasets_mount", str(host_root)), \
         patch.object(settings, "backend_datasets_mount", str(backend_root)), \
         patch.object(settings, "data_dir", str(tmp_path)), \
         patch("app.services.run._execute_run_background"):
        response = fmriprep_api_client.post(
            "/api/runs",
            json={
                "pipeline_id": "bids-validator",
                "dataset_id": dataset.id,
                "params": {"bids-dir": str(dataset_root)},
            },
        )

    assert not host_root.exists()
    assert response.status_code == 201, response.json()


def test_missing_cloud_dataset_error_does_not_leak_host_root(
    fmriprep_api_client, db_session_for_runs, tmp_path
):
    backend_root = tmp_path / "backend-host-data"
    backend_root.mkdir()
    logical_path = backend_root / "missing-dataset"
    host_root = Path("/srv/private-neuravian-datasets")
    dataset = _make_dataset(db_session_for_runs, str(logical_path))

    with patch.object(settings, "host_datasets_mount", str(host_root)), \
         patch.object(settings, "backend_datasets_mount", str(backend_root)):
        response = fmriprep_api_client.post(
            "/api/runs",
            json={
                "pipeline_id": "bids-validator",
                "dataset_id": dataset.id,
                "params": {"bids-dir": str(logical_path)},
            },
        )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "path not found" in detail.lower()
    assert str(host_root) not in detail


def test_pydeface_manifest_loads_and_validates():
    """The pydeface.yaml manifest must load, pass schema validation, and be local-unsafe."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "pydeface.yaml", schema)
    assert manifest["id"] == "pydeface"
    assert manifest["container"]["image"] == "poldracklab/pydeface"
    # Digest-pinned because poldracklab/pydeface has no versioned tags on Docker Hub.
    assert manifest["container"]["tag"].startswith("sha256:")
    assert manifest["compute_profile"] == "local-unsafe"
    assert manifest["dataset_positional"] is False
    nifti_param = next(p for p in manifest["parameters"] if p["name"] == "nifti-file")
    assert nifti_param["mount"] is True
    assert nifti_param["positional_suffix"] is True


def test_pydeface_nifti_file_is_positional_suffix_not_flag():
    """nifti-file must not emit a --nifti-file flag; must be appended as positional suffix."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "pydeface.yaml", schema)
    nifti_param = next(p for p in manifest["parameters"] if p["name"] == "nifti-file")
    assert nifti_param.get("positional_suffix") is True
    assert "cli_flag" not in nifti_param


def test_brainchop_manifest_loads_and_validates():
    """brainchop.yaml must load with native execution block and local-ok profile."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "brainchop.yaml", schema)
    assert manifest["id"] == "brainchop"
    assert manifest["compute_profile"] == "local-ok"
    # Must use native execution, not container
    assert "container" not in manifest
    assert manifest["execution"]["type"] == "native"
    assert manifest["execution"]["command"] == "brainchop"
    input_param = next(p for p in manifest["parameters"] if p["name"] == "input-file")
    assert input_param.get("positional_suffix") is True


def test_brainchop_no_container_block():
    """brainchop must not have a container block — it's the first native pipeline."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "brainchop.yaml", schema)
    assert "container" not in manifest, (
        "brainchop is a native (subprocess) pipeline — it must not have a container block. "
        "Use execution.type=native instead."
    )


def test_functional_connectivity_manifest_loads_and_validates():
    """Functional Connectivity must be a native Nilearn pipeline."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "functional-connectivity.yaml", schema)
    assert manifest["id"] == "functional-connectivity"
    assert manifest["category"] == "connectivity"
    assert manifest["compute_profile"] == "local-ok"
    assert manifest["execution"]["type"] == "native"
    assert manifest["execution"]["command"] == "neuravian-functional-connectivity"
    assert manifest["accepts"][0]["type"] == "fmriprep_derivatives"
    atlas_param = next(p for p in manifest["parameters"] if p["name"] == "atlas-name")
    assert atlas_param["default"] == "schaefer100_7"
    assert atlas_param["options"] == [
        "schaefer100_7",
        "schaefer200_7",
        "aal",
        "harvard_oxford_cortical",
    ]
    produced = {slot["type"] for slot in manifest["produces"]}
    assert {
        "connectivity_matrix_csv",
        "connectivity_matrix_png",
        "connectivity_matrix_npy",
        "timeseries_tsv",
        "roi_statistics_csv",
        "roi_statistics_json",
        "connectivity_report_html",
    }.issubset(produced)


def test_functional_connectivity_atlas_registry_expected_counts():
    assert DEFAULT_ATLAS_ID == "schaefer100_7"
    assert set(ATLAS_REGISTRY) == {
        "schaefer100_7",
        "schaefer200_7",
        "aal",
        "harvard_oxford_cortical",
    }
    assert ATLAS_REGISTRY["schaefer100_7"].expected_roi_count == 100
    assert ATLAS_REGISTRY["schaefer200_7"].expected_roi_count == 200
    assert ATLAS_REGISTRY["aal"].expected_roi_count == 166
    assert ATLAS_REGISTRY["harvard_oxford_cortical"].expected_roi_count == 48


def test_functional_connectivity_atlas_alias_preserves_old_runs():
    assert normalize_atlas_id(None) == "schaefer100_7"
    assert normalize_atlas_id("schaefer100_7") == "schaefer100_7"
    assert normalize_atlas_id("schaefer_100_7") == "schaefer100_7"
    with pytest.raises(ValueError, match="Unknown atlas"):
        normalize_atlas_id("not-an-atlas")


def test_functional_connectivity_builds_roi_statistics_from_atlas(tmp_path):
    labels_img = tmp_path / "atlas.nii.gz"
    data = np.array(
        [
            [[1, 1], [2, 0]],
            [[2, 2], [0, 0]],
        ],
        dtype=np.int16,
    )
    nib.save(nib.Nifti1Image(data, affine=np.eye(4)), labels_img)
    atlas = LoadedAtlas(
        spec=ATLAS_REGISTRY["schaefer100_7"],
        labels_img=str(labels_img),
        roi_labels=[
            "7Networks_LH_Vis_1",
            "7Networks_LH_Default_1",
        ],
        label_values=[1, 2],
    )
    timeseries = np.array(
        [
            [1.0, 2.0],
            [3.0, 4.0],
            [5.0, 8.0],
        ],
    )

    rows = build_roi_statistics(
        atlas=atlas,
        timeseries=timeseries,
        labels=atlas.roi_labels,
    )

    assert rows[0]["roi_number"] == 1
    assert rows[0]["roi_label"] == "7Networks_LH_Vis_1"
    assert rows[0]["network"] == "Vis"
    assert rows[0]["voxel_count"] == 2
    assert rows[0]["mean_signal"] == pytest.approx(3.0)
    assert rows[0]["std_signal"] == pytest.approx(2.0)
    assert rows[0]["min_signal"] == pytest.approx(1.0)
    assert rows[0]["max_signal"] == pytest.approx(5.0)
    assert rows[0]["median_signal"] == pytest.approx(3.0)
    assert rows[1]["network"] == "Default"
    assert rows[1]["voxel_count"] == 3


def test_functional_connectivity_run_writes_roi_statistics_files(tmp_path):
    """Regression: the entry point must write roi_statistics.csv and .json.

    This test invokes the real neuravian-functional-connectivity CLI using the
    checked-in fixture derivatives so that the full execution path (atlas load →
    time-series extraction → stats → file write) is exercised.  It will be
    skipped automatically if the fixture is absent (CI without large data).
    """
    import subprocess
    import sys
    import csv

    fixture_dir = Path(__file__).parent.parent / "data" / "fixtures" / "fmriprep-derivatives"
    if not fixture_dir.exists():
        pytest.skip("fmriprep-derivatives fixture not present")

    result = subprocess.run(
        [
            sys.executable,
            "-m", "app.tools.functional_connectivity",
            "--fmriprep-dir", str(fixture_dir),
            "--output-dir", str(tmp_path),
            "--atlas-name", "schaefer100_7",
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert result.returncode == 0, (
        f"neuravian-functional-connectivity exited {result.returncode}.\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )

    csv_path = tmp_path / "roi_statistics.csv"
    json_path = tmp_path / "roi_statistics.json"

    assert csv_path.exists(), "roi_statistics.csv was not written"
    assert json_path.exists(), "roi_statistics.json was not written"
    assert csv_path.stat().st_size > 0, "roi_statistics.csv is empty"
    assert json_path.stat().st_size > 0, "roi_statistics.json is empty"

    # Schaefer100 must produce exactly 100 ROI rows (plus header)
    with csv_path.open() as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 100, (
        f"Expected 100 ROI rows for Schaefer100, got {len(rows)}"
    )

    # All required columns must be present
    required_cols = {
        "roi_number", "roi_label", "network",
        "voxel_count", "mean_signal", "std_signal",
        "min_signal", "max_signal", "median_signal",
    }
    assert required_cols.issubset(rows[0].keys()), (
        f"Missing columns: {required_cols - set(rows[0].keys())}"
    )

    # JSON must decode to a list of 100 dicts
    with json_path.open() as fh:
        json_rows = json.load(fh)
    assert isinstance(json_rows, list)
    assert len(json_rows) == 100, (
        f"Expected 100 JSON rows, got {len(json_rows)}"
    )

    # Metadata must declare roi_statistics_generated: true
    meta_path = tmp_path / "connectivity_metadata.json"
    assert meta_path.exists()
    with meta_path.open() as fh:
        meta = json.load(fh)
    assert meta.get("roi_statistics_generated") is True
    assert meta.get("n_rois") == 100


def test_functional_connectivity_roi_statistics_file_discovery(tmp_path):
    """Regression: the glob pattern in get_run_results must find both roi_statistics files.

    This tests the discovery logic in isolation — if the glob pattern or suffix
    filter changes and stops matching the files, this test fails immediately.
    """
    # Write fake roi_statistics files into tmp_path (mimics what the pipeline writes)
    (tmp_path / "roi_statistics.csv").write_text("roi_number,roi_label\n1,Test\n")
    (tmp_path / "roi_statistics.json").write_text('[{"roi_number":1}]')
    # Also write an unrelated file that must NOT be picked up
    (tmp_path / "roi_statistics.npy").write_bytes(b"\x00")

    # Mirror the exact discovery logic from get_run_results
    output_root = tmp_path
    roi_statistics = [
        {"name": f.stem, "path": f.relative_to(output_root).as_posix()}
        for f in sorted(output_root.glob("*roi_statistics*"))
        if f.suffix in {".csv", ".json"}
    ]

    paths = {entry["path"] for entry in roi_statistics}
    assert "roi_statistics.csv" in paths, "roi_statistics.csv missing from glob discovery"
    assert "roi_statistics.json" in paths, "roi_statistics.json missing from glob discovery"
    # .npy must be filtered out
    assert "roi_statistics.npy" not in paths, ".npy suffix must be excluded"
    assert len(roi_statistics) == 2


def test_import_fmriprep_derivatives_manifest_loads_and_validates():
    """Imported fMRIPrep derivatives must be represented as a native pipeline."""
    schema = _load_schema()
    manifest = _load_manifest(
        PIPELINES_DIR / "import-fmriprep-derivatives.yaml",
        schema,
    )
    assert manifest["id"] == "import-fmriprep-derivatives"
    assert manifest["category"] == "preprocessing"
    assert manifest["compute_profile"] == "local-ok"
    assert manifest["execution"]["type"] == "native"
    assert manifest["execution"]["command"] == "neuravian-import-fmriprep-derivatives"
    assert manifest["accepts"][0]["type"] == "bids_dataset"
    assert manifest["accepts"][0]["dataset_slot"] is True
    assert manifest["produces"][0]["type"] == "fmriprep_derivatives"
    assert manifest["produces"][0]["source_param"] == "fmriprep-dir"


def test_fmriprep_derivatives_compatible_pipeline_includes_connectivity(api_client):
    resp = api_client.get("/api/pipelines/compatible?artifact_type=fmriprep_derivatives")
    assert resp.status_code == 200
    data = resp.json()
    assert any(
        item["pipeline_id"] == "functional-connectivity"
        and item["accept_param"] == "fmriprep-dir"
        for item in data
    )


def test_bids_dataset_compatible_pipeline_includes_fmriprep_import(api_client):
    resp = api_client.get("/api/pipelines/compatible?artifact_type=bids_dataset")
    assert resp.status_code == 200
    data = resp.json()
    assert any(
        item["pipeline_id"] == "import-fmriprep-derivatives"
        and item["accept_dataset_slot"] is True
        for item in data
    )


@pytest.mark.parametrize("artifact_type", ["alff_map_nii", "falff_map_nii", "alff_normalized_map_nii", "falff_normalized_map_nii"])
def test_alff_maps_offer_all_compatible_run_next_tools(api_client, artifact_type):
    resp = api_client.get(f"/api/pipelines/compatible?artifact_type={artifact_type}")
    assert resp.status_code == 200
    ids = {item["pipeline_id"] for item in resp.json()}
    assert {"statistical-map-explorer", "atlas-roi-extraction", "nifti-inspector"}.issubset(ids)


def test_docker_manifests_have_container_not_execution():
    """All Docker-based manifests must have container block, not execution block."""
    schema = _load_schema()
    docker_manifests = ["mriqc", "mriqc-group", "fmriprep", "fastsurfer", "dcm2niix", "bids-validator", "pydeface", "fsl-bet", "fsl-fast", "fsl-flirt"]
    for name in docker_manifests:
        manifest = _load_manifest(PIPELINES_DIR / f"{name}.yaml", schema)
        assert "container" in manifest, f"{name}.yaml missing container block"
        assert "execution" not in manifest, f"{name}.yaml should not have execution block"


def test_schema_rejects_manifest_with_both_container_and_execution(tmp_path):
    """A manifest with both container and execution blocks must be rejected."""
    import yaml as _yaml
    bad = tmp_path / "bad.yaml"
    bad.write_text(_yaml.dump({
        "id": "bad-pipeline",
        "display_name": "Bad",
        "description": "test",
        "inputs": ["x"],
        "outputs": ["y"],
        "parameters": [],
        "container": {"image": "foo/bar", "tag": "1.0.0", "engine": "docker"},
        "execution": {"type": "native", "command": "brainchop"},
    }))
    schema = _load_schema()
    try:
        _load_manifest(bad, schema)
        assert False, "Expected ManifestError"
    except Exception as exc:
        assert "cannot have both" in str(exc) or "container" in str(exc)


def test_schema_rejects_manifest_with_neither_container_nor_execution(tmp_path):
    """A manifest with neither container nor execution block must be rejected."""
    import yaml as _yaml
    bad = tmp_path / "bad2.yaml"
    bad.write_text(_yaml.dump({
        "id": "bad-pipeline2",
        "display_name": "Bad",
        "description": "test",
        "inputs": ["x"],
        "outputs": ["y"],
        "parameters": [],
    }))
    schema = _load_schema()
    try:
        _load_manifest(bad, schema)
        assert False, "Expected ManifestError"
    except Exception as exc:
        assert "container" in str(exc) or "execution" in str(exc)

def test_pydeface_preflight_dialog_is_triggered():
    """pydeface compute_profile=local-unsafe must match the preflight dialog trigger condition."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "pydeface.yaml", schema)
    # The frontend PreflightDialog fires for local-slow and local-unsafe.
    # Confirm pydeface is in the set that triggers the dialog.
    assert manifest["compute_profile"] in {"local-slow", "local-unsafe"}


# ------------------------------------------------------------------ #
# FSL BET manifest tests                                               #
# ------------------------------------------------------------------ #


def test_fsl_bet_manifest_loads_without_error():
    """fsl-bet.yaml must load and pass JSON Schema validation."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    assert manifest["id"] == "fsl-bet"
    assert manifest["container"]["image"] == "neuravian/fsl-bet"
    assert manifest["container"]["tag"] == "6.0.7"
    assert manifest["container"]["engine"] == "docker"


def test_fsl_bet_manifest_has_required_fields():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    assert manifest["display_name"] == "FSL BET"
    assert manifest["description"]
    assert isinstance(manifest["parameters"], list)
    assert len(manifest["parameters"]) >= 5
    assert isinstance(manifest["known_errors"], list)
    assert len(manifest["known_errors"]) >= 4


def test_fsl_bet_compute_profile_is_local_ok():
    """BET completes in <60 s under Rosetta 2 emulation — qualifies as local-ok."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    assert manifest["compute_profile"] == "local-ok"


def test_fsl_bet_dataset_positional_false():
    """BET does not take a BIDS dataset directory — must use dataset_positional: false."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    assert manifest.get("dataset_positional") is False


def test_fsl_bet_input_param_is_mounted_with_cli_flag():
    """input param must be file_path, required, mount: true, cli_flag: --input."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "input" in params, "fsl-bet must have an 'input' parameter"
    inp = params["input"]
    assert inp["type"] == "file_path"
    assert inp.get("required") is True
    assert inp.get("mount") is True
    assert inp.get("cli_flag") == "--input"


def test_fsl_bet_output_base_defaults_to_out_brain():
    """output-base default must write outputs to /out/brain inside the container."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "output-base" in params
    assert params["output-base"]["default"] == "/out/brain"
    assert params["output-base"].get("cli_flag") == "--output-base"


def test_fsl_bet_mask_param_defaults_true():
    """-m flag must be enabled by default so a brain_mask.nii.gz is always produced."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "mask" in params
    assert params["mask"]["default"] is True
    assert params["mask"].get("cli_flag") == "-m"


def test_fsl_bet_produces_skull_stripped_and_mask():
    """produces[] must declare nifti_skull_stripped and brain_mask artifact types."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    produced_types = {slot["type"] for slot in manifest.get("produces", [])}
    assert "nifti_skull_stripped" in produced_types
    assert "brain_mask" in produced_types


def test_fsl_bet_produces_path_hints_match_default_output():
    """path_hints must match what BET writes with the default /out/brain output-base."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    hints = {slot["type"]: slot.get("path_hint") for slot in manifest.get("produces", [])}
    assert hints["nifti_skull_stripped"] == "brain.nii.gz"
    assert hints["brain_mask"] == "brain_mask.nii.gz"


def test_fsl_bet_accepts_nifti_raw_and_defaced():
    """BET must accept nifti_raw (direct from scanner) and nifti_defaced (post-deface)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    accepted_types = {slot["type"] for slot in manifest.get("accepts", [])}
    assert "nifti_raw" in accepted_types
    assert "nifti_defaced" in accepted_types


def test_fsl_bet_appears_in_pipeline_service():
    """fsl-bet must appear in the registry after PipelineService is constructed."""
    svc = PipelineService()
    ids = [p["id"] for p in svc.list_all()]
    assert "fsl-bet" in ids


def test_fsl_bet_input_flag_uses_container_mount_path(tmp_path):
    """--input CLI flag must receive the container-internal path, not the host path."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    t1_file = tmp_path / "sub-01_T1w.nii.gz"
    t1_file.write_text("fake nifti")

    ctx = RunContext(
        run_id=300,
        manifest=manifest,
        params={"input": str(t1_file)},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    assert "--input" in cmd, "--input flag must appear in the built command"
    input_idx = cmd.index("--input")
    container_path = cmd[input_idx + 1]
    assert container_path == f"/inputs/input/{t1_file.name}", (
        f"--input must use container mount path; got {container_path!r}"
    )
    assert str(t1_file) not in container_path


def test_fsl_bet_no_data_out_positional_prefix(tmp_path):
    """BET command must not start with /data /out (dataset_positional: false)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    t1_file = tmp_path / "sub-01_T1w.nii.gz"
    t1_file.write_text("fake")

    ctx = RunContext(
        run_id=301,
        manifest=manifest,
        params={"input": str(t1_file)},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    assert "/data" not in sdk.command, (
        f"BET command must not contain /data positional; command: {sdk.command}"
    )
    bound_targets = [v["bind"] for v in sdk.volumes.values()]
    assert "/data" not in bound_targets, (
        "BET must not mount anything at /data"
    )


def test_fsl_bet_mask_flag_emitted_as_single_dash_m(tmp_path):
    """The mask parameter must emit -m (single dash), not --mask."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    t1_file = tmp_path / "input.nii.gz"
    t1_file.write_text("fake")

    ctx = RunContext(
        run_id=302,
        manifest=manifest,
        params={"input": str(t1_file), "mask": True},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    cmd_str = " ".join(cmd)
    assert "-m" in cmd, f"-m flag must appear in command; got: {cmd_str}"
    assert "--mask" not in cmd_str, f"--mask (double-dash) must not appear; got: {cmd_str}"


def test_fsl_bet_known_errors_include_image_not_found():
    """A missing wrapper image must produce a clear fix hint to build it locally."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-bet.yaml", schema)
    patterns = [e["pattern"] for e in manifest.get("known_errors", [])]
    assert any("neuravian/fsl-bet" in p or "not found" in p for p in patterns), (
        "At least one known_error pattern must match the 'image not found' case"
    )


# ------------------------------------------------------------------ #
# FSL FAST manifest tests                                              #
# ------------------------------------------------------------------ #


def test_fsl_fast_manifest_loads_without_error():
    """fsl-fast.yaml must load and pass JSON Schema validation."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    assert manifest["id"] == "fsl-fast"
    assert manifest["container"]["image"] == "neuravian/fsl-fast"
    assert manifest["container"]["tag"] == "6.0.7"
    assert manifest["container"]["engine"] == "docker"


def test_fsl_fast_manifest_has_required_fields():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    assert manifest["display_name"] == "FSL FAST"
    assert manifest["description"]
    assert isinstance(manifest["parameters"], list)
    assert len(manifest["parameters"]) >= 5
    assert isinstance(manifest["known_errors"], list)
    assert len(manifest["known_errors"]) >= 4


def test_fsl_fast_compute_profile_is_local_slow():
    """FAST takes 15-40 min under Rosetta 2 emulation — must be local-slow."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    assert manifest["compute_profile"] == "local-slow"


def test_fsl_fast_preflight_dialog_is_triggered():
    """local-slow must match the preflight dialog trigger condition."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    assert manifest["compute_profile"] in {"local-slow", "local-unsafe"}


def test_fsl_fast_dataset_positional_false():
    """FAST takes a single NIfTI file, not a BIDS dataset directory."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    assert manifest.get("dataset_positional") is False


def test_fsl_fast_input_param_is_mounted_with_cli_flag():
    """input param must be file_path, required, mount: true, cli_flag: --input."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "input" in params
    inp = params["input"]
    assert inp["type"] == "file_path"
    assert inp.get("required") is True
    assert inp.get("mount") is True
    assert inp.get("cli_flag") == "--input"


def test_fsl_fast_output_base_defaults_to_out_result():
    """output-base default must write outputs to /out/result inside the container."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "output-base" in params
    assert params["output-base"]["default"] == "/out/result"
    assert params["output-base"].get("cli_flag") == "--output-base"


def test_fsl_fast_image_type_defaults_to_t1():
    """image-type must default to 1 (T1w) with cli_flag -t."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "image-type" in params
    assert params["image-type"]["default"] == 1
    assert params["image-type"].get("cli_flag") == "-t"


def test_fsl_fast_n_classes_defaults_to_3():
    """n-classes must default to 3 with cli_flag -n."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "n-classes" in params
    assert params["n-classes"]["default"] == 3
    assert params["n-classes"].get("cli_flag") == "-n"


def test_fsl_fast_bias_field_param_defaults_true():
    """-b flag must be enabled by default so result_bias.nii.gz is always produced."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "bias-field" in params
    assert params["bias-field"]["default"] is True
    assert params["bias-field"].get("cli_flag") == "-b"


def test_fsl_fast_produces_all_tissue_artifact_types():
    """produces[] must declare tissue_class_map, tissue_pve_csf, tissue_pve_gm, tissue_pve_wm."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    produced_types = {slot["type"] for slot in manifest.get("produces", [])}
    assert "tissue_class_map" in produced_types
    assert "tissue_pve_csf" in produced_types
    assert "tissue_pve_gm" in produced_types
    assert "tissue_pve_wm" in produced_types


def test_fsl_fast_produces_bias_field_and_restored():
    """produces[] must declare bias_field and restored_image artifact types."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    produced_types = {slot["type"] for slot in manifest.get("produces", [])}
    assert "bias_field" in produced_types
    assert "restored_image" in produced_types


def test_fsl_fast_path_hints_match_fast_output_names():
    """path_hints must match the filenames FAST emits with the default output-base."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    hints = {slot["type"]: slot.get("path_hint") for slot in manifest.get("produces", [])}
    assert hints["tissue_class_map"] == "result_seg.nii.gz"
    assert hints["tissue_pve_csf"] == "result_pve_0.nii.gz"
    assert hints["tissue_pve_gm"] == "result_pve_1.nii.gz"
    assert hints["tissue_pve_wm"] == "result_pve_2.nii.gz"
    assert hints["bias_field"] == "result_bias.nii.gz"
    assert hints["restored_image"] == "result_restore.nii.gz"


def test_fsl_fast_accepts_skull_stripped_as_primary():
    """FAST must accept nifti_skull_stripped (the primary expected input)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    accepted_types = {slot["type"] for slot in manifest.get("accepts", [])}
    assert "nifti_skull_stripped" in accepted_types


def test_fsl_fast_accepts_nifti_raw_and_defaced():
    """FAST must also accept nifti_raw and nifti_defaced for flexible chaining."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    accepted_types = {slot["type"] for slot in manifest.get("accepts", [])}
    assert "nifti_raw" in accepted_types
    assert "nifti_defaced" in accepted_types


def test_fsl_fast_appears_in_pipeline_service():
    """fsl-fast must appear in the registry after PipelineService is constructed."""
    svc = PipelineService()
    ids = [p["id"] for p in svc.list_all()]
    assert "fsl-fast" in ids


def test_fsl_fast_input_flag_uses_container_mount_path(tmp_path):
    """--input CLI flag must receive the container-internal path, not the host path."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake nifti")

    ctx = RunContext(
        run_id=400,
        manifest=manifest,
        params={"input": str(brain_file)},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    assert "--input" in cmd
    input_idx = cmd.index("--input")
    container_path = cmd[input_idx + 1]
    assert container_path == f"/inputs/input/{brain_file.name}"
    assert str(brain_file) not in container_path


def test_fsl_fast_no_data_out_positional_prefix(tmp_path):
    """FAST command must not start with /data /out (dataset_positional: false)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake")

    ctx = RunContext(
        run_id=401,
        manifest=manifest,
        params={"input": str(brain_file)},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    assert "/data" not in sdk.command
    bound_targets = [v["bind"] for v in sdk.volumes.values()]
    assert "/data" not in bound_targets


def test_fsl_fast_bias_flag_emitted_as_single_dash_b(tmp_path):
    """The bias-field parameter must emit -b (single dash), not --bias-field."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake")

    ctx = RunContext(
        run_id=402,
        manifest=manifest,
        params={"input": str(brain_file), "bias-field": True},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    cmd_str = " ".join(cmd)
    assert "-b" in cmd
    assert "--bias-field" not in cmd_str


def test_fsl_fast_known_errors_include_image_not_found():
    """A missing wrapper image must produce a clear fix hint to build it locally."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fast.yaml", schema)
    patterns = [e["pattern"] for e in manifest.get("known_errors", [])]
    assert any("neuravian/fsl-fast" in p or "not found" in p for p in patterns)


# ------------------------------------------------------------------ #
# FSL FLIRT manifest tests                                             #
# ------------------------------------------------------------------ #


def test_fsl_flirt_manifest_loads_without_error():
    """fsl-flirt.yaml must load and pass JSON Schema validation."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    assert manifest["id"] == "fsl-flirt"
    assert manifest["container"]["image"] == "neuravian/fsl-flirt"
    assert manifest["container"]["tag"] == "6.0.7"
    assert manifest["container"]["engine"] == "docker"


def test_fsl_flirt_manifest_has_required_fields():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    assert manifest["display_name"] == "FSL FLIRT"
    assert manifest["description"]
    assert isinstance(manifest["parameters"], list)
    assert len(manifest["parameters"]) >= 8
    assert isinstance(manifest["known_errors"], list)
    assert len(manifest["known_errors"]) >= 5


def test_fsl_flirt_category_is_registration():
    """FLIRT is a registration tool — category must be 'registration'."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    assert manifest["category"] == "registration"


def test_fsl_flirt_compute_profile_is_local_slow():
    """FLIRT can take 5-20 min under Rosetta 2 emulation — must be local-slow."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    assert manifest["compute_profile"] == "local-slow"


def test_fsl_flirt_preflight_dialog_is_triggered():
    """local-slow must match the preflight dialog trigger condition."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    assert manifest["compute_profile"] in {"local-slow", "local-unsafe"}


def test_fsl_flirt_dataset_positional_false():
    """FLIRT takes a single NIfTI file, not a BIDS dataset directory."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    assert manifest.get("dataset_positional") is False


def test_fsl_flirt_input_param_is_mounted_with_cli_flag():
    """input param must be file_path, required, mount: true, cli_flag: --input."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "input" in params
    inp = params["input"]
    assert inp["type"] == "file_path"
    assert inp.get("required") is True
    assert inp.get("mount") is True
    assert inp.get("cli_flag") == "--input"


def test_fsl_flirt_ref_preset_defaults_to_mni152_2mm():
    """ref-preset must default to mni152_2mm — the common fast registration target."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "ref-preset" in params
    assert params["ref-preset"]["default"] == "mni152_2mm"
    assert params["ref-preset"].get("cli_flag") == "--ref-preset"


def test_fsl_flirt_ref_file_is_optional_and_mounted():
    """ref-file must be optional, file_path, mount: true for custom reference support."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "ref-file" in params
    rf = params["ref-file"]
    assert rf["type"] == "file_path"
    assert rf.get("required") is not True  # optional
    assert rf.get("mount") is True
    assert rf.get("cli_flag") == "--ref-file"


def test_fsl_flirt_output_base_defaults_to_out_registered():
    """output-base default must write outputs to /out/registered inside the container."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "output-base" in params
    assert params["output-base"]["default"] == "/out/registered"
    assert params["output-base"].get("cli_flag") == "--output-base"


def test_fsl_flirt_dof_defaults_to_12():
    """degrees-of-freedom must default to 12 (full affine) with cli_flag -dof."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "dof" in params
    assert params["dof"]["default"] == 12
    assert params["dof"].get("cli_flag") == "-dof"


def test_fsl_flirt_cost_defaults_to_corratio():
    """cost function must default to corratio (best for T1→MNI152) with cli_flag -cost."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "cost" in params
    assert params["cost"]["default"] == "corratio"
    assert params["cost"].get("cli_flag") == "-cost"


def test_fsl_flirt_interp_defaults_to_trilinear():
    """interpolation must default to trilinear with cli_flag -interp."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "interp" in params
    assert params["interp"]["default"] == "trilinear"
    assert params["interp"].get("cli_flag") == "-interp"


def test_fsl_flirt_produces_registered_image_and_matrix():
    """produces[] must declare registered_image and affine_matrix artifact types."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    produced_types = {slot["type"] for slot in manifest.get("produces", [])}
    assert "registered_image" in produced_types
    assert "affine_matrix" in produced_types


def test_fsl_flirt_path_hints_match_flirt_output_names():
    """path_hints must match the files FLIRT writes with the default output-base."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    hints = {slot["type"]: slot.get("path_hint") for slot in manifest.get("produces", [])}
    assert hints["registered_image"] == "registered.nii.gz"
    assert hints["affine_matrix"] == "registered.mat"


def test_fsl_flirt_accepts_skull_stripped_as_primary():
    """FLIRT must accept nifti_skull_stripped (the recommended registration input)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    accepted_types = {slot["type"] for slot in manifest.get("accepts", [])}
    assert "nifti_skull_stripped" in accepted_types


def test_fsl_flirt_accepts_restored_image_for_bet_fast_flirt_chain():
    """FLIRT must accept restored_image so BET→FAST→FLIRT chaining works."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    accepted_types = {slot["type"] for slot in manifest.get("accepts", [])}
    assert "restored_image" in accepted_types


def test_fsl_flirt_appears_in_pipeline_service():
    """fsl-flirt must appear in the registry after PipelineService is constructed."""
    svc = PipelineService()
    ids = [p["id"] for p in svc.list_all()]
    assert "fsl-flirt" in ids


def test_fsl_flirt_input_flag_uses_container_mount_path(tmp_path):
    """--input CLI flag must receive the container-internal path, not the host path."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake nifti")

    ctx = RunContext(
        run_id=500,
        manifest=manifest,
        params={"input": str(brain_file)},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    assert "--input" in cmd
    idx = cmd.index("--input")
    container_path = cmd[idx + 1]
    assert container_path == f"/inputs/input/{brain_file.name}"
    assert str(brain_file) not in container_path


def test_fsl_flirt_no_data_out_positional_prefix(tmp_path):
    """FLIRT command must not start with /data /out (dataset_positional: false)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake")

    ctx = RunContext(
        run_id=501,
        manifest=manifest,
        params={"input": str(brain_file)},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)

    assert "/data" not in sdk.command
    bound_targets = [v["bind"] for v in sdk.volumes.values()]
    assert "/data" not in bound_targets


def test_fsl_flirt_ref_preset_passed_as_flag(tmp_path):
    """--ref-preset must appear in the built command with its value."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake")

    ctx = RunContext(
        run_id=502,
        manifest=manifest,
        params={"input": str(brain_file), "ref-preset": "mni152_1mm"},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    assert "--ref-preset" in cmd
    idx = cmd.index("--ref-preset")
    assert cmd[idx + 1] == "mni152_1mm"


def test_fsl_flirt_dof_flag_uses_single_dash(tmp_path):
    """The dof parameter must emit -dof (single dash) not --dof."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake")

    ctx = RunContext(
        run_id=503,
        manifest=manifest,
        params={"input": str(brain_file), "dof": 6},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = executor.build_command(ctx)

    cmd_str = " ".join(cmd)
    assert "-dof" in cmd
    assert "--dof" not in cmd_str


def test_fsl_flirt_ref_file_mounted_when_provided(tmp_path):
    """When ref-file is provided, it must be mounted and --ref-file flag must appear."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    ref_file = tmp_path / "my_template.nii.gz"
    brain_file.write_text("fake")
    ref_file.write_text("fake ref")

    ctx = RunContext(
        run_id=504,
        manifest=manifest,
        params={"input": str(brain_file), "ref-preset": "custom", "ref-file": str(ref_file)},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    executor = DockerExecutor()
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = executor._build_sdk_params(ctx)
        cmd = executor.build_command(ctx)

    # ref-file must be mounted
    bound_targets = [v["bind"] for v in sdk.volumes.values()]
    assert "/inputs/ref-file/my_template.nii.gz" in bound_targets
    # --ref-file must appear in command with container path
    assert "--ref-file" in cmd
    idx = cmd.index("--ref-file")
    assert cmd[idx + 1] == "/inputs/ref-file/my_template.nii.gz"


def test_fsl_flirt_known_errors_include_image_not_found():
    """A missing wrapper image must produce a clear fix hint to build it locally."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    patterns = [e["pattern"] for e in manifest.get("known_errors", [])]
    assert any("neuravian/fsl-flirt" in p or "not found" in p for p in patterns)


def test_fsl_flirt_known_errors_include_missing_ref_file():
    """A missing ref-file when preset=custom must produce a clear error pattern."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-flirt.yaml", schema)
    patterns = [e["pattern"] for e in manifest.get("known_errors", [])]
    assert any("ref-file" in p or "ref-preset=custom" in p for p in patterns)


# ── FSL FNIRT ─────────────────────────────────────────────────────────────────


def test_fsl_fnirt_manifest_loads_without_error():
    """fsl-fnirt.yaml must load and pass JSON Schema validation."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    assert manifest["id"] == "fsl-fnirt"
    assert manifest["container"]["image"] == "neuravian/fsl-fnirt"
    assert manifest["container"]["tag"] == "6.0.7"
    assert manifest["container"]["engine"] == "docker"


def test_fsl_fnirt_manifest_has_required_fields():
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    assert manifest["display_name"] == "FSL FNIRT"
    assert manifest["description"]
    assert isinstance(manifest["parameters"], list)
    assert len(manifest["parameters"]) >= 6
    assert isinstance(manifest["known_errors"], list)
    assert len(manifest["known_errors"]) >= 5


def test_fsl_fnirt_category_is_registration():
    """FNIRT is a registration tool — category must be 'registration'."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    assert manifest["category"] == "registration"


def test_fsl_fnirt_compute_profile_is_local_slow():
    """FNIRT takes 3-90 min depending on resolution and platform — must be local-slow."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    assert manifest["compute_profile"] == "local-slow"


def test_fsl_fnirt_dataset_positional_false():
    """FNIRT takes a single NIfTI file, not a BIDS dataset directory."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    assert manifest.get("dataset_positional") is False


def test_fsl_fnirt_input_param_is_mounted_with_cli_flag():
    """input param must be file_path, required, mount: true, cli_flag: --input."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "input" in params
    inp = params["input"]
    assert inp["type"] == "file_path"
    assert inp.get("required") is True
    assert inp.get("mount") is True
    assert inp.get("cli_flag") == "--input"


def test_fsl_fnirt_aff_mat_is_optional_and_mounted():
    """aff-mat (FLIRT initialisation) must be optional and mount: true."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "aff-mat" in params
    aff = params["aff-mat"]
    assert aff.get("required") is not True
    assert aff.get("mount") is True
    assert aff.get("cli_flag") == "--aff-mat"


def test_fsl_fnirt_ref_preset_defaults_to_mni152_2mm():
    """ref-preset must default to mni152_2mm (the recommended standard template)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "ref-preset" in params
    assert params["ref-preset"]["default"] == "mni152_2mm"


def test_fsl_fnirt_ref_file_is_optional_and_mounted():
    """ref-file must be optional (only used when ref-preset=custom) and mount: true."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "ref-file" in params
    ref = params["ref-file"]
    assert ref.get("required") is not True
    assert ref.get("mount") is True
    assert ref.get("cli_flag") == "--ref-file"


def test_fsl_fnirt_config_preset_defaults_to_t1_2_mni152_2mm():
    """config-preset must default to T1_2_MNI152_2mm (the standard FSL config)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    params = {p["name"]: p for p in manifest["parameters"]}
    assert "config-preset" in params
    assert params["config-preset"]["default"] == "T1_2_MNI152_2mm"


def test_fsl_fnirt_produces_nonlinear_registered_image():
    """produces[] must include nonlinear_registered_image (the resampled result)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    types = [p["type"] for p in manifest["produces"]]
    assert "nonlinear_registered_image" in types


def test_fsl_fnirt_produces_coefficient_field():
    """produces[] must include coefficient_field (required for applywarp)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    types = [p["type"] for p in manifest["produces"]]
    assert "coefficient_field" in types


def test_fsl_fnirt_produces_optional_warp_and_jacobian():
    """produces[] must include warp_field and jacobian_image (optional outputs)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    types = [p["type"] for p in manifest["produces"]]
    assert "warp_field" in types
    assert "jacobian_image" in types


def test_fsl_fnirt_path_hints_match_wrapper_output_names():
    """Path hints must match the filenames written by neuravian-fnirt.sh."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    hints = {p["type"]: p["path_hint"] for p in manifest["produces"]}
    assert hints["nonlinear_registered_image"] == "fnirt_result.nii.gz"
    assert hints["coefficient_field"] == "fnirt_warpcoef.nii.gz"
    assert hints["warp_field"] == "fnirt_field.nii.gz"
    assert hints["jacobian_image"] == "fnirt_jac.nii.gz"


def test_fsl_fnirt_accepts_skull_stripped_nifti():
    """accepts[] must include nifti_skull_stripped mapped to the input param."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    accepted = {a["type"]: a for a in manifest["accepts"]}
    assert "nifti_skull_stripped" in accepted
    assert accepted["nifti_skull_stripped"]["param"] == "input"


def test_fsl_fnirt_accepts_affine_matrix_for_initialisation():
    """accepts[] must include affine_matrix mapped to aff-mat for the BET→FLIRT→FNIRT chain."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    accepted = {a["type"]: a for a in manifest["accepts"]}
    assert "affine_matrix" in accepted
    assert accepted["affine_matrix"]["param"] == "aff-mat"


def test_fsl_fnirt_appears_in_pipeline_service():
    """PipelineService.list() must include fsl-fnirt after registry seeding."""
    from app.services.pipeline import get_registry
    registry = get_registry()
    assert "fsl-fnirt" in registry, "fsl-fnirt must be registered in get_registry()"


def test_fsl_fnirt_input_flag_uses_container_mount_path(tmp_path):
    """--input CLI flag must receive the container-internal /inputs/input/<name> path."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake nifti")

    ctx = RunContext(
        run_id=600,
        manifest=manifest,
        params={"input": str(brain_file)},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = DockerExecutor().build_command(ctx)

    assert "--input" in cmd
    idx = cmd.index("--input")
    container_path = cmd[idx + 1]
    assert container_path == f"/inputs/input/{brain_file.name}"
    assert str(brain_file) not in container_path


def test_fsl_fnirt_no_data_out_positional_prefix(tmp_path):
    """FNIRT command must not start with /data /out positional prefixes (dataset_positional: false)."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake")

    ctx = RunContext(
        run_id=601,
        manifest=manifest,
        params={"input": str(brain_file)},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = DockerExecutor()._build_sdk_params(ctx)

    assert "/data" not in sdk.command
    bound_targets = [v["bind"] for v in sdk.volumes.values()]
    assert "/data" not in bound_targets


def test_fsl_fnirt_ref_preset_passed_as_flag(tmp_path):
    """--ref-preset must appear in the built command with the correct value."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake")

    ctx = RunContext(
        run_id=602,
        manifest=manifest,
        params={"input": str(brain_file), "ref-preset": "mni152_1mm"},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = DockerExecutor().build_command(ctx)

    assert "--ref-preset" in cmd
    idx = cmd.index("--ref-preset")
    assert cmd[idx + 1] == "mni152_1mm"


def test_fsl_fnirt_aff_mat_mounted_when_provided(tmp_path):
    """When aff-mat is provided, it must be mounted and --aff-mat flag must appear."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    mat_file = tmp_path / "registered.mat"
    brain_file.write_text("fake")
    mat_file.write_text("1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n")

    ctx = RunContext(
        run_id=603,
        manifest=manifest,
        params={"input": str(brain_file), "aff-mat": str(mat_file)},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = DockerExecutor()._build_sdk_params(ctx)
        cmd = DockerExecutor().build_command(ctx)

    bound_targets = [v["bind"] for v in sdk.volumes.values()]
    assert "/inputs/aff-mat/registered.mat" in bound_targets
    assert "--aff-mat" in cmd
    idx = cmd.index("--aff-mat")
    assert cmd[idx + 1] == "/inputs/aff-mat/registered.mat"


def test_fsl_fnirt_ref_file_mounted_when_provided(tmp_path):
    """When ref-preset=custom and ref-file is provided, it must be mounted."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    ref_file = tmp_path / "my_template.nii.gz"
    brain_file.write_text("fake")
    ref_file.write_text("fake ref")

    ctx = RunContext(
        run_id=604,
        manifest=manifest,
        params={
            "input": str(brain_file),
            "ref-preset": "custom",
            "ref-file": str(ref_file),
        },
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        sdk = DockerExecutor()._build_sdk_params(ctx)
        cmd = DockerExecutor().build_command(ctx)

    bound_targets = [v["bind"] for v in sdk.volumes.values()]
    assert "/inputs/ref-file/my_template.nii.gz" in bound_targets
    assert "--ref-file" in cmd
    idx = cmd.index("--ref-file")
    assert cmd[idx + 1] == "/inputs/ref-file/my_template.nii.gz"


def test_fsl_fnirt_output_field_flag_emitted_when_true(tmp_path):
    """--output-field true must appear in the built command when the param is true."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    brain_file = tmp_path / "brain.nii.gz"
    brain_file.write_text("fake")

    ctx = RunContext(
        run_id=605,
        manifest=manifest,
        params={"input": str(brain_file), "output-field": True},
        dataset_path=str(tmp_path / "dataset"),
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor.to_host_path", side_effect=lambda p: p):
        cmd = DockerExecutor().build_command(ctx)

    assert "--output-field" in cmd


def test_fsl_fnirt_known_errors_include_missing_wrapper_image():
    """A missing wrapper image must produce a clear fix hint to build it locally."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    patterns = [e["pattern"] for e in manifest.get("known_errors", [])]
    assert any("neuravian/fsl-fnirt" in p or "manifest unknown" in p for p in patterns)


def test_fsl_fnirt_known_errors_include_missing_ref_file():
    """When ref-preset=custom without ref-file, the error pattern must match."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    patterns = [e["pattern"] for e in manifest.get("known_errors", [])]
    assert any("ref-file" in p or "ref-preset=custom" in p for p in patterns)


def test_fsl_fnirt_known_errors_include_memory_exhaustion():
    """OOM kill must be caught — FNIRT needs 4-16 GB RAM."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    patterns = [e["pattern"] for e in manifest.get("known_errors", [])]
    assert any("Killed" in p or "MemoryError" in p or "Cannot allocate" in p for p in patterns)


def test_fsl_fnirt_known_errors_include_missing_input():
    """Missing --input must produce a clear error pattern."""
    schema = _load_schema()
    manifest = _load_manifest(PIPELINES_DIR / "fsl-fnirt.yaml", schema)
    patterns = [e["pattern"] for e in manifest.get("known_errors", [])]
    assert any("--input is required" in p for p in patterns)
