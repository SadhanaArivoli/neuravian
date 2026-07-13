"""
Tests for the datasets API and DatasetService.

Fixtures are tiny real BIDS directories so we exercise the actual validators
without needing neuroimaging data. bids-validator and pybids run on these
small trees in well under a second.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.main import app
from unittest.mock import patch, MagicMock

from app.services.bids_patterns import (
    check_entity_order,
    check_missing_dataset_description,
    check_missing_participants_tsv,
    check_nifti_without_sidecar,
    check_subject_label_mismatch,
)
from app.services.dataset import DatasetService, _translate_host_path

FIXTURES = Path(__file__).parent / "fixtures"
VALID_BIDS = FIXTURES / "valid_bids"
INVALID_BIDS = FIXTURES / "invalid_bids"


# ------------------------------------------------------------------ #
# Shared DB fixture — in-memory SQLite, fresh per test               #
# ------------------------------------------------------------------ #


@pytest.fixture()
def db_session():
    # StaticPool keeps the same connection across threads so the TestClient's
    # worker thread sees the same in-memory DB that create_all populated.
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
    # Patch the lifespan's seed call so it doesn't try to hit the real DB.
    with patch("app.services.run.seed_pipeline_registry"):
        with TestClient(app) as client:
            yield client
    app.dependency_overrides.clear()


# ------------------------------------------------------------------ #
# _translate_host_path unit tests                                     #
# ------------------------------------------------------------------ #


def test_translate_host_path_rewrites_mac_path():
    """The exact real-world case: paste a Mac path, get a /host-data path."""
    with patch("app.services.dataset.settings") as mock_settings:
        mock_settings.host_datasets_mount = "/Users/testuser/Documents"
        result = _translate_host_path(
            Path("/Users/testuser/Documents/bids-examples/ds001")
        )
    assert result == Path("/host-data/bids-examples/ds001")


def test_translate_host_path_leaves_container_path_unchanged():
    """A path already inside /host-data should pass through unchanged."""
    with patch("app.services.dataset.settings") as mock_settings:
        mock_settings.host_datasets_mount = "/Users/testuser/Documents"
        result = _translate_host_path(Path("/host-data/bids-examples/ds001"))
    # /host-data doesn't start with the host mount prefix, so no rewrite
    assert result == Path("/host-data/bids-examples/ds001")


def test_translate_host_path_no_op_when_mount_unset():
    """Without a mount configured the path is returned unchanged."""
    with patch("app.services.dataset.settings") as mock_settings:
        mock_settings.host_datasets_mount = None
        result = _translate_host_path(Path("/Users/alice/Documents/my-study"))
    assert result == Path("/Users/alice/Documents/my-study")


def test_translate_host_path_no_op_when_outside_mount():
    """A path that doesn't start with the mount prefix is returned unchanged."""
    with patch("app.services.dataset.settings") as mock_settings:
        mock_settings.host_datasets_mount = "/Users/alice/Documents"
        result = _translate_host_path(Path("/Volumes/ExternalDrive/my-study"))
    assert result == Path("/Volumes/ExternalDrive/my-study")


# ------------------------------------------------------------------ #
# Pattern-matcher unit tests                                          #
# ------------------------------------------------------------------ #


def test_check_missing_dataset_description_present(tmp_path):
    (tmp_path / "dataset_description.json").write_text("{}")
    assert check_missing_dataset_description(tmp_path) == []


def test_check_missing_dataset_description_absent(tmp_path):
    issues = check_missing_dataset_description(tmp_path)
    assert len(issues) == 1
    assert issues[0]["code"] == "MISSING_DATASET_DESCRIPTION"


def test_check_missing_participants_tsv_present(tmp_path):
    (tmp_path / "participants.tsv").write_text("participant_id\nsub-01\n")
    assert check_missing_participants_tsv(tmp_path) == []


def test_check_missing_participants_tsv_absent(tmp_path):
    issues = check_missing_participants_tsv(tmp_path)
    assert len(issues) == 1
    assert issues[0]["code"] == "MISSING_PARTICIPANTS_TSV"


def test_check_nifti_without_sidecar_finds_missing(tmp_path):
    sub = tmp_path / "sub-01" / "anat"
    sub.mkdir(parents=True)
    (sub / "sub-01_T1w.nii.gz").write_bytes(b"")
    # no json sidecar
    issues = check_nifti_without_sidecar(tmp_path)
    assert len(issues) == 1
    assert issues[0]["code"] == "MISSING_JSON_SIDECAR"


def test_check_nifti_without_sidecar_ok_when_present(tmp_path):
    sub = tmp_path / "sub-01" / "anat"
    sub.mkdir(parents=True)
    (sub / "sub-01_T1w.nii.gz").write_bytes(b"")
    (sub / "sub-01_T1w.json").write_text("{}")
    assert check_nifti_without_sidecar(tmp_path) == []


def test_check_subject_label_mismatch_catches_unlisted(tmp_path):
    (tmp_path / "participants.tsv").write_text("participant_id\nsub-01\n")
    (tmp_path / "sub-02").mkdir()  # sub-02 not in participants.tsv
    issues = check_subject_label_mismatch(tmp_path)
    assert len(issues) == 1
    assert issues[0]["code"] == "SUBJECT_NOT_IN_PARTICIPANTS_TSV"
    assert "sub-02" in issues[0]["files"]


def test_check_subject_label_mismatch_ok_when_listed(tmp_path):
    (tmp_path / "participants.tsv").write_text("participant_id\nsub-01\n")
    (tmp_path / "sub-01").mkdir()
    assert check_subject_label_mismatch(tmp_path) == []


def test_check_entity_order_bad(tmp_path):
    sub = tmp_path / "sub-01" / "func"
    sub.mkdir(parents=True)
    # run before task — wrong order
    (sub / "sub-01_run-1_task-rest_bold.nii.gz").write_bytes(b"")
    issues = check_entity_order(tmp_path)
    assert len(issues) == 1
    assert issues[0]["code"] == "WRONG_ENTITY_ORDER"


def test_check_entity_order_ok(tmp_path):
    sub = tmp_path / "sub-01" / "func"
    sub.mkdir(parents=True)
    # task before run — correct order
    (sub / "sub-01_task-rest_run-1_bold.nii.gz").write_bytes(b"")
    assert check_entity_order(tmp_path) == []


# ------------------------------------------------------------------ #
# DatasetService integration tests (real fixtures, real validators)   #
# ------------------------------------------------------------------ #


def test_register_valid_bids_dataset(db_session):
    svc = DatasetService(db_session)
    result = svc.register_path(str(VALID_BIDS))
    assert result.validation_status in ("valid", "warning")
    assert result.indexed_metadata is not None
    assert "01" in result.indexed_metadata.subjects


def test_register_invalid_bids_dataset(db_session):
    svc = DatasetService(db_session)
    result = svc.register_path(str(INVALID_BIDS))
    # Missing dataset_description.json → should be invalid
    assert result.validation_status == "invalid"
    assert result.validation_issues is not None
    codes = [e.code for e in result.validation_issues.errors]
    assert "MISSING_DATASET_DESCRIPTION" in codes


def test_register_nonexistent_path_raises(db_session):
    svc = DatasetService(db_session)
    with pytest.raises(FileNotFoundError):
        svc.register_path("/nonexistent/path/to/nowhere")


def test_register_duplicate_raises(db_session):
    svc = DatasetService(db_session)
    svc.register_path(str(VALID_BIDS))
    with pytest.raises(ValueError, match="already registered"):
        svc.register_path(str(VALID_BIDS))


# ------------------------------------------------------------------ #
# API endpoint tests                                                   #
# ------------------------------------------------------------------ #


def test_post_datasets_valid(api_client):
    resp = api_client.post("/api/datasets", json={"path": str(VALID_BIDS)})
    assert resp.status_code == 201
    data = resp.json()
    assert data["validation_status"] in ("valid", "warning")
    assert data["id"] is not None


def test_post_datasets_nonexistent_path(api_client):
    resp = api_client.post("/api/datasets", json={"path": "/not/real"})
    assert resp.status_code == 422


def test_post_datasets_duplicate(api_client):
    api_client.post("/api/datasets", json={"path": str(VALID_BIDS)})
    resp = api_client.post("/api/datasets", json={"path": str(VALID_BIDS)})
    assert resp.status_code == 409


def test_get_datasets_list(api_client):
    api_client.post("/api/datasets", json={"path": str(VALID_BIDS)})
    resp = api_client.get("/api/datasets")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


def test_get_dataset_by_id(api_client):
    create = api_client.post("/api/datasets", json={"path": str(VALID_BIDS)})
    dataset_id = create.json()["id"]
    resp = api_client.get(f"/api/datasets/{dataset_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == dataset_id


def test_get_dataset_not_found(api_client):
    resp = api_client.get("/api/datasets/999")
    assert resp.status_code == 404
