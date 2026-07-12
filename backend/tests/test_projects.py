"""Tests for the Projects API — CRUD, dataset assignment, notes, stats, timeline, search, manuscript."""

import json
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.dataset import Dataset
from app.models.pipeline import Pipeline
from app.models.project import Project, ProjectNote
from app.models.run import Run


# ── In-memory test DB ─────────────────────────────────────────────────────────

@pytest.fixture(scope="function")
def db_engine():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture(scope="function")
def db_session(db_engine):
    Session = sessionmaker(bind=db_engine)
    session = Session()
    yield session
    session.close()


@pytest.fixture(scope="function")
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def project(client) -> dict:
    res = client.post("/api/projects", json={"title": "Test Project", "institution": "MIT", "pi_name": "Dr. Smith"})
    assert res.status_code == 201
    return res.json()


@pytest.fixture
def dataset(db_session) -> Dataset:
    ds = Dataset(name="Test Dataset", path="/tmp/test_bids", validation_status="valid")
    db_session.add(ds)
    db_session.commit()
    db_session.refresh(ds)
    return ds


@pytest.fixture
def pipeline_row(db_session) -> Pipeline:
    p = Pipeline(name="mriqc", version="24.0.0")
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    return p


# ── CRUD ──────────────────────────────────────────────────────────────────────

class TestProjectCRUD:
    def test_create_project(self, client):
        res = client.post("/api/projects", json={
            "title": "fMRI Connectivity Study",
            "institution": "Harvard",
            "lab": "NeuroCog Lab",
            "pi_name": "Dr. Jones",
            "collaborators": ["Alice", "Bob"],
            "tags": ["fMRI", "connectivity"],
            "status": "active",
        })
        assert res.status_code == 201
        data = res.json()
        assert data["title"] == "fMRI Connectivity Study"
        assert data["institution"] == "Harvard"
        assert data["collaborators"] == ["Alice", "Bob"]
        assert data["tags"] == ["fMRI", "connectivity"]
        assert data["status"] == "active"
        assert data["dataset_count"] == 0
        assert "id" in data

    def test_list_projects_empty(self, client):
        res = client.get("/api/projects")
        assert res.status_code == 200
        assert res.json() == []

    def test_list_projects(self, client, project):
        res = client.get("/api/projects")
        assert res.status_code == 200
        assert len(res.json()) == 1
        assert res.json()[0]["title"] == "Test Project"

    def test_get_project(self, client, project):
        res = client.get(f"/api/projects/{project['id']}")
        assert res.status_code == 200
        assert res.json()["title"] == "Test Project"
        assert res.json()["pi_name"] == "Dr. Smith"

    def test_get_project_not_found(self, client):
        res = client.get("/api/projects/9999")
        assert res.status_code == 404

    def test_update_project(self, client, project):
        res = client.patch(f"/api/projects/{project['id']}", json={"title": "Updated Title", "status": "completed"})
        assert res.status_code == 200
        assert res.json()["title"] == "Updated Title"
        assert res.json()["status"] == "completed"

    def test_delete_project(self, client, project):
        res = client.delete(f"/api/projects/{project['id']}")
        assert res.status_code == 204
        res2 = client.get(f"/api/projects/{project['id']}")
        assert res2.status_code == 404

    def test_delete_project_unassigns_datasets(self, client, project, dataset, db_session):
        client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        client.delete(f"/api/projects/{project['id']}")
        db_session.refresh(dataset)
        assert dataset.project_id is None


# ── Dataset assignment ────────────────────────────────────────────────────────

class TestDatasetAssignment:
    def test_assign_dataset(self, client, project, dataset):
        res = client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        assert res.status_code == 204

    def test_list_project_datasets(self, client, project, dataset):
        client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        res = client.get(f"/api/projects/{project['id']}/datasets")
        assert res.status_code == 200
        assert len(res.json()) == 1
        assert res.json()[0]["id"] == dataset.id

    def test_unassign_dataset(self, client, project, dataset):
        client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        res = client.delete(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        assert res.status_code == 204
        res2 = client.get(f"/api/projects/{project['id']}/datasets")
        assert res2.json() == []

    def test_dataset_count_in_summary(self, client, project, dataset):
        client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        res = client.get(f"/api/projects/{project['id']}")
        assert res.json()["dataset_count"] == 1


# ── Notes ─────────────────────────────────────────────────────────────────────

class TestProjectNotes:
    def test_create_note(self, client, project):
        res = client.post(f"/api/projects/{project['id']}/notes", json={
            "title": "Preprocessing decisions",
            "content_md": "## Decision\nUsed SynthStrip for skull stripping due to Apple Silicon compatibility.",
        })
        assert res.status_code == 201
        data = res.json()
        assert data["title"] == "Preprocessing decisions"
        assert "SynthStrip" in data["content_md"]
        assert data["project_id"] == project["id"]

    def test_list_notes(self, client, project):
        client.post(f"/api/projects/{project['id']}/notes", json={"title": "Note 1", "content_md": "..."})
        client.post(f"/api/projects/{project['id']}/notes", json={"title": "Note 2", "content_md": "..."})
        res = client.get(f"/api/projects/{project['id']}/notes")
        assert res.status_code == 200
        assert len(res.json()) == 2

    def test_update_note(self, client, project):
        note_res = client.post(f"/api/projects/{project['id']}/notes", json={"title": "Draft", "content_md": "v1"})
        note_id = note_res.json()["id"]
        res = client.patch(f"/api/projects/{project['id']}/notes/{note_id}", json={"content_md": "v2 — updated"})
        assert res.status_code == 200
        assert res.json()["content_md"] == "v2 — updated"

    def test_delete_note(self, client, project):
        note_res = client.post(f"/api/projects/{project['id']}/notes", json={"title": "Temp", "content_md": ""})
        note_id = note_res.json()["id"]
        res = client.delete(f"/api/projects/{project['id']}/notes/{note_id}")
        assert res.status_code == 204
        res2 = client.get(f"/api/projects/{project['id']}/notes")
        assert res2.json() == []

    def test_note_count_in_project_read(self, client, project):
        client.post(f"/api/projects/{project['id']}/notes", json={"title": "A", "content_md": ""})
        client.post(f"/api/projects/{project['id']}/notes", json={"title": "B", "content_md": ""})
        res = client.get(f"/api/projects/{project['id']}")
        assert res.json()["note_count"] == 2


# ── Stats ─────────────────────────────────────────────────────────────────────

class TestProjectStats:
    def test_empty_stats(self, client, project):
        res = client.get(f"/api/projects/{project['id']}/stats")
        assert res.status_code == 200
        data = res.json()
        assert data["dataset_count"] == 0
        assert data["run_count"] == 0
        assert data["note_count"] == 0

    def test_stats_with_dataset(self, client, project, dataset, pipeline_row, db_session):
        client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        run = Run(
            dataset_id=dataset.id,
            pipeline_id=pipeline_row.id,
            pipeline_version="24.0.0",
            status="success",
            created_at=datetime.now(UTC),
        )
        db_session.add(run)
        db_session.commit()

        res = client.get(f"/api/projects/{project['id']}/stats")
        assert res.status_code == 200
        data = res.json()
        assert data["dataset_count"] == 1
        assert data["run_count"] == 1
        assert data["success_run_count"] == 1
        assert "mriqc" in data["pipeline_breakdown"]


# ── Timeline ──────────────────────────────────────────────────────────────────

class TestTimeline:
    def test_timeline_empty(self, client, project):
        res = client.get(f"/api/projects/{project['id']}/timeline")
        assert res.status_code == 200
        assert res.json() == []

    def test_timeline_includes_dataset_import(self, client, project, dataset):
        client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        res = client.get(f"/api/projects/{project['id']}/timeline")
        events = res.json()
        types = [e["event_type"] for e in events]
        assert "dataset_imported" in types

    def test_timeline_includes_notes(self, client, project):
        client.post(f"/api/projects/{project['id']}/notes", json={"title": "My Note", "content_md": ""})
        res = client.get(f"/api/projects/{project['id']}/timeline")
        events = res.json()
        types = [e["event_type"] for e in events]
        assert "note_created" in types

    def test_timeline_sorted_descending(self, client, project, dataset, pipeline_row, db_session):
        client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        client.post(f"/api/projects/{project['id']}/notes", json={"title": "Late note", "content_md": ""})
        res = client.get(f"/api/projects/{project['id']}/timeline")
        events = res.json()
        if len(events) > 1:
            assert events[0]["timestamp"] >= events[-1]["timestamp"]


# ── Search ────────────────────────────────────────────────────────────────────

class TestSearch:
    def test_search_notes(self, client, project):
        client.post(f"/api/projects/{project['id']}/notes", json={
            "title": "Confound regression strategy",
            "content_md": "Used 24 motion parameters.",
        })
        res = client.get(f"/api/projects/{project['id']}/search?q=confound")
        assert res.status_code == 200
        data = res.json()
        assert data["total"] >= 1
        assert len(data["results"]["notes"]) >= 1

    def test_search_datasets(self, client, project, dataset):
        client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        res = client.get(f"/api/projects/{project['id']}/search?q=Test")
        assert res.status_code == 200
        assert len(res.json()["results"]["datasets"]) >= 1

    def test_search_no_results(self, client, project):
        res = client.get(f"/api/projects/{project['id']}/search?q=xyznotfound")
        assert res.status_code == 200
        assert res.json()["total"] == 0


# ── Publication status ────────────────────────────────────────────────────────

class TestPublicationStatus:
    def test_all_incomplete_for_new_project(self, client, project):
        res = client.get(f"/api/projects/{project['id']}/publication-status")
        assert res.status_code == 200
        data = res.json()
        assert data["completion_pct"] == 0
        assert all(not item["done"] for item in data["checklist"])

    def test_dataset_assigned_marks_has_datasets(self, client, project, dataset):
        client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        res = client.get(f"/api/projects/{project['id']}/publication-status")
        checklist = {item["key"]: item for item in res.json()["checklist"]}
        assert checklist["has_datasets"]["done"] is True

    def test_note_marks_notes_added(self, client, project):
        client.post(f"/api/projects/{project['id']}/notes", json={"title": "Method note", "content_md": "..."})
        res = client.get(f"/api/projects/{project['id']}/publication-status")
        checklist = {item["key"]: item for item in res.json()["checklist"]}
        assert checklist["notes_added"]["done"] is True


# ── Manuscript export ─────────────────────────────────────────────────────────

class TestManuscript:
    def test_manuscript_basic(self, client, project):
        res = client.get(f"/api/projects/{project['id']}/manuscript")
        assert res.status_code == 200
        data = res.json()
        assert "content" in data
        assert "filename" in data
        assert "Test Project" in data["content"]
        assert data["filename"].endswith(".md")

    def test_manuscript_includes_notes(self, client, project):
        client.post(f"/api/projects/{project['id']}/notes", json={
            "title": "Atlas selection",
            "content_md": "Used Schaefer 200-parcel atlas.",
        })
        res = client.get(f"/api/projects/{project['id']}/manuscript")
        assert "Atlas selection" in res.json()["content"]
        assert "Schaefer" in res.json()["content"]

    def test_manuscript_includes_methods(self, client, project, dataset, pipeline_row, db_session):
        client.post(f"/api/projects/{project['id']}/datasets/{dataset.id}")
        run = Run(
            dataset_id=dataset.id,
            pipeline_id=pipeline_row.id,
            pipeline_version="24.0.0",
            status="success",
            params_json=json.dumps({"atlas": "schaefer_200"}),
            finished_at=datetime.now(UTC),
            created_at=datetime.now(UTC),
        )
        db_session.add(run)
        db_session.commit()

        res = client.get(f"/api/projects/{project['id']}/manuscript")
        content = res.json()["content"]
        assert "## Methods" in content
        assert "mriqc" in content
