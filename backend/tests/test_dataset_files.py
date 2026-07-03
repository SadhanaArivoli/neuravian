"""Tests for dataset file-serving and scan-discovery endpoints.

Security: path traversal and cross-dataset access must be rejected.
Functional: scan discovery returns correct NIfTI file listing; missing
directories handled gracefully.
"""

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
def bids_dataset(db_session, tmp_path):
    """A minimal BIDS dataset with real NIfTI-like files."""
    root = tmp_path / "ds001"
    root.mkdir()

    # Create a minimal BIDS structure
    anat_dir = root / "sub-01" / "anat"
    anat_dir.mkdir(parents=True)
    t1w = anat_dir / "sub-01_T1w.nii.gz"
    t1w.write_bytes(b"\x1f\x8b" + b"\x00" * 18)  # gzip magic bytes

    func_dir = root / "sub-01" / "func"
    func_dir.mkdir(parents=True)
    bold = func_dir / "sub-01_task-rest_bold.nii"
    bold.write_bytes(b"\x00" * 348)  # NIfTI header minimum

    dataset = Dataset(path=str(root), validation_status="valid")
    db_session.add(dataset)
    db_session.commit()
    db_session.refresh(dataset)
    return dataset, root


@pytest.fixture()
def second_dataset(db_session, tmp_path):
    """A second dataset for cross-dataset access tests."""
    root = tmp_path / "ds002"
    root.mkdir()
    secret = root / "secret.txt"
    secret.write_text("confidential data")

    dataset = Dataset(path=str(root), validation_status="valid")
    db_session.add(dataset)
    db_session.commit()
    db_session.refresh(dataset)
    return dataset, root


# ------------------------------------------------------------------ #
# /datasets/{id}/scans                                                  #
# ------------------------------------------------------------------ #

def test_scans_returns_nifti_files(api_client, bids_dataset):
    dataset, _ = bids_dataset
    resp = api_client.get(f"/api/datasets/{dataset.id}/scans")
    assert resp.status_code == 200
    scans = resp.json()["scans"]
    paths = [s["path"] for s in scans]
    assert "sub-01/anat/sub-01_T1w.nii.gz" in paths
    assert "sub-01/func/sub-01_task-rest_bold.nii" in paths


def test_scans_extracts_bids_components(api_client, bids_dataset):
    dataset, _ = bids_dataset
    resp = api_client.get(f"/api/datasets/{dataset.id}/scans")
    scans = {s["path"]: s for s in resp.json()["scans"]}

    t1w = scans["sub-01/anat/sub-01_T1w.nii.gz"]
    assert t1w["subject"] == "01"
    assert t1w["datatype"] == "anat"
    assert t1w["suffix"] == "T1w"
    assert t1w["session"] is None

    bold = scans["sub-01/func/sub-01_task-rest_bold.nii"]
    assert bold["subject"] == "01"
    assert bold["datatype"] == "func"
    assert bold["suffix"] == "bold"


def test_scans_empty_for_unknown_dataset(api_client):
    resp = api_client.get("/api/datasets/9999/scans")
    assert resp.status_code == 404


def test_scans_ignores_non_nifti_files(api_client, bids_dataset, tmp_path):
    dataset, root = bids_dataset
    # Add a non-NIfTI file that should be ignored
    (root / "sub-01" / "anat" / "sub-01_T1w.json").write_text("{}")
    resp = api_client.get(f"/api/datasets/{dataset.id}/scans")
    paths = [s["path"] for s in resp.json()["scans"]]
    assert not any(p.endswith(".json") for p in paths)


# ------------------------------------------------------------------ #
# /datasets/{id}/files/{path} — happy path                             #
# ------------------------------------------------------------------ #

def test_serve_nii_gz_file(api_client, bids_dataset):
    dataset, _ = bids_dataset
    resp = api_client.get(
        f"/api/datasets/{dataset.id}/files/sub-01/anat/sub-01_T1w.nii.gz"
    )
    assert resp.status_code == 200
    assert resp.content[:2] == b"\x1f\x8b"  # gzip magic bytes intact


def test_serve_nii_file(api_client, bids_dataset):
    dataset, _ = bids_dataset
    resp = api_client.get(
        f"/api/datasets/{dataset.id}/files/sub-01/func/sub-01_task-rest_bold.nii"
    )
    assert resp.status_code == 200


def test_serve_missing_file_returns_404(api_client, bids_dataset):
    dataset, _ = bids_dataset
    resp = api_client.get(f"/api/datasets/{dataset.id}/files/sub-01/anat/nonexistent.nii.gz")
    assert resp.status_code == 404


def test_serve_unknown_dataset_returns_404(api_client):
    resp = api_client.get("/api/datasets/9999/files/sub-01/anat/sub-01_T1w.nii.gz")
    assert resp.status_code == 404


# ------------------------------------------------------------------ #
# Security: path traversal and cross-dataset access                    #
# ------------------------------------------------------------------ #

def test_path_traversal_rejected(api_client, bids_dataset):
    """../../etc/passwd and similar must return 403."""
    dataset, _ = bids_dataset
    attempts = [
        "../../etc/passwd",
        "../secret.txt",
        "sub-01/../../outside.txt",
    ]
    for attempt in attempts:
        resp = api_client.get(f"/api/datasets/{dataset.id}/files/{attempt}")
        assert resp.status_code in (403, 404), (
            f"Expected 403/404 for {attempt!r}, got {resp.status_code}"
        )


def test_encoded_traversal_rejected(api_client, bids_dataset):
    """URL-encoded path traversal must also be rejected at the backend."""
    dataset, _ = bids_dataset
    resp = api_client.get(
        f"/api/datasets/{dataset.id}/files/..%2F..%2Fetc%2Fpasswd"
    )
    assert resp.status_code in (403, 404)


def test_cross_dataset_access_rejected(api_client, bids_dataset, second_dataset):
    """A request scoped to dataset A cannot read files from dataset B."""
    dataset_a, output_a = bids_dataset
    dataset_b, output_b = second_dataset

    # Construct a relative path that would escape dataset_a into dataset_b
    # e.g. ../ds002/secret.txt
    escape = f"../{output_b.name}/secret.txt"
    resp = api_client.get(f"/api/datasets/{dataset_a.id}/files/{escape}")
    assert resp.status_code in (403, 404), (
        f"Cross-dataset access should be rejected, got {resp.status_code}"
    )
