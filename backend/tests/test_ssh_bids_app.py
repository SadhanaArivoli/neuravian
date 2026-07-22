from app.execution.executor import RunContext
from app.execution.ssh_executor import _build_remote_docker_cmd
from app.services.pipeline import get_registry


def test_remote_mriqc_command_matches_bids_app_semantics():
    ctx = RunContext(
        run_id=7,
        manifest=get_registry()["mriqc"],
        params={
            "analysis_level": "participant",
            "participant-label": "sub-01",
            "work-dir": "/local/work",
        },
        dataset_path="/local/bids",
        output_dir="/local/out",
    )
    command = _build_remote_docker_cmd(
        ctx,
        "/remote/input",
        "/remote/output",
        {},
        None,
    )
    assert "/remote/input:/data:ro" in command
    assert "/remote/output:/out:rw" in command
    assert "/remote/output_work:/work:rw" in command
    image_index = command.index("nipreps/mriqc:24.0.2")
    assert command[image_index + 1 :] == [
        "/data",
        "/out",
        "participant",
        "--participant-label",
        "01",
        "--nprocs",
        "1",
        "--omp-nthreads",
        "1",
        "--ants-float",
        "--work-dir",
        "/work",
        "--no-sub",
    ]
