import uuid

from fastapi.testclient import TestClient

from app.api import workspace
from app.main import app

client = TestClient(app)


def test_workspace_identity_is_stable_and_opaque(monkeypatch):
    monkeypatch.setattr(workspace, "_server_identity_source", lambda: "machine:private-machine-id")

    first = client.get("/api/workspace/identity")
    second = client.get("/api/workspace/identity")

    assert first.status_code == 200
    assert first.json() == second.json()
    assert uuid.UUID(first.json()["workspace_id"]).version == 5
    assert "private-machine-id" not in first.text
    assert first.json()["product"] == "NeuroForge"


def test_configured_server_identity_does_not_leak(monkeypatch):
    monkeypatch.setenv("NEUROFORGE_SERVER_ID", "lab-secret-identifier")

    response = client.get("/api/workspace/identity")

    assert response.status_code == 200
    assert "lab-secret-identifier" not in response.text
