"""
Tests for the execution layer: command building, resource checks, error translation,
and the run API endpoints.

Reasoning on test strategy:
- DockerExecutor.build_command() is pure Python — tested end-to-end against the
  real mriqc manifest. No Docker daemon required.
- DockerExecutor.run() calls the Docker SDK (blocking I/O). We mock the SDK in
  unit tests. Pulling nipreps/mriqc:24.0.2 (4+ GB) and running it against a real
  dataset is not suitable for CI — that verification is done manually per the M4
  verification standard.
- translate_errors() is pure regex — tested with synthetic log strings.
- API endpoints are tested with a mock executor injected via dependency override.
"""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.core.config import settings
from app.execution.docker_executor import DockerExecutor, translate_errors, to_host_path
from app.execution.executor import RunContext
from app.execution.native_executor import NativeExecutor
from app.main import app
from app.services.pipeline import get_registry
from app.services.run import seed_pipeline_registry

PIPELINES_DIR = Path(__file__).parent.parent.parent / "pipelines"


# ------------------------------------------------------------------ #
# Shared DB fixture                                                     #
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
    # Seed our test DB manually. Patch the source so the lifespan's SessionLocal()
    # call (which would hit the real DB, not the in-memory test DB) is a no-op.
    seed_pipeline_registry(db_session)
    with patch("app.services.run.seed_pipeline_registry"):
        with TestClient(app) as client:
            yield client
    app.dependency_overrides.clear()


@pytest.fixture()
def mriqc_manifest():
    return get_registry()["mriqc"]


@pytest.fixture()
def base_ctx(mriqc_manifest, tmp_path):
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    return RunContext(
        run_id=1,
        manifest=mriqc_manifest,
        params={"analysis_level": "participant"},
        dataset_path="/host-data/ds001",
        output_dir=str(output_dir),
    )


# ------------------------------------------------------------------ #
# to_host_path (path translation)                                      #
# ------------------------------------------------------------------ #

def test_to_host_path_passthrough_outside_docker():
    """When not in Docker, path is returned unchanged."""
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        result = to_host_path("/host-data/bids-examples/ds001")
    assert result == "/host-data/bids-examples/ds001"


def test_to_host_path_translates_via_mounts():
    """When in Docker, path is translated using container mount table."""
    mock_mounts = {
        "/host-data": "/Users/alice/Documents",
        "/app/data": "/Users/alice/neuravian/data",
    }
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=True), \
         patch("app.execution.docker_executor._resolve_mounts", return_value=mock_mounts):
        assert to_host_path("/host-data/bids-examples/ds001") == "/Users/alice/Documents/bids-examples/ds001"
        assert to_host_path("/app/data/derivatives/mriqc/1") == "/Users/alice/neuravian/data/derivatives/mriqc/1"


# ------------------------------------------------------------------ #
# DockerExecutor.build_command                                          #
# ------------------------------------------------------------------ #

def test_build_command_basic_participant(base_ctx):
    """Minimal params produce a well-formed docker command."""
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        cmd = DockerExecutor().build_command(base_ctx)

    assert cmd[0] == "docker"
    assert "run" in cmd
    assert "--rm" in cmd
    # Image
    assert "nipreps/mriqc:24.0.2" in cmd
    # Dataset mount (ro)
    assert "/host-data/ds001:/data:ro" in " ".join(cmd)
    # Output mount
    assert ":/out:rw" in " ".join(cmd)
    # Fixed positional: dataset and output inside the tool's container
    assert "/data" in cmd
    assert "/out" in cmd
    # analysis_level positional (should appear as bare value, not --analysis-level)
    assert "participant" in cmd
    assert "--analysis-level" not in cmd


def test_build_command_positional_before_flags(mriqc_manifest, tmp_path):
    """analysis_level must appear before any --flags."""
    ctx = RunContext(
        run_id=1,
        manifest=mriqc_manifest,
        params={"analysis_level": "participant", "nprocs": 4},
        dataset_path="/data/ds001",
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        cmd = DockerExecutor().build_command(ctx)

    image_idx = cmd.index("nipreps/mriqc:24.0.2")
    participant_idx = cmd.index("participant")
    nprocs_idx = cmd.index("--nprocs")
    assert image_idx < participant_idx < nprocs_idx


def test_build_command_nprocs_and_mem(mriqc_manifest, tmp_path):
    """Integer and float params appear as --flag value."""
    ctx = RunContext(
        run_id=1,
        manifest=mriqc_manifest,
        params={"analysis_level": "participant", "nprocs": 4, "mem": 16.0},
        dataset_path="/data/ds001",
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        cmd = DockerExecutor().build_command(ctx)
    assert "--nprocs" in cmd
    assert "4" in cmd
    assert "--mem" in cmd
    assert "16.0" in cmd


def test_build_command_boolean_flag_true(mriqc_manifest, tmp_path):
    """Boolean param True → --flag-name (no value)."""
    ctx = RunContext(
        run_id=1,
        manifest=mriqc_manifest,
        params={"analysis_level": "participant", "float32": True},
        dataset_path="/data/ds001",
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        cmd = DockerExecutor().build_command(ctx)
    assert "--float32" in cmd
    # Should NOT have a value after the flag
    idx = cmd.index("--float32")
    assert idx + 1 >= len(cmd) or cmd[idx + 1].startswith("--") or cmd[idx + 1] in ("/data", "/out", "participant")


def test_build_command_boolean_flag_false(mriqc_manifest, tmp_path):
    """Boolean param False → omitted entirely."""
    ctx = RunContext(
        run_id=1,
        manifest=mriqc_manifest,
        params={"analysis_level": "participant", "float32": False},
        dataset_path="/data/ds001",
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        cmd = DockerExecutor().build_command(ctx)
    assert "--float32" not in cmd


def test_build_command_multiselect_modalities(mriqc_manifest, tmp_path):
    """Multiselect param → --flag val1 val2."""
    ctx = RunContext(
        run_id=1,
        manifest=mriqc_manifest,
        params={"analysis_level": "participant", "modalities": ["T1w", "bold"]},
        dataset_path="/data/ds001",
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        cmd = DockerExecutor().build_command(ctx)
    assert "--modalities" in cmd
    idx = cmd.index("--modalities")
    assert cmd[idx + 1] == "T1w"
    assert cmd[idx + 2] == "bold"


def test_build_command_multiple_participant_label(mriqc_manifest, tmp_path):
    """Space-separated string with multiple:true → split into separate args."""
    ctx = RunContext(
        run_id=1,
        manifest=mriqc_manifest,
        params={"analysis_level": "participant", "participant-label": "01 02 03"},
        dataset_path="/data/ds001",
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        cmd = DockerExecutor().build_command(ctx)
    idx = cmd.index("--participant-label")
    assert cmd[idx + 1] == "01"
    assert cmd[idx + 2] == "02"
    assert cmd[idx + 3] == "03"


def test_build_command_empty_params_omitted(mriqc_manifest, tmp_path):
    """Empty string params are not included in the command."""
    ctx = RunContext(
        run_id=1,
        manifest=mriqc_manifest,
        params={"analysis_level": "participant", "participant-label": "", "session-id": ""},
        dataset_path="/data/ds001",
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        cmd = DockerExecutor().build_command(ctx)
    assert "--participant-label" not in cmd
    assert "--session-id" not in cmd


def test_build_command_workdir_mount(mriqc_manifest, tmp_path):
    """work-dir triggers an extra volume mount and --work-dir /work flag."""
    work_dir = str(tmp_path / "work")
    ctx = RunContext(
        run_id=1,
        manifest=mriqc_manifest,
        params={"analysis_level": "participant", "work-dir": work_dir},
        dataset_path="/data/ds001",
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        cmd = DockerExecutor().build_command(ctx)
    cmd_str = " ".join(cmd)
    assert "/work" in cmd_str
    assert "--work-dir" in cmd
    assert "/work" in cmd[cmd.index("--work-dir") + 1]


def test_build_command_skips_internal_params(tmp_path):
    """Internal lineage params are recorded in run params but never emitted as CLI flags."""
    manifest = get_registry()["mriqc-group"]
    ctx = RunContext(
        run_id=1,
        manifest=manifest,
        params={
            "analysis_level": "group",
            "upstream-mriqc-dir": str(tmp_path / "mriqc"),
            "no-sub": True,
        },
        dataset_path="/data/ds001",
        output_dir=str(tmp_path / "out"),
    )
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        cmd = DockerExecutor().build_command(ctx)
    assert "group" in cmd
    assert "--no-sub" in cmd
    assert "--upstream-mriqc-dir" not in cmd
    assert str(tmp_path / "mriqc") not in cmd


def test_functional_connectivity_native_command_uses_prefilled_derivatives(tmp_path):
    manifest = get_registry()["functional-connectivity"]
    ctx = RunContext(
        run_id=1,
        manifest=manifest,
        params={
            "fmriprep-dir": str(tmp_path / "fmriprep"),
            "output-dir": str(tmp_path / "out"),
            "atlas-name": "schaefer_100_7",
        },
        dataset_path="/unused",
        output_dir=str(tmp_path / "out"),
    )
    cmd = NativeExecutor().build_command(ctx)
    assert cmd[0] == "neuravian-functional-connectivity"
    assert "--fmriprep-dir" in cmd
    assert str(tmp_path / "fmriprep") in cmd
    assert "--output-dir" in cmd
    assert str(tmp_path / "out") in cmd


def test_import_fmriprep_derivatives_native_command_uses_selected_dir(tmp_path):
    manifest = get_registry()["import-fmriprep-derivatives"]
    ctx = RunContext(
        run_id=1,
        manifest=manifest,
        params={
            "fmriprep-dir": str(tmp_path / "fmriprep"),
            "output-dir": str(tmp_path / "out"),
        },
        dataset_path="/unused",
        output_dir=str(tmp_path / "out"),
    )
    cmd = NativeExecutor().build_command(ctx)
    assert cmd[0] == "neuravian-import-fmriprep-derivatives"
    assert "--fmriprep-dir" in cmd
    assert str(tmp_path / "fmriprep") in cmd
    assert "--output-dir" in cmd
    assert str(tmp_path / "out") in cmd


# ------------------------------------------------------------------ #
# translate_errors                                                      #
# ------------------------------------------------------------------ #

def test_translate_errors_no_match():
    assert translate_errors("Run completed successfully.", []) is None


def test_translate_errors_matches_known_pattern():
    log_text = "FileNotFoundError: dataset_description.json not found"
    known = [
        {
            "pattern": "No such file or directory.*dataset_description\\.json",
            "explanation": "Missing dataset_description.json at the root.",
            "fix_hint": "Select the top-level BIDS directory.",
        }
    ]
    # This pattern won't match the log text above (different wording), so test a matching case:
    log_text2 = "No such file or directory: '/data/dataset_description.json'"
    result = translate_errors(log_text2, known)
    assert result is not None
    assert "Missing dataset_description.json" in result
    assert "Select the top-level BIDS directory" in result


def test_translate_errors_oom_match():
    log_text = "MemoryError: unable to allocate array"
    known = [{"pattern": "MemoryError", "explanation": "MRIQC ran out of memory."}]
    result = translate_errors(log_text, known)
    assert result == "MRIQC ran out of memory."


def test_translate_errors_first_match_wins():
    """Only the first matching pattern's explanation is returned."""
    log_text = "Killed\nMemoryError"
    known = [
        {"pattern": "Killed", "explanation": "Process was killed (OOM)."},
        {"pattern": "MemoryError", "explanation": "Memory error."},
    ]
    result = translate_errors(log_text, known)
    assert result == "Process was killed (OOM)."


def test_translate_errors_invalid_regex_skipped():
    """A broken regex in known_errors doesn't crash the translation."""
    log_text = "some error"
    known = [{"pattern": "[invalid(", "explanation": "Should be skipped."}]
    result = translate_errors(log_text, known)
    assert result is None


# ------------------------------------------------------------------ #
# Resource pre-check                                                    #
# ------------------------------------------------------------------ #

def test_check_resources_warns_on_low_ram(base_ctx):
    """A system with low available RAM triggers a warning."""
    mock_vm = MagicMock()
    mock_vm.available = 1 * 1024 ** 3  # 1 GB
    mock_disk = MagicMock()
    mock_disk.free = 20 * 1024 ** 3   # plenty of disk

    with patch("psutil.virtual_memory", return_value=mock_vm), \
         patch("psutil.disk_usage", return_value=mock_disk):
        warnings = DockerExecutor().check_resources(base_ctx)

    assert any("RAM" in w.message for w in warnings)


def test_check_resources_warns_on_low_disk(base_ctx):
    mock_vm = MagicMock()
    mock_vm.available = 16 * 1024 ** 3
    mock_disk = MagicMock()
    mock_disk.free = 1 * 1024 ** 3   # 1 GB

    with patch("psutil.virtual_memory", return_value=mock_vm), \
         patch("psutil.disk_usage", return_value=mock_disk):
        warnings = DockerExecutor().check_resources(base_ctx)

    assert any("disk" in w.message.lower() for w in warnings)


def test_check_resources_clean(base_ctx):
    mock_vm = MagicMock()
    mock_vm.available = 16 * 1024 ** 3
    mock_disk = MagicMock()
    mock_disk.free = 50 * 1024 ** 3

    # Mask ARM detection so the test is not platform-specific; the ARM warning
    # is exercised by test_check_resources_arm_warning below.
    with patch("psutil.virtual_memory", return_value=mock_vm), \
         patch("psutil.disk_usage", return_value=mock_disk), \
         patch("platform.machine", return_value="x86_64"):
        warnings = DockerExecutor().check_resources(base_ctx)

    assert warnings == []


def test_check_resources_arm_warning(base_ctx):
    """ARM host with an amd64 image triggers an architecture warning."""
    mock_vm = MagicMock()
    mock_vm.available = 16 * 1024 ** 3
    mock_disk = MagicMock()
    mock_disk.free = 50 * 1024 ** 3

    mock_img = MagicMock()
    mock_img.attrs = {"Architecture": "amd64"}
    mock_docker_client = MagicMock()
    mock_docker_client.images.get.return_value = mock_img

    import docker as _docker_mod
    with patch("psutil.virtual_memory", return_value=mock_vm), \
         patch("psutil.disk_usage", return_value=mock_disk), \
         patch("platform.machine", return_value="arm64"), \
         patch.object(_docker_mod, "from_env", return_value=mock_docker_client):
        warnings = DockerExecutor().check_resources(base_ctx)

    assert any("Rosetta 2" in w.message for w in warnings)


# ------------------------------------------------------------------ #
# API endpoint tests (mock executor, no real Docker)                   #
# ------------------------------------------------------------------ #

def _register_valid_dataset(api_client, tmp_path):
    """Register the valid_bids fixture dataset and return its id."""
    from pathlib import Path as P
    fixtures = P(__file__).parent / "fixtures" / "valid_bids"
    resp = api_client.post("/api/datasets", json={"path": str(fixtures)})
    assert resp.status_code == 201
    return resp.json()["id"]


def test_create_run_returns_201(api_client, tmp_path):
    """POST /api/runs creates a run record and returns 201."""
    dataset_id = _register_valid_dataset(api_client, tmp_path)

    with patch("app.services.run._execute_run_background", new_callable=AsyncMock):
        with patch("app.execution.docker_executor.DockerExecutor.check_resources", return_value=[]):
            with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
                resp = api_client.post("/api/runs", json={
                    "pipeline_id": "mriqc",
                    "dataset_id": dataset_id,
                    "params": {"analysis_level": "participant"},
                })

    assert resp.status_code == 201
    data = resp.json()
    assert data["pipeline_manifest_id"] == "mriqc"
    assert data["status"] == "queued"
    assert data["command_preview"] is not None
    assert "nipreps/mriqc:24.0.2" in data["command_preview"]


def test_create_run_resolves_relative_data_dir(api_client, tmp_path, monkeypatch):
    """Local Docker mounts need absolute host paths, even with relative data_dir."""
    dataset_id = _register_valid_dataset(api_client, tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "data_dir", "relative_data")

    with patch("app.services.run._execute_run_background", new_callable=AsyncMock):
        with patch("app.execution.docker_executor.DockerExecutor.check_resources", return_value=[]):
            with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
                resp = api_client.post("/api/runs", json={
                    "pipeline_id": "mriqc",
                    "dataset_id": dataset_id,
                    "params": {"analysis_level": "participant"},
                })

    assert resp.status_code == 201
    data = resp.json()
    assert Path(data["output_dir"]).is_absolute()
    assert data["output_dir"] == str(
        tmp_path / "relative_data" / "derivatives" / "mriqc" / str(data["id"])
    )


def test_mriqc_group_run_seeds_output_from_lineage(api_client, tmp_path, monkeypatch):
    """MRIQC group runs copy participant MRIQC outputs into their own output_dir."""
    dataset_id = _register_valid_dataset(api_client, tmp_path)
    monkeypatch.setattr(settings, "data_dir", str(tmp_path / "data"))
    upstream_dir = tmp_path / "participant-mriqc"
    upstream_json = upstream_dir / "sub-01" / "anat" / "sub-01_T1w.json"
    upstream_json.parent.mkdir(parents=True)
    upstream_json.write_text('{"snr_total": 10.5}', encoding="utf-8")

    with patch("app.services.run._execute_run_background", new_callable=AsyncMock):
        with patch("app.execution.docker_executor.DockerExecutor.check_resources", return_value=[]):
            with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
                source_resp = api_client.post("/api/runs", json={
                    "pipeline_id": "mriqc",
                    "dataset_id": dataset_id,
                    "params": {"analysis_level": "participant"},
                })
                assert source_resp.status_code == 201
                source_run_id = source_resp.json()["id"]

                group_resp = api_client.post("/api/runs", json={
                    "pipeline_id": "mriqc-group",
                    "dataset_id": dataset_id,
                    "params": {
                        "analysis_level": "group",
                        "upstream-mriqc-dir": str(upstream_dir),
                    },
                    "lineage": {
                        "upstream_run_id": source_run_id,
                        "upstream_pipeline_id": "mriqc",
                        "upstream_pipeline_display_name": "MRIQC",
                        "artifact_type": "mriqc_report",
                        "artifact_label": "MRIQC Report",
                        "injected_param": "upstream-mriqc-dir",
                        "injected_path": str(upstream_dir),
                    },
                })

    assert group_resp.status_code == 201
    data = group_resp.json()
    assert data["pipeline_manifest_id"] == "mriqc-group"
    assert "--upstream-mriqc-dir" not in data["command_preview"]
    seeded_json = Path(data["output_dir"]) / "sub-01" / "anat" / "sub-01_T1w.json"
    assert seeded_json.exists()
    assert seeded_json.read_text(encoding="utf-8") == '{"snr_total": 10.5}'


def test_dcm2bids_wizard_launch_resolves_config_path(api_client, tmp_path, monkeypatch):
    """Wizard-generated config files must be bind-mounted via absolute paths."""
    dicom_dir = tmp_path / "dicoms"
    dicom_dir.mkdir()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(settings, "data_dir", "relative_data")

    with patch("app.services.run._execute_run_background", new_callable=AsyncMock):
        with patch("app.execution.docker_executor.DockerExecutor.check_resources", return_value=[]):
            with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
                resp = api_client.post("/api/wizard/dcm2bids/launch", json={
                    "dicom_path": str(dicom_dir),
                    "participant_id": "01",
                    "session_id": None,
                    "dataset_name": "DICOM source 01",
                    "config": {"descriptions": []},
                })

    assert resp.status_code == 200
    data = resp.json()
    assert Path(data["config_path"]).is_absolute()
    assert data["config_path"].startswith(str(tmp_path / "relative_data"))


def test_create_run_unknown_pipeline(api_client):
    resp = api_client.post("/api/runs", json={
        "pipeline_id": "nonexistent",
        "dataset_id": 1,
        "params": {},
    })
    assert resp.status_code == 400


def test_create_run_unknown_dataset(api_client):
    with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
        resp = api_client.post("/api/runs", json={
            "pipeline_id": "mriqc",
            "dataset_id": 9999,
            "params": {"analysis_level": "participant"},
        })
    assert resp.status_code == 400


def test_list_runs_empty(api_client):
    resp = api_client.get("/api/runs")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_runs_after_create(api_client, tmp_path):
    dataset_id = _register_valid_dataset(api_client, tmp_path)

    with patch("app.services.run._execute_run_background", new_callable=AsyncMock):
        with patch("app.execution.docker_executor.DockerExecutor.check_resources", return_value=[]):
            with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
                api_client.post("/api/runs", json={
                    "pipeline_id": "mriqc",
                    "dataset_id": dataset_id,
                    "params": {"analysis_level": "participant"},
                })

    resp = api_client.get("/api/runs")
    assert resp.status_code == 200
    assert len(resp.json()) == 1


def test_get_run_by_id(api_client, tmp_path):
    dataset_id = _register_valid_dataset(api_client, tmp_path)

    with patch("app.services.run._execute_run_background", new_callable=AsyncMock):
        with patch("app.execution.docker_executor._is_running_in_docker", return_value=False):
            create_resp = api_client.post("/api/runs", json={
                "pipeline_id": "mriqc",
                "dataset_id": dataset_id,
                "params": {"analysis_level": "participant"},
            })

    run_id = create_resp.json()["id"]
    resp = api_client.get(f"/api/runs/{run_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == run_id


def test_get_run_not_found(api_client):
    resp = api_client.get("/api/runs/9999")
    assert resp.status_code == 404
