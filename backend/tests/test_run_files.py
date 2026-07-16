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

    # NIfTI derivative files (as a future fMRIPrep-style run would produce)
    nii_dir = output_dir / "sub-01" / "anat"
    (nii_dir / "sub-01_desc-preproc_T1w.nii.gz").write_bytes(b"\x1f\x8b" + b"\x00" * 10)
    (nii_dir / "sub-01_label-GM_probseg.nii").write_bytes(b"\x00" * 348)

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


# ------------------------------------------------------------------ #
# NIfTI derivative discovery                                            #
# ------------------------------------------------------------------ #

def test_results_includes_niftis(api_client, run_with_output):
    """niftis field lists .nii.gz and .nii files from the output tree."""
    run, _ = run_with_output
    resp = api_client.get(f"/api/runs/{run.id}/results")
    assert resp.status_code == 200
    body = resp.json()
    niftis = body["niftis"]
    assert len(niftis) == 2
    paths = {n["path"] for n in niftis}
    assert "sub-01/anat/sub-01_desc-preproc_T1w.nii.gz" in paths
    assert "sub-01/anat/sub-01_label-GM_probseg.nii" in paths


def test_results_niftis_empty_for_mriqc_style_output(api_client, run_without_output):
    """niftis is [] when the output directory has no .nii/.nii.gz files (e.g. MRIQC)."""
    run, _ = run_without_output
    resp = api_client.get(f"/api/runs/{run.id}/results")
    assert resp.status_code == 200
    body = resp.json()
    assert body["niftis"] == []


def test_results_includes_connectivity_outputs(api_client, db_session, tmp_path):
    dataset = Dataset(path="/data/ds001", validation_status="valid")
    db_session.add(dataset)
    db_session.flush()
    pipeline = db_session.query(Pipeline).filter_by(name="functional-connectivity").first()
    output_dir = tmp_path / "derivatives" / "functional-connectivity" / "1"
    output_dir.mkdir(parents=True)
    (output_dir / "connectivity_report.html").write_text("<html>report</html>")
    (output_dir / "connectivity_matrix.csv").write_text(",A,B\nA,1,0.1\nB,0.1,1\n")
    (output_dir / "connectivity_heatmap.png").write_bytes(b"PNG")
    (output_dir / "connectivity_matrix.npy").write_bytes(b"NUMPY")
    (output_dir / "timeseries.tsv").write_text("A\tB\n0.1\t0.2\n")
    (output_dir / "roi_statistics.csv").write_text("roi_number,roi_label\n1,A\n2,B\n")
    (output_dir / "roi_statistics.json").write_text(json.dumps([{"roi_number": 1, "roi_label": "A"}]))
    (output_dir / "connectivity_metadata.json").write_text(json.dumps({"n_rois": 2}))
    run = Run(
        dataset_id=dataset.id,
        pipeline_id=pipeline.id,
        pipeline_version="0.1.0",
        status="success",
        output_dir=str(output_dir),
    )
    db_session.add(run)
    db_session.commit()

    resp = api_client.get(f"/api/runs/{run.id}/results")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reports"][0]["path"] == "connectivity_report.html"
    assert body["connectivity_matrices"][0]["path"] == "connectivity_matrix.csv"
    assert body["images"][0]["path"] == "connectivity_heatmap.png"
    assert body["timeseries"][0]["path"] == "timeseries.tsv"
    assert body["connectivity_metadata"][0]["path"] == "connectivity_metadata.json"
    assert {item["path"] for item in body["roi_statistics"]} == {
        "roi_statistics.csv",
        "roi_statistics.json",
    }
    artifact_types = {artifact["type"] for artifact in body["artifacts"]}
    assert "roi_statistics_csv" in artifact_types
    assert "roi_statistics_json" in artifact_types


def test_serve_nifti_derivative(api_client, run_with_output):
    """Serving a gzip NIfTI preserves every byte and supports byte ranges."""
    run, output_dir = run_with_output
    expected = (output_dir / "sub-01" / "anat" / "sub-01_desc-preproc_T1w.nii.gz").read_bytes()
    url = f"/api/runs/{run.id}/files/sub-01/anat/sub-01_desc-preproc_T1w.nii.gz"
    resp = api_client.get(
        url
    )
    assert resp.status_code == 200
    assert resp.content == expected
    assert resp.content[:2] == b"\x1f\x8b"

    partial = api_client.get(url, headers={"Range": "bytes=0-3"})
    assert partial.status_code == 206
    assert partial.content == expected[:4]
    assert partial.headers["content-range"] == f"bytes 0-3/{len(expected)}"


def test_path_traversal_via_nifti_path_rejected(api_client, run_with_output):
    """Traversal attempts through a nifti-style path are still rejected."""
    run, _ = run_with_output
    resp = api_client.get(f"/api/runs/{run.id}/files/sub-01/../../etc/passwd")
    assert resp.status_code in (403, 404)


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
