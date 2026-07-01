"""Tests for the pipeline manifest registry and API endpoints."""

import textwrap
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
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
