import hashlib
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app


@pytest.fixture
def client():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    app.dependency_overrides[get_db] = lambda: session
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    session.close()


def workflow(client: TestClient) -> dict:
    response = client.post("/api/workflows", json={
        "name": "Mixed execution", "state": {
            "schema_version": "neuroforge-workflow-v1",
            "source": {"kind": "dataset", "datasetId": 1, "runId": ""},
            "nodes": [], "activeTemplateId": None,
        },
    })
    assert response.status_code == 201
    return response.json()


def start(client: TestClient, workflow_id: int, key: str = "request-1") -> dict:
    response = client.post(f"/api/workflows/{workflow_id}/executions", json={
        "idempotency_key": key,
        "state": {"nodes": [{"id": "local", "status": "pending"}]},
    })
    assert response.status_code == 201
    return response.json()


def test_duplicate_handoff_request_returns_same_execution(client):
    saved = workflow(client)
    first = start(client, saved["id"])
    second = start(client, saved["id"])
    assert first["execution_uuid"] == second["execution_uuid"]
    assert first["id"] == second["id"]


def test_execution_survives_new_client_request(client):
    saved = workflow(client)
    execution = start(client, saved["id"])
    recovered = client.get(f"/api/workflow-executions/{execution['execution_uuid']}")
    assert recovered.status_code == 200
    assert recovered.json()["state"] == execution["state"]


def test_optimistic_revision_prevents_duplicate_progress(client):
    execution = start(client, workflow(client)["id"])
    body = {
        "expected_revision": 1, "status": "running-local", "current_node_id": "local",
        "state": {"nodes": [{"id": "local", "status": "running"}]},
    }
    assert client.patch(f"/api/workflow-executions/{execution['execution_uuid']}", json=body).status_code == 200
    assert client.patch(f"/api/workflow-executions/{execution['execution_uuid']}", json=body).status_code == 409


def test_cannot_complete_before_return_sync(client):
    execution = start(client, workflow(client)["id"])
    response = client.patch(f"/api/workflow-executions/{execution['execution_uuid']}", json={
        "expected_revision": 1, "status": "complete", "return_sync_complete": False, "state": {},
    })
    assert response.status_code == 409


def test_complete_after_return_sync(client):
    execution = start(client, workflow(client)["id"])
    response = client.patch(f"/api/workflow-executions/{execution['execution_uuid']}", json={
        "expected_revision": 1, "status": "complete", "return_sync_complete": True,
        "state": {"nodes": [{"id": "remote", "status": "success"}]},
    })
    assert response.status_code == 200
    assert response.json()["return_sync_complete"] is True


def test_input_upload_is_checksum_verified_and_idempotent(client, tmp_path, monkeypatch):
    from app.api import workflows

    monkeypatch.setattr(workflows.settings, "data_dir", str(tmp_path))
    execution = start(client, workflow(client)["id"])
    payload = b"required upstream artifact"
    digest = hashlib.sha256(payload).hexdigest()
    url = f"/api/workflow-executions/{execution['execution_uuid']}/inputs/upstream-t1"
    headers = {"X-NeuroForge-Sha256": digest, "X-NeuroForge-Relative-Path": "inputs/sub-01_T1w.nii.gz"}
    first = client.put(url, content=payload, headers=headers)
    second = client.put(url, content=payload, headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["status"] == "complete"


def test_input_upload_rejects_checksum_mismatch(client, tmp_path, monkeypatch):
    from app.api import workflows

    monkeypatch.setattr(workflows.settings, "data_dir", str(tmp_path))
    execution = start(client, workflow(client)["id"])
    response = client.put(
        f"/api/workflow-executions/{execution['execution_uuid']}/inputs/input",
        content=b"data",
        headers={"X-NeuroForge-Sha256": "0" * 64, "X-NeuroForge-Relative-Path": "input.nii.gz"},
    )
    assert response.status_code == 422


@pytest.mark.parametrize("path", ["../secret", "/etc/passwd"])
def test_input_upload_rejects_unsafe_paths(client, path):
    execution = start(client, workflow(client)["id"])
    payload = b"data"
    response = client.put(
        f"/api/workflow-executions/{execution['execution_uuid']}/inputs/input",
        content=payload,
        headers={
            "X-NeuroForge-Sha256": hashlib.sha256(payload).hexdigest(),
            "X-NeuroForge-Relative-Path": path,
        },
    )
    assert response.status_code == 400


def test_execution_uuid_validation(client):
    saved = workflow(client)
    response = client.post(f"/api/workflows/{saved['id']}/executions", json={
        "idempotency_key": "bad-uuid", "execution_uuid": "not-a-uuid", "state": {},
    })
    assert response.status_code == 400


def test_handoff_manifest_compares_artifacts_in_host_path_space(tmp_path, monkeypatch):
    from app.api import runs

    host_output = tmp_path / "derivatives" / "fsl-bet" / "121"
    host_output.mkdir(parents=True)
    artifact = host_output / "brain.nii.gz"
    artifact.write_bytes(b"nifti")
    container_output = tmp_path / "container" / "derivatives" / "fsl-bet" / "121"
    container_output.mkdir(parents=True)
    container_artifact = container_output / "brain.nii.gz"
    container_artifact.write_bytes(b"nifti")
    monkeypatch.setattr(runs, "to_host_path", lambda value: value.replace(str(tmp_path / "container"), str(tmp_path)))
    monkeypatch.setattr(runs, "get_run_sync_manifest", lambda *_: {
        "artifacts": [{"relativePath": "brain.nii.gz"}],
    })
    monkeypatch.setattr(runs, "get_run_results", lambda *_: {
        "artifacts": [{
            "type": "nifti_skull_stripped", "resolved": True,
            "paths": [str(container_artifact)], "host_paths": [str(artifact)],
        }],
    })
    service = SimpleNamespace(get_by_id=lambda _run_id: SimpleNamespace(
        output_dir=str(container_output),
    ))

    result = runs.get_run_handoff_manifest(121, "nifti_skull_stripped", service)

    assert result["artifacts"] == [{"relativePath": "brain.nii.gz"}]
