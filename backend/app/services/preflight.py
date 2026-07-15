from __future__ import annotations

import importlib.util
import os
import platform
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any

import psutil

from app.core.config import settings
from app.models.dataset import Dataset
from app.schemas.preflight import PipelinePreflightResponse, PreflightCheck
from app.services.dataset_paths import (
    dataset_translation_configured,
    try_resolve_dataset_path,
)


def _normalise_architecture(value: str) -> str:
    lowered = value.lower()
    if lowered in {"amd64", "x86_64", "x64"}:
        return "x86_64"
    if lowered in {"arm64", "aarch64"}:
        return "arm64"
    return lowered


def _image_reference(manifest: dict[str, Any]) -> str | None:
    container = manifest.get("container")
    if not container:
        return None
    tag = container["tag"]
    separator = "@" if tag.startswith("sha256:") else ":"
    return f"{container['image']}{separator}{tag}"


def _path_for_parameter(raw: object) -> Path:
    path = Path(str(raw)).expanduser()
    if dataset_translation_configured():
        resolved = try_resolve_dataset_path(path)
        if resolved is not None:
            return resolved.backend
    return path.resolve()


class PreflightService:
    """Central preflight evaluator for manifest-defined execution requirements."""

    def run(
        self,
        manifest: dict[str, Any],
        *,
        dataset: Dataset | None = None,
        params: dict[str, Any] | None = None,
        parameterized: bool = False,
    ) -> PipelinePreflightResponse:
        params = params or {}
        policy = manifest.get("preflight", {})
        resources = policy.get("resources", {})
        checks: list[PreflightCheck] = []

        def add(
            check_id: str,
            label: str,
            status: str,
            message: str,
            *,
            remediation: str | None = None,
            blocking: bool = False,
            measured: object = None,
            required: object = None,
        ) -> None:
            checks.append(PreflightCheck(
                id=check_id,
                label=label,
                status=status,  # type: ignore[arg-type]
                message=message,
                remediation=remediation,
                blocking=blocking,
                measured_value=measured,  # type: ignore[arg-type]
                required_value=required,  # type: ignore[arg-type]
            ))

        empirical = policy.get("empirical_status", "unknown")
        if empirical == "pending-x86_64":
            add(
                "empirical_verification", "Empirical verification", "warning",
                "Pending empirical x86_64 verification.",
                remediation="Run the frozen verification sequence on native Linux x86_64 before changing this status.",
                measured=empirical, required="verified",
            )
        elif empirical == "unsupported":
            add("empirical_verification", "Empirical verification", "fail", "This pipeline is unsupported.", blocking=True, measured=empirical, required="verified")
        else:
            add("empirical_verification", "Empirical verification", "pass", "Verification status is recorded as verified.", measured=empirical, required="verified")

        actual_os = platform.system()
        required_os = policy.get("required_os")
        if required_os and actual_os.lower() != str(required_os).lower():
            add("operating_system", "Operating system", "fail", f"{manifest['display_name']} requires {required_os}; this backend reports {actual_os}.", remediation=f"Use a {required_os} execution host.", blocking=True, measured=actual_os, required=required_os)
        else:
            add("operating_system", "Operating system", "pass", f"Operating system is {actual_os}.", measured=actual_os, required=required_os or "any")

        actual_arch = _normalise_architecture(platform.machine())
        required_arch = _normalise_architecture(str(policy.get("required_architecture", actual_arch)))
        if actual_arch != required_arch:
            mismatch = policy.get("architecture_mismatch", "warning")
            blocking = mismatch == "fail"
            add(
                "cpu_architecture", "CPU architecture", "fail" if blocking else "warning",
                policy.get("known_local_unsafe") or f"Architecture {actual_arch} does not match {required_arch}.",
                remediation=f"Use native {required_os or 'supported OS'} {required_arch}; do not use Rosetta or QEMU for verification.",
                blocking=blocking, measured=actual_arch, required=required_arch,
            )
        else:
            add("cpu_architecture", "CPU architecture", "pass", f"Native architecture {actual_arch} matches the requirement.", measured=actual_arch, required=required_arch)

        docker_sdk = importlib.util.find_spec("docker") is not None
        add(
            "docker_available", "Docker availability", "pass" if docker_sdk else "fail",
            "Docker SDK is available to the NeuroForge backend." if docker_sdk else "Docker SDK is unavailable to the NeuroForge backend.",
            remediation=None if docker_sdk else "Install the backend Docker dependency and mount the Docker socket.",
            blocking=bool(manifest.get("container")) and not docker_sdk,
            measured=docker_sdk, required=bool(manifest.get("container")),
        )

        docker_client = None
        daemon_ok = False
        if manifest.get("container") and docker_sdk:
            try:
                import docker
                docker_client = docker.from_env()
                daemon_ok = bool(docker_client.ping())
            except Exception:
                daemon_ok = False
            add(
                "docker_daemon", "Docker daemon", "pass" if daemon_ok else "fail",
                "Docker daemon is reachable." if daemon_ok else "Docker daemon is not reachable from NeuroForge.",
                remediation=None if daemon_ok else "Start Docker and ensure /var/run/docker.sock is available to the backend.",
                blocking=not daemon_ok, measured=daemon_ok, required=True,
            )

        docker_cli = shutil.which("docker")
        if docker_cli:
            try:
                result = subprocess.run([docker_cli, "compose", "version"], capture_output=True, text=True, timeout=10, check=True)
                compose_version = (result.stdout or result.stderr).strip()
                add("docker_compose", "Docker Compose", "pass", compose_version, measured=compose_version, required="Compose v2")
            except Exception:
                add("docker_compose", "Docker Compose", "warning", "Docker CLI was found, but the Compose plugin check failed.", remediation="Install the Docker Compose v2 plugin before bootstrapping the platform.", measured="unavailable", required="Compose v2")
        else:
            add("docker_compose", "Docker Compose", "unknown", "Docker CLI is not installed inside this backend process; pipeline execution uses the Docker SDK socket.", remediation="The VM bootstrap verifies Compose on the host before starting NeuroForge.", measured="not visible in backend", required="Compose v2")

        image_ref = _image_reference(manifest)
        if image_ref and daemon_ok and docker_client is not None:
            try:
                image = docker_client.images.get(image_ref)
                image_arch = _normalise_architecture(str(image.attrs.get("Architecture", "unknown")))
                add("container_image", "Container image", "pass", f"Required image is available locally: {image_ref}.", measured=image_ref, required=image_ref)
                if image_arch == required_arch:
                    add("image_architecture", "Image architecture", "pass", f"Cached image architecture is {image_arch}.", measured=image_arch, required=required_arch)
                else:
                    add("image_architecture", "Image architecture", "fail", f"Cached image architecture is {image_arch}, not {required_arch}.", remediation=f"Pull the pinned {required_arch} image on the verification host.", blocking=True, measured=image_arch, required=required_arch)
            except Exception:
                add("container_image", "Container image", "warning", f"Required image is not cached: {image_ref}.", remediation="Run the frozen pre-pull script once before paid verification commands.", measured="not cached", required=image_ref)

        if policy.get("requires_valid_bids"):
            if dataset is None:
                status = "fail" if parameterized else "unknown"
                add("bids_validity", "BIDS validity", status, "Select a registered BIDS dataset to evaluate validation status.", remediation="Select a dataset with valid or warning-only BIDS status.", blocking=parameterized, measured="not selected", required="valid")
            elif dataset.validation_status in {"valid", "warning"}:
                add("bids_validity", "BIDS validity", "pass" if dataset.validation_status == "valid" else "warning", f"Dataset BIDS status is {dataset.validation_status}.", measured=dataset.validation_status, required="valid")
            else:
                add("bids_validity", "BIDS validity", "fail", f"Dataset BIDS status is {dataset.validation_status}.", remediation="Fix BIDS errors and re-register or revalidate the dataset.", blocking=True, measured=dataset.validation_status, required="valid")

        license_params = set(policy.get("license_parameters", []))
        for parameter in manifest.get("parameters", []):
            name = parameter["name"]
            raw = params.get(name, parameter.get("default"))
            is_path = parameter.get("type") in {"file_path", "directory_path"}
            if parameter.get("required") and parameterized and (raw is None or raw == ""):
                add(f"required_input:{name}", f"Required input: {name}", "fail", f"Required parameter '{name}' is missing.", remediation="Provide the required input before launch.", blocking=True, measured="missing", required="provided")
                continue
            if name in license_params:
                if not parameterized:
                    add(f"license:{name}", "FreeSurfer license", "unknown", "Provide a license path to validate it.", remediation="Transfer license.txt separately; never add it to the repository.", measured="not selected", required="readable file")
                elif raw:
                    candidate = _path_for_parameter(raw)
                    valid = candidate.is_file() and os.access(candidate, os.R_OK) and candidate.stat().st_size > 0
                    add(f"license:{name}", "FreeSurfer license", "pass" if valid else "fail", "License file is present and readable; contents were not inspected." if valid else "License file is missing, empty, or unreadable.", remediation=None if valid else "Provide a non-empty readable FreeSurfer license.txt at the selected path.", blocking=not valid, measured="readable" if valid else "unavailable", required="readable non-empty file")
                continue
            if is_path and raw:
                candidate = _path_for_parameter(raw)
                expected_directory = parameter.get("type") == "directory_path"
                exists = candidate.is_dir() if expected_directory else candidate.is_file()
                readable = exists and os.access(candidate, os.R_OK)
                add(f"input_readable:{name}", f"Input readability: {name}", "pass" if readable else "fail", f"Input '{name}' is readable." if readable else f"Input '{name}' is missing or unreadable.", remediation=None if readable else "Choose an existing readable input path mounted into NeuroForge.", blocking=not readable, measured="readable" if readable else "unavailable", required="readable")

        data_root = Path(settings.data_dir).resolve()
        writable_root = data_root if data_root.exists() else data_root.parent
        writable = writable_root.exists() and os.access(writable_root, os.W_OK)
        add("output_writable", "Output directory", "pass" if writable else "fail", f"Output root is writable: {data_root}." if writable else f"Output root is not writable: {data_root}.", remediation=None if writable else "Create the data directory and grant the NeuroForge backend write permission.", blocking=not writable, measured=writable, required=True)

        try:
            free_gb = round(shutil.disk_usage(writable_root).free / 1024**3, 1)
        except OSError:
            free_gb = 0.0
        min_disk = float(resources.get("min_disk_free_gb", 0))
        add("disk_space", "Disk space", "pass" if free_gb >= min_disk else "fail", f"{free_gb} GB free disk space is available.", remediation=None if free_gb >= min_disk else "Increase the VM volume before starting the pipeline.", blocking=free_gb < min_disk, measured=free_gb, required=min_disk)

        for key, label in (("working_space_gb", "Expected working space"), ("output_space_gb", "Expected output space")):
            required_gb = float(resources.get(key, 0))
            enough = free_gb >= required_gb
            add(key, label, "pass" if enough else "fail", f"Expected requirement is {required_gb} GB; {free_gb} GB is free.", remediation=None if enough else "Increase free disk space before launch.", blocking=not enough, measured=free_gb, required=required_gb)

        ram_gb = round(psutil.virtual_memory().total / 1024**3, 1)
        min_ram = float(resources.get("min_ram_gb", 0))
        recommended_ram = float(resources.get("recommended_ram_gb", min_ram))
        ram_status = "fail" if ram_gb < min_ram else "warning" if ram_gb < recommended_ram else "pass"
        add("memory", "RAM", ram_status, f"{ram_gb} GB RAM detected.", remediation="Use a larger-memory VM or reduce supported concurrency." if ram_status != "pass" else None, blocking=ram_status == "fail", measured=ram_gb, required=min_ram)

        cpu_count = os.cpu_count() or 1
        min_cpu = int(resources.get("min_cpu_count", 1))
        recommended_cpu = int(resources.get("recommended_cpu_count", min_cpu))
        cpu_status = "fail" if cpu_count < min_cpu else "warning" if cpu_count < recommended_cpu else "pass"
        add("cpu_count", "CPU count", cpu_status, f"{cpu_count} logical CPUs detected.", remediation="Use a VM with more vCPUs." if cpu_status != "pass" else None, blocking=cpu_status == "fail", measured=cpu_count, required=min_cpu)

        ports = policy.get("ports", [])
        conflicts: list[int] = []
        for port in ports:
            with socket.socket() as sock:
                sock.settimeout(0.1)
                if sock.connect_ex(("127.0.0.1", int(port))) == 0:
                    conflicts.append(int(port))
        add("port_conflicts", "Port conflicts", "pass" if not conflicts else "fail", "No pipeline-specific ports are required." if not ports else ("Required ports are available." if not conflicts else f"Ports already in use: {conflicts}."), remediation=None if not conflicts else "Stop the conflicting service or change the port allocation.", blocking=bool(conflicts), measured=",".join(map(str, conflicts)) if conflicts else "none", required="available")

        return PipelinePreflightResponse(
            pipeline_id=manifest["id"],
            empirical_status=empirical,
            can_launch=not any(check.blocking and check.status == "fail" for check in checks),
            checks=checks,
        )
