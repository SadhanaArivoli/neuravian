"""Tests for the run file-serving and results-discovery endpoints.

Security focus: path traversal and cross-run access must be rejected.
Functional focus: results discovery returns correct file lists; missing
output dirs are handled gracefully for both success and failed runs.
"""

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from app.models.dataset import Dataset
from app.models.pipeline import Pipeline
from app.models.run import Run
from app.services.run import seed_pipeline_registry


# ------------------------------------------------------------------ #
# Fixtures                                                              #
# ------------------------------------------------------------------ #

@pytest.fixture()
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)


@pytest.fixture()
def api_client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    seed_pipeline_registry(db_session)
    with patch("app.services.run.seed_pipeline_registry"):
        with TestClient(app) as client:
            yield client
    app.dependency_overrides.clear()


@pytest.fixture()
def run_with_output(db_session, tmp_path):
    """A completed run with real output files in a temp directory."""
    dataset = Dataset(path="/data/ds001", validation_status="valid")
    db_session.add(dataset)
    db_session.flush()

    pipeline = db_session.query(Pipeline).filter_by(name="mriqc").first()

    output_dir = tmp_path / "derivatives" / "mriqc" / "1"
    output_dir.mkdir(parents=True)

    # Realistic MRIQC output structure
    html_report = output_dir / "sub-01_T1w.html"
    html_report.write_text("<html><body>MRIQC report</body></html>")

    iqm_dir = output_dir / "sub-01" / "anat"
    iqm_dir.mkdir(parents=True)
    iqm_json = iqm_dir / "sub-01_T1w.json"
    iqm_json.write_text(json.dumps({"snr_total": 4.73, "cnr": 1.69, "cjv": 0.59}))

    run = Run(
        dataset_id=dataset.id,
        pipeline_id=pipeline.id,
        pipeline_version="24.0.2",
        status="success",
        output_dir=str(output_dir),
    )
    db_session.add(run)
    db_session.commit()
    db_session.refresh(run)
    return run, output_dir


@pytest.fixture()
def run_without_output(db_session, tmp_path):
    """A failed run — output dir exists but is empty (pipeline died early)."""
    dataset = Dataset(path="/data/ds001", validation_status="valid")
    db_session.add(dataset)
    db_session.flush()

    pipeline = db_session.query(Pipeline).filter_by(name="mriqc").first()
    output_dir = tmp_path / "derivatives" / "mriqc" / "2"
    output_dir.mkdir(parents=True)

    run = Run(
        dataset_id=dataset.id,
        pipeline_id=pipeline.id,
        pipeline_version="24.0.2",
        status="failed",
        output_dir=str(output_dir),
        error_message="Container exited with code 1.",
    )
    db_session.add(run)
    db_session.commit()
    db_session.refresh(run)
    return run, output_dir


# ------------------------------------------------------------------ #
# /runs/{id}/results                                                    #
# ------------------------------------------------------------------ #

def test_results_returns_html_and_json(api_client, run_with_output):
    run, _ = run_with_output
    resp = api_client.get(f"/api/runs/{run.id}/results")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["reports"]) == 1
    assert body["reports"][0]["path"] == "sub-01_T1w.html"
    assert len(body["metrics"]) == 1
    assert body["metrics"][0]["path"] == "sub-01/anat/sub-01_T1w.json"


def test_results_empty_for_failed_run_no_files(api_client, run_without_output):
    run, _ = run_without_output
    resp = api_client.get(f"/api/runs/{run.id}/results")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reports"] == []
    assert body["metrics"] == []


def test_results_404_unknown_run(api_client):
    resp = api_client.get("/api/runs/9999/results")
    assert resp.status_code == 404


# ------------------------------------------------------------------ #
# /runs/{id}/files/{path} — happy path                                 #
# ------------------------------------------------------------------ #

def test_serve_html_report(api_client, run_with_output):
    run, _ = run_with_output
    resp = api_client.get(f"/api/runs/{run.id}/files/sub-01_T1w.html")
    assert resp.status_code == 200
    assert b"MRIQC report" in resp.content


def test_serve_iqm_json(api_client, run_with_output):
    run, _ = run_with_output
    resp = api_client.get(f"/api/runs/{run.id}/files/sub-01/anat/sub-01_T1w.json")
    assert resp.status_code == 200
    data = resp.json()
    assert data["snr_total"] == pytest.approx(4.73)


def test_serve_missing_file_returns_404(api_client, run_with_output):
    run, _ = run_with_output
    resp = api_client.get(f"/api/runs/{run.id}/files/does_not_exist.html")
    assert resp.status_code == 404


def test_serve_unknown_run_returns_404(api_client):
    resp = api_client.get("/api/runs/9999/files/sub-01_T1w.html")
    assert resp.status_code == 404


# ------------------------------------------------------------------ #
# Security: path traversal and cross-run access                        #
# ------------------------------------------------------------------ #

def test_path_traversal_rejected(api_client, run_with_output):
    """../../etc/passwd and similar attempts must return 403, not 200."""
    run, _ = run_with_output
    traversal_attempts = [
        "../../etc/passwd",
        "../secret.txt",
        "sub-01/../../other_run/secret.html",
    ]
    for attempt in traversal_attempts:
        resp = api_client.get(f"/api/runs/{run.id}/files/{attempt}")
        assert resp.status_code in (403, 404), (
            f"Expected 403/404 for traversal attempt {attempt!r}, got {resp.status_code}"
        )


def test_cross_run_access_rejected(api_client, run_with_output, db_session, tmp_path):
    """A request scoped to run A cannot read files from run B's output dir."""
    run_a, output_a = run_with_output

    # Create run B with a secret file
    dataset = db_session.query(Dataset).first()
    pipeline = db_session.query(Pipeline).filter_by(name="mriqc").first()
    output_b = tmp_path / "derivatives" / "mriqc" / "run_b"
    output_b.mkdir(parents=True)
    secret = output_b / "secret.txt"
    secret.write_text("run B secret")

    run_b = Run(
        dataset_id=dataset.id,
        pipeline_id=pipeline.id,
        pipeline_version="24.0.2",
        status="success",
        output_dir=str(output_b),
    )
    db_session.add(run_b)
    db_session.commit()
    db_session.refresh(run_b)

    # Try to read run B's secret via run A's file endpoint
    # Construct a relative path that escapes run A's output_dir into run B's
    relative_escape = f"../{output_b.name}/secret.txt"
    resp = api_client.get(f"/api/runs/{run_a.id}/files/{relative_escape}")
    assert resp.status_code in (403, 404), (
        f"Cross-run access should be rejected, got {resp.status_code}"
    )
