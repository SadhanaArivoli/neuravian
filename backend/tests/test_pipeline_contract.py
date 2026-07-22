import re

from app.services.pipeline_contract import (
    contract_capabilities,
    normalized_contract,
    validate_contract,
)


def manifest(**contract):
    return {
        "id": "example",
        "parameters": [{"name": "participant-label", "type": "string"}],
        "produces": [{"type": "html_report", "label": "Report"}],
        "contract": {"version": 1, **contract},
    }


def test_legacy_manifest_gets_conservative_defaults():
    contract = normalized_contract({"max_runtime_hours": 20})
    assert contract["version"] == 1
    assert contract["lifecycle"]["retry_mode"] == "fresh"
    assert contract["lifecycle"]["resume_strategy"] == "none"
    assert contract["lifecycle"]["maximum_duration_minutes"] == 1200
    assert contract["reporting"]["html_globs"] == ["**/*.html"]


def test_capabilities_follow_declared_contract():
    value = manifest(
        lifecycle={
            "retry_mode": "resume",
            "resume_strategy": "checkpoint",
            "checkpoint_paths": ["work/checkpoint.json"],
        },
        bids_app={
            "analysis_levels": ["participant"],
            "participant_parameter": "participant-label",
        },
        methods={"summary": "Processed with {display_name} {version}."},
    )
    assert validate_contract(value) == []
    assert contract_capabilities(value) == {
        "progress": True,
        "cancellation": True,
        "retry": True,
        "resume": True,
        "checkpoints": True,
        "bids_app": True,
        "reports": True,
        "methods": True,
    }


def test_contract_rejects_invalid_cross_references():
    value = manifest(
        lifecycle={"retry_mode": "resume", "resume_strategy": "none"},
        progress={"strategy": "regex", "patterns": []},
        bids_app={
            "analysis_levels": ["participant"],
            "session_parameter": "session-label",
        },
        reporting={"qc_artifact_types": ["unknown"]},
    )
    errors = validate_contract(value)
    assert any("retry_mode" in error for error in errors)
    assert any("regex progress" in error for error in errors)
    assert any("session-label" in error for error in errors)
    assert any("qc_artifact_types" in error for error in errors)


def test_fmriprep_declares_complete_v1_bids_app_contract():
    from app.services.pipeline import get_registry

    fmriprep = get_registry()["fmriprep"]
    assert validate_contract(fmriprep) == []
    assert contract_capabilities(fmriprep) == {
        "progress": True,
        "cancellation": True,
        "retry": True,
        "resume": False,
        "checkpoints": False,
        "bids_app": True,
        "reports": True,
        "methods": True,
    }
    reporting = normalized_contract(fmriprep)["reporting"]
    assert reporting["html_globs"] == ["sub-*.html"]
    assert "sub-*/**/*.tsv" in reporting["metric_globs"]
    assert "sub-*/**/*.json" in reporting["metric_globs"]
    version_pattern = fmriprep["contract"]["methods"]["runtime_version_pattern"]
    assert re.search(version_pattern, "fMRIPrep v25.2.5").group("version") == "25.2.5"
    assert (
        re.search(version_pattern, "Running fMRIPrep version 25.2.5").group(
            "version"
        )
        == "25.2.5"
    )
