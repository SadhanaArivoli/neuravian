from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from app.core.config import settings
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


def test_native_x86_passes_architecture_and_empirical_verification(tmp_path: Path) -> None:
    result = _run("fmriprep", tmp_path)
    assert _check(result, "cpu_architecture").status == "pass"
    assert _check(result, "empirical_verification").message == "Verification status is recorded as verified."
    assert result.empirical_status == "verified"


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
    assert not any(check.id == "input_readable:analysis_level" for check in result.checks)


def test_fastsurfer_scalar_sid_is_not_checked_as_a_path(tmp_path: Path) -> None:
    t1 = tmp_path / "sub-01_T1w.nii.gz"
    t1.write_bytes(b"nifti-test-fixture")
    license_file = tmp_path / "license.txt"
    license_file.write_text("not-a-real-license-test-fixture")

    result = _run(
        "fastsurfer",
        tmp_path,
        params={"fs_license": str(license_file), "t1": str(t1), "sid": "sub-01"},
        parameterized=True,
    )

    assert _check(result, "license:fs_license").status == "pass"
    assert _check(result, "input_readable:t1").status == "pass"
    assert not any(check.id == "input_readable:sid" for check in result.checks)
    assert not any(check.id == "input_readable:sd" for check in result.checks)
    assert result.can_launch is True


def test_fastsurfer_missing_t1_still_blocks(tmp_path: Path) -> None:
    license_file = tmp_path / "license.txt"
    license_file.write_text("not-a-real-license-test-fixture")
    result = _run(
        "fastsurfer",
        tmp_path,
        params={"fs_license": str(license_file), "sid": "sub-01"},
        parameterized=True,
    )
    check = _check(result, "required_input:t1")
    assert check.status == "fail"
    assert check.blocking is True
    assert result.can_launch is False


def test_fastsurfer_missing_license_still_blocks(tmp_path: Path) -> None:
    t1 = tmp_path / "sub-01_T1w.nii.gz"
    t1.write_bytes(b"nifti-test-fixture")
    result = _run(
        "fastsurfer",
        tmp_path,
        params={"fs_license": str(tmp_path / "missing-license.txt"), "t1": str(t1), "sid": "sub-01"},
        parameterized=True,
    )
    check = _check(result, "license:fs_license")
    assert check.status == "fail"
    assert check.blocking is True
    assert result.can_launch is False


def test_user_supplied_directory_path_is_still_validated(tmp_path: Path) -> None:
    t1 = tmp_path / "sub-01_T1w.nii.gz"
    t1.write_bytes(b"nifti-test-fixture")
    license_file = tmp_path / "license.txt"
    license_file.write_text("not-a-real-license-test-fixture")
    custom_output = tmp_path / "fastsurfer-output"
    custom_output.mkdir()
    base_params = {
        "fs_license": str(license_file), "t1": str(t1), "sid": "sub-01",
    }

    valid = _run(
        "fastsurfer", tmp_path,
        params={**base_params, "sd": str(custom_output)}, parameterized=True,
    )
    assert _check(valid, "input_readable:sd").status == "pass"

    missing = _run(
        "fastsurfer", tmp_path,
        params={**base_params, "sd": str(tmp_path / "missing-directory")}, parameterized=True,
    )
    check = _check(missing, "input_readable:sd")
    assert check.status == "fail"
    assert check.blocking is True


def test_scalar_parameter_types_never_receive_readability_checks(tmp_path: Path) -> None:
    manifest = {
        "id": "scalar-types",
        "display_name": "Scalar types",
        "parameters": [
            {"name": kind, "type": kind, "required": False}
            for kind in ("string", "integer", "float", "boolean", "enum", "choice")
        ],
        "preflight": {"resources": {}},
    }
    params = {
        "string": "sub-01", "integer": 1, "float": 1.5,
        "boolean": True, "enum": "a", "choice": "b",
    }
    with (
        patch("app.services.preflight.platform.system", return_value="Linux"),
        patch("app.services.preflight.platform.machine", return_value="x86_64"),
        patch("app.services.preflight.shutil.which", return_value=None),
        patch("app.services.preflight.shutil.disk_usage", return_value=SimpleNamespace(free=250 * 1024**3)),
        patch("app.services.preflight.psutil.virtual_memory", return_value=SimpleNamespace(total=32 * 1024**3)),
        patch("app.services.preflight.os.cpu_count", return_value=8),
        patch("app.services.preflight.settings.data_dir", str(tmp_path)),
    ):
        result = PreflightService().run(manifest, params=params, parameterized=True)
    assert not any(check.id.startswith("input_readable:") for check in result.checks)


def test_cloud_dataset_preflight_uses_backend_namespace(tmp_path: Path) -> None:
    backend_root = tmp_path / "backend-host-data"
    dataset_root = backend_root / "x86-minimal-bids"
    dataset_root.mkdir(parents=True)
    host_root = tmp_path / "host-root-not-visible-in-backend"
    dataset = Dataset(path=str(dataset_root), validation_status="valid")

    with patch.object(settings, "host_datasets_mount", str(host_root)), \
         patch.object(settings, "backend_datasets_mount", str(backend_root)):
        result = _run(
            "bids-validator",
            tmp_path,
            params={"bids-dir": str(dataset_root)},
            dataset=dataset,
            parameterized=True,
        )

    assert not host_root.exists()
    assert _check(result, "input_readable:bids-dir").status == "pass"
    assert str(host_root) not in " ".join(check.message for check in result.checks)


def test_missing_cloud_dataset_blocks_without_host_path_leak(
    tmp_path: Path,
) -> None:
    backend_root = tmp_path / "backend-host-data"
    backend_root.mkdir()
    logical_path = backend_root / "missing-dataset"
    host_root = Path("/srv/private-neuravian-datasets")
    dataset = Dataset(path=str(logical_path), validation_status="valid")

    with patch.object(settings, "host_datasets_mount", str(host_root)), \
         patch.object(settings, "backend_datasets_mount", str(backend_root)):
        result = _run(
            "bids-validator",
            tmp_path,
            params={"bids-dir": str(logical_path)},
            dataset=dataset,
            parameterized=True,
        )

    check = _check(result, "input_readable:bids-dir")
    assert check.status == "fail"
    assert check.blocking is True
    assert str(host_root) not in check.message


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
