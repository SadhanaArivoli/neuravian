from __future__ import annotations

import pytest

from app.execution.bids_app_adapter import build_bids_app_plan
from app.services.artifact_registry import resolve_run_artifacts
from app.services.pipeline import get_registry


def _plan(pipeline: str, params: dict):
    return build_bids_app_plan(
        get_registry()[pipeline],
        params,
        dataset_host="/host/bids",
        output_host="/host/out",
        host_path=lambda value: value,
    )


def test_mriqc_plan_is_deterministic_and_mounts_source_read_only():
    plan = _plan(
        "mriqc",
        {
            "analysis_level": "participant",
            "participant-label": "sub-02 01",
            "session-id": "ses-baseline",
            "nprocs": 2,
            "float32": True,
        },
    )
    assert plan.volumes["/host/bids"] == {"bind": "/data", "mode": "ro"}
    assert plan.volumes["/host/out"] == {"bind": "/out", "mode": "rw"}
    assert plan.command == [
        "/data",
        "/out",
        "participant",
        "--participant-label",
        "02",
        "01",
        "--session-id",
        "baseline",
        "--nprocs",
        "2",
        "--omp-nthreads",
        "1",
        "--ants-float",
        "--float32",
        "--no-sub",
    ]


def test_empty_and_false_values_are_not_emitted():
    plan = _plan(
        "mriqc",
        {
            "analysis_level": "participant",
            "participant-label": "",
            "modalities": [],
            "float32": False,
        },
    )
    assert "--participant-label" not in plan.command
    assert "--modalities" not in plan.command
    assert "--float32" not in plan.command
    assert "--no-sub" in plan.command


def test_work_directory_is_writable_and_uses_container_path():
    plan = _plan(
        "mriqc",
        {
            "analysis_level": "participant",
            "work-dir": "/host/work",
        },
    )
    assert plan.volumes["/host/work"] == {"bind": "/work", "mode": "rw"}
    index = plan.command.index("--work-dir")
    assert plan.command[index : index + 2] == ["--work-dir", "/work"]


def test_undeclared_analysis_level_is_rejected():
    with pytest.raises(ValueError, match="Unsupported analysis level"):
        _plan("mriqc", {"analysis_level": "group"})


def test_group_plan_uses_only_declared_group_arguments():
    plan = _plan("mriqc-group", {"analysis_level": "group", "no-sub": True})
    assert plan.command == [
        "/data",
        "/out",
        "group",
        "--no-sub",
        "--nprocs",
        "1",
        "--omp-nthreads",
        "1",
    ]


def test_fmriprep_plan_reuses_generic_adapter_for_labels_license_and_workdir():
    plan = _plan(
        "fmriprep",
        {
            "analysis_level": "participant",
            "participant-label": "sub-13",
            "session-label": "ses-baseline",
            "task-id": "task-balloon",
            "fs-license-file": "/host/license.txt",
            "work-dir": "/host/fmriprep-work",
            "output-spaces": ["MNI152NLin2009cAsym", "T1w"],
            "nprocs": 4,
            "mem": 16000,
            "fs-no-reconall": True,
        },
    )

    assert plan.volumes["/host/bids"] == {"bind": "/data", "mode": "ro"}
    assert plan.volumes["/host/out"] == {"bind": "/out", "mode": "rw"}
    assert plan.volumes["/host/fmriprep-work"] == {
        "bind": "/work",
        "mode": "rw",
    }
    assert plan.volumes["/host/license.txt"] == {
        "bind": "/inputs/fs-license-file/license.txt",
        "mode": "ro",
    }
    assert plan.command == [
        "/data",
        "/out",
        "participant",
        "--fs-license-file",
        "/inputs/fs-license-file/license.txt",
        "--participant-label",
        "13",
        "--session-label",
        "baseline",
        "--task-id",
        "balloon",
        "--skull-strip-t1w",
        "skip",
        "--fs-no-reconall",
        "--output-spaces",
        "MNI152NLin2009cAsym",
        "T1w",
        "--nprocs",
        "4",
        "--omp-nthreads",
        "1",
        "--mem",
        "16000",
        "--bold2anat-dof",
        "6",
        "--work-dir",
        "/work",
    ]


def test_fmriprep_manifest_discovers_declared_derivative_families(tmp_path):
    files = [
        "sub-13.html",
        "dataset_description.json",
        "sub-13/figures/sub-13_task-rest_desc-summary_bold.svg",
        "sub-13/func/sub-13_task-rest_desc-confounds_timeseries.tsv",
        "sub-13/func/sub-13_task-rest_desc-confounds_timeseries.json",
        "sub-13/anat/sub-13_from-T1w_to-MNI152NLin2009cAsym_mode-image_xfm.h5",
    ]
    for relative in files:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("qualification fixture", encoding="utf-8")

    artifacts = resolve_run_artifacts(
        get_registry()["fmriprep"],
        str(tmp_path),
        {},
        "success",
    )
    by_type = {artifact.type: artifact for artifact in artifacts}
    assert by_type["fmriprep_derivatives"].resolved
    assert by_type["html_report"].paths == [str(tmp_path / "sub-13.html")]
    assert by_type["quality_control_figure"].paths == [
        str(tmp_path / files[2])
    ]
    assert by_type["statistics_table"].paths == [str(tmp_path / files[3])]
    assert by_type["spatial_transform"].paths == [str(tmp_path / files[5])]
    assert by_type["structured_metadata"].paths == [
        str(tmp_path / "dataset_description.json"),
        str(tmp_path / files[4]),
    ]
