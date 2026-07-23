import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["service"] == "neuravian-backend"


def test_about_exposes_release_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    commit = "0123456789abcdef0123456789abcdef01234567"
    monkeypatch.setenv("NEURAVIAN_GIT_COMMIT", commit)
    monkeypatch.setenv("NEURAVIAN_RELEASE_VERSION", "0.1.0")
    response = client.get("/api/about")
    assert response.status_code == 200
    data = response.json()
    assert data["git_commit"] == commit
    assert data["release_version"] == "0.1.0"
    assert data["backend_version"] == "0.1.0"
