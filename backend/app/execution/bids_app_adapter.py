"""Manifest-driven command and mount planning for BIDS Apps.

The adapter deliberately returns argv and structured mounts rather than a shell
string. Executors may render the plan for provenance or pass it directly to a
container runtime without shell interpolation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


@dataclass(frozen=True)
class BidsAppPlan:
    command: list[str]
    volumes: dict[str, dict[str, str]]
    environment: dict[str, str] = field(default_factory=dict)


def _value(parameter: dict[str, Any], params: dict[str, Any]) -> Any:
    value = params.get(parameter["name"])
    return parameter.get("default") if value is None or value == "" else value


def _labels(value: Any) -> list[str]:
    values = value if isinstance(value, list) else str(value or "").split()
    normalized: list[str] = []
    for raw in values:
        label = str(raw).strip()
        for prefix in ("sub-", "ses-", "task-", "run-"):
            if label.startswith(prefix):
                label = label[len(prefix) :]
                break
        if label:
            normalized.append(label)
    return normalized


def build_bids_app_plan(
    manifest: dict[str, Any],
    params: dict[str, Any],
    *,
    dataset_host: str,
    output_host: str,
    host_path: Callable[[str], str],
) -> BidsAppPlan:
    """Build a deterministic, shell-free BIDS App execution plan."""
    contract = manifest["contract"]["bids_app"]
    parameters = manifest.get("parameters", [])
    by_name = {item["name"]: item for item in parameters}
    analysis_name = contract.get("analysis_level_parameter", "analysis_level")
    analysis_level = str(_value(by_name[analysis_name], params))
    if analysis_level not in contract["analysis_levels"]:
        raise ValueError(
            f"Unsupported analysis level {analysis_level!r}; expected one of "
            + ", ".join(contract["analysis_levels"])
        )

    volumes = {
        dataset_host: {"bind": contract.get("input_mount", "/data"), "mode": "ro"},
        output_host: {"bind": contract.get("output_mount", "/out"), "mode": "rw"},
    }
    command = [
        contract.get("input_mount", "/data"),
        contract.get("output_mount", "/out"),
        analysis_level,
    ]
    work_name = contract.get("work_directory_parameter")
    mounted: dict[str, str] = {}
    if work_name and params.get(work_name):
        work_host = host_path(str(params[work_name]))
        work_mount = contract.get("work_mount", "/work")
        volumes[work_host] = {"bind": work_mount, "mode": "rw"}
        mounted[work_name] = work_mount

    label_parameters = {
        contract.get("participant_parameter"),
        contract.get("session_parameter"),
        contract.get("task_parameter"),
        contract.get("run_parameter"),
    } - {None}

    for parameter in parameters:
        name = parameter["name"]
        if parameter.get("internal") or name == analysis_name:
            continue
        value = _value(parameter, params)
        if value is None or value == "" or value == [] or value is False:
            continue
        flag = parameter.get("cli_flag") or f"--{name}"
        if name in mounted:
            command.extend([flag, mounted[name]])
        elif parameter.get("mount"):
            raw = str(value)
            source = host_path(raw)
            target = f"/inputs/{name}/{Path(raw).name}"
            volumes[source] = {"bind": target, "mode": "ro"}
            command.extend([flag, target])
        elif parameter["type"] == "boolean":
            command.append(flag)
        elif name in label_parameters:
            labels = _labels(value)
            if labels:
                command.extend([flag, *labels])
        elif parameter["type"] == "multiselect":
            command.extend([flag, *[str(item) for item in value]])
        elif parameter.get("multiple"):
            command.extend([flag, *str(value).split()])
        else:
            command.extend([flag, str(value)])

    environment = {
        str(key): str(value)
        for key, value in (contract.get("environment") or {}).items()
    }
    return BidsAppPlan(command=command, volumes=volumes, environment=environment)
