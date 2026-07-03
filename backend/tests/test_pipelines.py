"""Tests for the pipeline manifest registry and API endpoints."""

import json
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
from app.execution.docker_executor import DockerExecutor
from app.execution.executor import RunContext
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
    assert manifest["container"]["tag"] == "25.2.5"
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
    assert manifest["max_runtime_hours"] == 12


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
    """POSTing a fmriprep run with a nonexistent license path must return 400."""
    ds = _make_dataset(db_session_for_runs, str(tmp_path))
    resp = fmriprep_api_client.post(
        "/api/runs",
        json={
            "pipeline_id": "fmriprep",
            "dataset_id": ds.id,
            "params": {
                "fs-license-file": "/absolutely/does/not/exist/license.txt",
                "participant-label": "01",
            },
        },
    )
    assert resp.status_code == 400
    assert "not found" in resp.json()["detail"].lower() or \
           "path" in resp.json()["detail"].lower()


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
