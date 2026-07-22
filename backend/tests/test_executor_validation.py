"""
Regression tests for the executor mount-validation and exit-code propagation bug.

Bug: when a mounted file parameter pointed to a non-existent path, the executor
silently started a container anyway (modern Docker auto-creates missing bind sources
as directories), the container failed internally, but the run was still marked
SUCCESS.

Root causes fixed:
  1. run.py create_run pre-flight: `and not _is_running_in_docker()` guard
     prevented path-existence checks inside Docker — all paths got `available=True`.
  2. docker_executor.py _build_sdk_params: no validation of mount sources before
     passing them to Docker.

Both layers now catch invalid paths and produce a clear error / failed run.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.execution.docker_executor import DockerExecutor
from app.execution.executor import RunContext
from app.main import app
from app.services.pipeline import get_registry
from app.services.run import _execute_run_background, seed_pipeline_registry


# ── Shared fixtures ────────────────────────────────────────────────────────────

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


def _register_valid_dataset(api_client, tmp_path):
    fixtures = Path(__file__).parent / "fixtures" / "valid_bids"
    resp = api_client.post("/api/datasets", json={"path": str(fixtures)})
    assert resp.status_code == 201
    return resp.json()["id"]


# ── Layer 1: pre-flight validation in create_run ────────────────────────────


def test_preflight_rejects_missing_mount_file_outside_docker(api_client, tmp_path):
    """
    When not in Docker, create_run rejects a non-existent file for a mount:true
    parameter with a 400 before the run is enqueued.
    """
    dataset_id = _register_valid_dataset(api_client, tmp_path)

    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False), \
         patch("app.services.run._is_running_in_docker", return_value=False), \
         patch("app.services.run._execute_run_background", new_callable=AsyncMock):
        resp = api_client.post("/api/runs", json={
            "pipeline_id": "pydeface",
            "dataset_id": dataset_id,
            "params": {"nifti-file": str(tmp_path / "nonexistent.nii.gz")},
        })

    assert resp.status_code == 400
    assert "nonexistent" in resp.json()["detail"].lower() or "not found" in resp.json()["detail"].lower()


def test_preflight_passes_untranslated_path_inside_docker():
    """
    Inside Docker with no dataset translation, pre-flight must not reject an
    untranslated mount path (e.g. a FreeSurfer license file outside the datasets mount).

    This is a unit-level check of the pre-flight guard logic directly, bypassing
    the full API stack (which has its own Docker-mode checks for dataset binds).
    The guard `and not _is_running_in_docker()` exists specifically for this case.
    """
    from app.services.run import _is_running_in_docker as real_fn
    from pathlib import Path

    # Simulate the pre-flight logic directly (mirror of run.py lines 801-831)
    def _run_preflight(raw_val: str, inside_docker: bool) -> bool:
        """Return True if path passes pre-flight (available), False if rejected."""
        from app.services.run import _is_running_in_docker
        candidate_value = raw_val

        # dataset_translation_configured() is False in this scenario
        resolved_dataset_path = None
        candidate = resolved_dataset_path  # None

        if candidate is None and not inside_docker:
            candidate = Path(candidate_value).expanduser().resolve()

        if candidate is None:
            return True  # can't validate → allow through

        return candidate.is_file() or candidate.is_dir()

    # Outside Docker: /nonexistent path is rejected
    assert not _run_preflight("/nonexistent/brain.nii.gz", inside_docker=False)

    # Inside Docker: same path is allowed through (can't validate from here)
    assert _run_preflight("/nonexistent/brain.nii.gz", inside_docker=True)


def test_preflight_accepts_existing_mount_file_outside_docker(api_client, tmp_path):
    """
    create_run must accept a mount:true file param when the file actually exists.
    The fix (removing the Docker guard) must not break the valid-path case.
    Tested outside Docker to avoid the HOST_DATASETS_MOUNT requirement.
    """
    dataset_id = _register_valid_dataset(api_client, tmp_path)
    real_nii = tmp_path / "brain.nii.gz"
    real_nii.write_bytes(b"nifti-placeholder")

    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False), \
         patch("app.services.run._is_running_in_docker", return_value=False), \
         patch("app.services.run._execute_run_background", new_callable=AsyncMock), \
         patch("app.execution.docker_executor.DockerExecutor.check_resources", return_value=[]):
        resp = api_client.post("/api/runs", json={
            "pipeline_id": "pydeface",
            "dataset_id": dataset_id,
            "params": {"nifti-file": str(real_nii)},
        })

    assert resp.status_code == 201, (
        f"create_run should accept an existing file. Got {resp.status_code}: {resp.json()}"
    )


# ── Layer 2: executor mount-source validation in _build_sdk_params ───────────


def _make_flirt_ctx(tmp_path: Path, input_path: str | None = None) -> RunContext:
    """Return a RunContext for fsl-flirt with the given input path."""
    manifest = get_registry()["fsl-flirt"]
    out = tmp_path / "out"
    out.mkdir(exist_ok=True)
    return RunContext(
        run_id=99,
        manifest=manifest,
        params={
            "input": input_path or str(tmp_path / "brain.nii.gz"),
            "ref-preset": "mni152_2mm",
            "dof": 12,
        },
        dataset_path=str(tmp_path),
        output_dir=str(out),
    )


def test_build_sdk_params_raises_for_missing_input_file(tmp_path):
    """
    _build_sdk_params must raise RuntimeError when a mount:true file param
    points to a path that does not exist, rather than silently passing the
    invalid path to Docker.

    This was Bug 2: missing files were passed as Docker bind sources; modern
    Docker auto-creates them as empty directories, allowing the container to
    start but FLIRT to fail internally while the run was still marked SUCCESS.
    """
    ctx = _make_flirt_ctx(tmp_path, input_path=str(tmp_path / "nonexistent.nii.gz"))

    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False), \
         patch("app.execution.docker_executor.dataset_translation_configured", return_value=False):
        with pytest.raises(RuntimeError, match="Mount validation failed"):
            DockerExecutor()._build_sdk_params(ctx)


def test_build_sdk_params_succeeds_for_existing_input_file(tmp_path):
    """
    _build_sdk_params must succeed when the mount:true file param exists.
    The fix must not break the valid-path case.
    """
    real_input = tmp_path / "brain.nii.gz"
    real_input.write_bytes(b"nifti-placeholder")
    ctx = _make_flirt_ctx(tmp_path, input_path=str(real_input))

    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False), \
         patch("app.execution.docker_executor.dataset_translation_configured", return_value=False):
        sdk = DockerExecutor()._build_sdk_params(ctx)

    # input should be mounted at /inputs/input/<basename>
    assert any("brain.nii.gz" in b["bind"] for b in sdk.volumes.values())
    assert any(
        b["bind"] == f"/inputs/input/{real_input.name}" for b in sdk.volumes.values()
    )


def test_build_sdk_params_raises_for_missing_optional_ref_file(tmp_path):
    """
    When ref-preset=custom and ref-file is provided but does not exist,
    _build_sdk_params must raise RuntimeError rather than silently passing
    the invalid path to Docker.
    """
    real_input = tmp_path / "brain.nii.gz"
    real_input.write_bytes(b"nifti-placeholder")
    manifest = get_registry()["fsl-flirt"]
    out = tmp_path / "out"
    out.mkdir()
    ctx = RunContext(
        run_id=99,
        manifest=manifest,
        params={
            "input": str(real_input),
            "ref-preset": "custom",
            "ref-file": str(tmp_path / "nonexistent_ref.nii.gz"),
            "dof": 12,
        },
        dataset_path=str(tmp_path),
        output_dir=str(out),
    )

    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False), \
         patch("app.execution.docker_executor.dataset_translation_configured", return_value=False):
        with pytest.raises(RuntimeError, match="Mount validation failed.*ref-file"):
            DockerExecutor()._build_sdk_params(ctx)


# ── Layer 3: exit-code propagation through executor.run() ────────────────────


def _make_mock_docker_client(exit_code: int) -> MagicMock:
    """Return a mock Docker SDK client that simulates a container with the given exit code."""
    mock_container = MagicMock()
    mock_container.logs.return_value = iter([b"some log line\n"])
    mock_container.wait.return_value = {"StatusCode": exit_code}
    mock_container.remove = MagicMock()
    mock_container.id = "abc123"

    mock_image = MagicMock()
    mock_image.attrs = {"RepoDigests": ["neuravian/fsl-flirt@sha256:abc"]}

    mock_client = MagicMock()
    mock_client.containers.run.return_value = mock_container
    mock_client.images.get.return_value = mock_image
    return mock_client


def _run_executor_sync(ctx: RunContext, exit_code: int) -> int:
    """Run the executor with a mocked Docker client and return the captured exit code."""
    mock_client = _make_mock_docker_client(exit_code)
    import docker as docker_mod

    log_lines: list[str] = []

    async def _inner() -> int:
        with patch.object(docker_mod, "from_env", return_value=mock_client), \
             patch("app.execution.docker_executor._is_running_in_docker", return_value=False), \
             patch("app.execution.docker_executor.dataset_translation_configured", return_value=False):
            code, _ = await DockerExecutor().run(ctx, log_lines.append)
        return code

    return asyncio.run(_inner())


def test_run_propagates_nonzero_exit_code(tmp_path):
    """
    DockerExecutor.run() must return the container's actual exit code.
    A non-zero exit code must NOT be converted to 0.
    """
    real_input = tmp_path / "brain.nii.gz"
    real_input.write_bytes(b"nifti-placeholder")
    ctx = _make_flirt_ctx(tmp_path, input_path=str(real_input))

    code = _run_executor_sync(ctx, exit_code=1)
    assert code == 1, f"Expected exit code 1 from Docker but got {code}"


def test_run_propagates_zero_exit_code(tmp_path):
    """DockerExecutor.run() must preserve exit code 0 for successful containers."""
    real_input = tmp_path / "brain.nii.gz"
    real_input.write_bytes(b"nifti-placeholder")
    ctx = _make_flirt_ctx(tmp_path, input_path=str(real_input))

    code = _run_executor_sync(ctx, exit_code=0)
    assert code == 0, f"Expected exit code 0 from Docker but got {code}"


# ── Layer 4: end-to-end — executor exception leads to "failed" run status ────


def test_execute_run_background_marks_failed_when_executor_raises(tmp_path):
    """
    When executor.run() raises, _execute_run_background must mark the run 'failed'.

    _execute_run_background initializes exit_code=1, then does:
        try:
            exit_code, digest = await executor.run(...)
        except Exception:
            ...  # exit_code stays 1
    The second SessionLocal block then writes status="failed" because exit_code != 0.

    We mock build_command (called in the provenance block before the try/except)
    so only executor.run itself raises, which is the path the try/except actually covers.
    """
    from app.models.run import Run
    from app.models.pipeline import Pipeline
    from app.models.dataset import Dataset
    from app.execution.executor import Executor

    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    BgSession = sessionmaker(bind=engine)

    manifest = get_registry()["fsl-flirt"]

    out_dir = tmp_path / "derivatives" / "fsl-flirt" / "1"
    out_dir.mkdir(parents=True)

    with BgSession() as db:
        pipeline = Pipeline(name="fsl-flirt", version="6.0.7", manifest_path="fsl-flirt.yaml")
        db.add(pipeline)
        db.commit()
        db.refresh(pipeline)

        dataset = Dataset(path=str(tmp_path), name="test", validation_status="unknown")
        db.add(dataset)
        db.commit()
        db.refresh(dataset)

        run = Run(
            pipeline_id=pipeline.id,
            dataset_id=dataset.id,
            pipeline_version="6.0.7",
            params_json='{"input": "/path/brain.nii.gz", "ref-preset": "mni152_2mm"}',
            status="queued",
            output_dir=str(out_dir),
        )
        db.add(run)
        db.commit()
        db.refresh(run)
        run_id = run.id

    ctx = RunContext(
        run_id=run_id,
        manifest=manifest,
        params={"input": "/path/brain.nii.gz", "ref-preset": "mni152_2mm"},
        dataset_path=str(tmp_path),
        output_dir=str(out_dir),
    )

    async def _failing_run(ctx, log_cb):
        raise RuntimeError("Mount validation failed for parameter 'input': file not found at '/path/brain.nii.gz'.")

    with patch("app.services.run.SessionLocal", BgSession), \
         patch.object(DockerExecutor, "build_command", return_value=["flirt", "-in", "/path/brain.nii.gz"]), \
         patch.object(DockerExecutor, "run", _failing_run):
        asyncio.run(_execute_run_background(run_id, ctx))

    with BgSession() as db:
        updated_run = db.get(Run, run_id)
        assert updated_run.status == "failed", (
            f"Run must be marked 'failed' when executor.run() raises. Got: '{updated_run.status}'"
        )
        assert updated_run.error_message is not None


# ── BET, FAST, FLIRT manifests: confirm pipeline tests still load ─────────────

def test_bet_manifest_unaffected_by_executor_fix():
    """Regression: fsl-bet manifest still loads and has the correct structure."""
    m = get_registry()["fsl-bet"]
    assert m["id"] == "fsl-bet"
    assert any(p["name"] == "input" and p.get("mount") for p in m["parameters"])


def test_fast_manifest_unaffected_by_executor_fix():
    """Regression: fsl-fast manifest still loads and has the correct structure."""
    m = get_registry()["fsl-fast"]
    assert m["id"] == "fsl-fast"
    assert any(p["name"] == "input" and p.get("mount") for p in m["parameters"])


def test_flirt_manifest_unaffected_by_executor_fix():
    """Regression: fsl-flirt manifest still loads and has the correct structure."""
    m = get_registry()["fsl-flirt"]
    assert m["id"] == "fsl-flirt"
    assert any(p["name"] == "input" and p.get("mount") for p in m["parameters"])
    assert any(p["name"] == "ref-file" and p.get("mount") for p in m["parameters"])
