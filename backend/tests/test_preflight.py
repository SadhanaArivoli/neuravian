from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.main import app
from app.models.dataset import Dataset
from app.services.pipeline import get_registry
from app.services.preflight import PreflightService


class _Images:
    def get(self, _reference: str):
        return SimpleNamespace(attrs={"Architecture": "amd64"})


class _DockerClient:
    images = _Images()

    def ping(self) -> bool:
        return True


def _run(pipeline_id: str, tmp_path: Path, *, arch: str = "x86_64", params=None, dataset=None, parameterized=False):
    manifest = get_registry()[pipeline_id]
    with (
        patch("app.services.preflight.platform.system", return_value="Linux"),
        patch("app.services.preflight.platform.machine", return_value=arch),
        patch("app.services.preflight.shutil.which", return_value=None),
        patch("app.services.preflight.shutil.disk_usage", return_value=SimpleNamespace(free=250 * 1024**3)),
        patch("app.services.preflight.psutil.virtual_memory", return_value=SimpleNamespace(total=32 * 1024**3)),
        patch("app.services.preflight.os.cpu_count", return_value=8),
        patch("app.services.preflight.settings.data_dir", str(tmp_path)),
        patch("docker.from_env", return_value=_DockerClient()),
    ):
        return PreflightService().run(
            manifest, dataset=dataset, params=params, parameterized=parameterized,
        )


def _check(result, check_id: str):
    return next(check for check in result.checks if check.id == check_id)


def test_native_x86_passes_architecture_but_stays_pending(tmp_path: Path) -> None:
    result = _run("fmriprep", tmp_path)
    assert _check(result, "cpu_architecture").status == "pass"
    assert _check(result, "empirical_verification").message == "Pending empirical x86_64 verification."
    assert result.empirical_status == "pending-x86_64"


def test_apple_silicon_blocks_local_unsafe_pipeline(tmp_path: Path) -> None:
    result = _run("fmriprep", tmp_path, arch="arm64")
    check = _check(result, "cpu_architecture")
    assert check.status == "fail"
    assert check.blocking is True
    assert result.can_launch is False


def test_apple_silicon_warns_for_local_slow_pipeline(tmp_path: Path) -> None:
    result = _run("fastsurfer", tmp_path, arch="arm64")
    check = _check(result, "cpu_architecture")
    assert check.status == "warning"
    assert check.blocking is False


def test_parameterized_preflight_checks_inputs_bids_and_license(tmp_path: Path) -> None:
    dataset_root = tmp_path / "bids"
    dataset_root.mkdir()
    license_file = tmp_path / "license.txt"
    license_file.write_text("not-a-real-license-test-fixture")
    dataset = Dataset(path=str(dataset_root), validation_status="valid")
    result = _run(
        "fmriprep", tmp_path,
        params={"fs-license-file": str(license_file), "analysis_level": "participant"},
        dataset=dataset, parameterized=True,
    )
    assert _check(result, "bids_validity").status == "pass"
    assert _check(result, "license:fs-license-file").status == "pass"
    assert result.can_launch is True


def test_missing_required_parameter_is_blocking(tmp_path: Path) -> None:
    result = _run("pydeface", tmp_path, params={}, parameterized=True)
    check = _check(result, "required_input:nifti-file")
    assert check.status == "fail"
    assert check.blocking is True


def test_daemon_stopped_is_distinct_blocking_failure(tmp_path: Path) -> None:
    manifest = get_registry()["pydeface"]
    client = MagicMock()
    client.ping.side_effect = RuntimeError("daemon stopped")
    with (
        patch("app.services.preflight.platform.system", return_value="Linux"),
        patch("app.services.preflight.platform.machine", return_value="x86_64"),
        patch("app.services.preflight.shutil.which", return_value=None),
        patch("app.services.preflight.shutil.disk_usage", return_value=SimpleNamespace(free=250 * 1024**3)),
        patch("app.services.preflight.psutil.virtual_memory", return_value=SimpleNamespace(total=32 * 1024**3)),
        patch("app.services.preflight.os.cpu_count", return_value=8),
        patch("app.services.preflight.settings.data_dir", str(tmp_path)),
        patch("docker.from_env", return_value=client),
    ):
        result = PreflightService().run(manifest)
    assert _check(result, "docker_daemon").status == "fail"
    assert _check(result, "docker_daemon").blocking is True


def test_compose_unavailable_is_reported_without_faking_success(tmp_path: Path) -> None:
    manifest = get_registry()["pydeface"]
    with (
        patch("app.services.preflight.platform.system", return_value="Linux"),
        patch("app.services.preflight.platform.machine", return_value="x86_64"),
        patch("app.services.preflight.shutil.which", return_value="/usr/bin/docker"),
        patch("app.services.preflight.subprocess.run", side_effect=RuntimeError("no compose")),
        patch("app.services.preflight.shutil.disk_usage", return_value=SimpleNamespace(free=250 * 1024**3)),
        patch("app.services.preflight.psutil.virtual_memory", return_value=SimpleNamespace(total=32 * 1024**3)),
        patch("app.services.preflight.os.cpu_count", return_value=8),
        patch("app.services.preflight.settings.data_dir", str(tmp_path)),
        patch("docker.from_env", return_value=_DockerClient()),
    ):
        result = PreflightService().run(manifest)
    assert _check(result, "docker_compose").status == "warning"
    assert "failed" in _check(result, "docker_compose").message.lower()


def test_preflight_api_routes_exist() -> None:
    with patch("app.services.run.seed_pipeline_registry"):
        with TestClient(app) as client:
            response = client.get("/api/pipelines/fmriprep/preflight")
            assert response.status_code == 200
            assert response.json()["pipeline_id"] == "fmriprep"
            response = client.post("/api/pipelines/pydeface/preflight", json={"params": {}})
            assert response.status_code == 200
            assert any(check["id"] == "required_input:nifti-file" for check in response.json()["checks"])
