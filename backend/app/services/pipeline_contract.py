"""Normalized semantic contract for pipeline manifests.

The YAML schema validates shape. This module supplies conservative defaults and
cross-field validation so execution, reporting, and UI clients can consume one
stable contract without embedding pipeline-specific assumptions.
"""

from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

CONTRACT_VERSION = 1

_DEFAULT_CONTRACT: dict[str, Any] = {
    "version": CONTRACT_VERSION,
    "unit_of_work": "dataset",
    "lifecycle": {
        "expected_duration_minutes": None,
        "heartbeat_timeout_minutes": None,
        "cancellation_grace_seconds": 30,
        "retry_mode": "fresh",
        "resume_strategy": "none",
        "checkpoint_paths": [],
        "preserve_work_directory": False,
    },
    "progress": {"strategy": "tqdm", "patterns": [], "stages": []},
    "bids_app": None,
    "reporting": {
        "html_globs": ["**/*.html"],
        "figure_globs": ["**/*.png", "**/*.svg"],
        "metric_globs": ["**/*.json", "**/*.tsv"],
        "qc_artifact_types": [],
    },
    "methods": None,
}


def normalized_contract(manifest: dict[str, Any]) -> dict[str, Any]:
    """Return a complete v1 contract without mutating the manifest."""
    result = deepcopy(_DEFAULT_CONTRACT)
    declared = manifest.get("contract") or {}
    for key in ("version", "unit_of_work", "bids_app", "methods"):
        if key in declared:
            result[key] = deepcopy(declared[key])
    for section in ("lifecycle", "progress", "reporting"):
        result[section].update(deepcopy(declared.get(section) or {}))
    if manifest.get("max_runtime_hours") is not None:
        result["lifecycle"]["maximum_duration_minutes"] = int(
            float(manifest["max_runtime_hours"]) * 60
        )
    else:
        result["lifecycle"]["maximum_duration_minutes"] = None
    return result


def contract_capabilities(manifest: dict[str, Any]) -> dict[str, bool]:
    """Expose lifecycle capabilities consistently to API and UI consumers."""
    contract = normalized_contract(manifest)
    lifecycle = contract["lifecycle"]
    return {
        "progress": contract["progress"]["strategy"] != "none",
        "cancellation": True,
        "retry": True,
        "resume": lifecycle["resume_strategy"] != "none",
        "checkpoints": bool(lifecycle["checkpoint_paths"]),
        "bids_app": contract["bids_app"] is not None,
        "reports": bool(contract["reporting"]["html_globs"]),
        "methods": contract["methods"] is not None,
    }


def validate_contract(manifest: dict[str, Any]) -> list[str]:
    """Return semantic errors not expressible cleanly in JSON Schema."""
    errors: list[str] = []
    contract = normalized_contract(manifest)
    params = {item["name"] for item in manifest.get("parameters", [])}
    artifact_types = {
        item.get("type") for item in manifest.get("produces", []) if item.get("type")
    }

    lifecycle = contract["lifecycle"]
    if lifecycle["retry_mode"] == "resume" and lifecycle["resume_strategy"] == "none":
        errors.append("retry_mode 'resume' requires a non-'none' resume_strategy")
    if (
        lifecycle["resume_strategy"] == "checkpoint"
        and not lifecycle["checkpoint_paths"]
    ):
        errors.append("checkpoint resume requires at least one checkpoint_path")

    progress = contract["progress"]
    if progress["strategy"] == "regex" and not progress["patterns"]:
        errors.append("regex progress requires at least one pattern")
    if progress["strategy"] == "stages" and not progress["stages"]:
        errors.append("staged progress requires at least one stage")
    for entry in [*progress["patterns"], *progress["stages"]]:
        try:
            re.compile(entry["pattern"])
        except re.error as exc:
            errors.append(f"invalid progress regex {entry['pattern']!r}: {exc}")

    methods = contract.get("methods") or {}
    version_pattern = methods.get("runtime_version_pattern")
    if version_pattern:
        try:
            compiled_version = re.compile(version_pattern)
            if "version" not in compiled_version.groupindex:
                errors.append(
                    "runtime_version_pattern requires a named 'version' group"
                )
        except re.error as exc:
            errors.append(f"invalid runtime version regex {version_pattern!r}: {exc}")

    bids_app = contract["bids_app"]
    if bids_app:
        for field in (
            "analysis_level_parameter",
            "participant_parameter",
            "session_parameter",
            "task_parameter",
            "run_parameter",
            "work_directory_parameter",
        ):
            value = bids_app.get(field)
            if value and value not in params:
                errors.append(
                    f"bids_app.{field} references unknown parameter {value!r}"
                )
        analysis_name = bids_app.get("analysis_level_parameter")
        if analysis_name is None and "analysis_level" in params:
            analysis_name = "analysis_level"
        if analysis_name is not None:
            analysis_param = next(
                (
                    item
                    for item in manifest.get("parameters", [])
                    if item["name"] == analysis_name
                ),
                None,
            )
            if analysis_param is None:
                errors.append(
                    f"bids_app analysis parameter {analysis_name!r} is not declared"
                )
            else:
                unsupported = set(analysis_param.get("options", [])) - set(
                    bids_app["analysis_levels"]
                )
                if unsupported:
                    errors.append(
                        "analysis parameter exposes undeclared levels: "
                        + ", ".join(sorted(unsupported))
                    )

    unknown_qc = set(contract["reporting"]["qc_artifact_types"]) - artifact_types
    if unknown_qc:
        errors.append(
            "reporting.qc_artifact_types must reference produces[].type: "
            + ", ".join(sorted(unknown_qc))
        )
    return errors
