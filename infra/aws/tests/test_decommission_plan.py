from __future__ import annotations

import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / "infra/aws/scripts/lib/decommission_plan.py"
DEPLOYMENT = "nf-x86-test0001"
TAGS = [
    {"Key": "Project", "Value": "NeuroForge"},
    {"Key": "Purpose", "Value": "x86-verification"},
    {"Key": "ManagedBy", "Value": "NeuroForgeProvisioner"},
    {"Key": "DeploymentId", "Value": DEPLOYMENT},
]


def write(path: Path, value: dict) -> Path:
    path.write_text(json.dumps(value))
    return path


def fixture(tmp_path: Path) -> dict[str, Path]:
    archive = tmp_path / "evidence.zip"
    with zipfile.ZipFile(archive, "w") as handle:
        handle.writestr("evidence-manifest.json", json.dumps({"schema_version": 1, "files": []}))
    receipt = {
        "archive_path": str(archive),
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "opened_successfully": True,
    }
    state = {
        "deployment_id": DEPLOYMENT,
        "instance_id": "i-abc123",
        "root_volume_id": "vol-abc123",
        "security_group_id": "sg-abc123",
        "key_pair_name": f"neuroforge-{DEPLOYMENT}",
        "cloudshell_key_path": str(tmp_path / "key.pem"),
    }
    state["cloudshell_key_path"] = str(tmp_path / "key.pem")
    Path(state["cloudshell_key_path"]).write_text("not-a-real-key")
    return {
        "state": write(tmp_path / "state.json", state),
        "preflight": write(tmp_path / "preflight.json", {"cost": {"gp3_200_gib_month": 16.0, "snapshot_200_gib_upper_bound_month": 10.0}}),
        "instances": write(
            tmp_path / "instances.json",
            {"Reservations": [{"Instances": [{"InstanceId": "i-abc123", "State": {"Name": "stopped"}, "Tags": TAGS}]}]},
        ),
        "volumes": write(tmp_path / "volumes.json", {"Volumes": [{"VolumeId": "vol-abc123", "Tags": TAGS}]}),
        "security-group": write(tmp_path / "sg.json", {"SecurityGroups": [{"GroupId": "sg-abc123", "Tags": TAGS}]}),
        "key-pairs": write(tmp_path / "keys.json", {"KeyPairs": [{"KeyName": f"neuroforge-{DEPLOYMENT}", "Tags": TAGS}]}),
        "remote-status": write(tmp_path / "remote.json", {"services_running": False, "scientific_pipeline_active": False}),
        "evidence-receipt": write(tmp_path / "receipt.json", receipt),
    }


def run_plan(tmp_path: Path, docs: dict[str, Path], *extra: str) -> subprocess.CompletedProcess[str]:
    command = [str(HELPER)]
    for name, path in docs.items():
        command.extend([f"--{name}", str(path)])
    command.extend(["--volume-mode", "delete-root-volume", "--output", str(tmp_path / "plan.json"), *extra])
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True)


@pytest.mark.parametrize(
    ("mode", "monthly"),
    [
        ("delete-root-volume", 0.0),
        ("retain-root-volume", 16.0),
        ("snapshot-then-delete-volume", 10.0),
        ("retain-selected-volumes", 16.0),
    ],
)
def test_volume_modes_are_explicit_and_report_retained_cost(tmp_path: Path, mode: str, monthly: float) -> None:
    docs = fixture(tmp_path)
    command = [str(HELPER)]
    for name, path in docs.items():
        command.extend([f"--{name}", str(path)])
    command.extend(["--volume-mode", mode, "--output", str(tmp_path / "plan.json")])
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    plan = json.loads((tmp_path / "plan.json").read_text())
    assert plan["status"] == "GO"
    assert plan["mutations_performed"] is False
    assert plan["volume_mode"] == mode
    assert plan["continuing_monthly_estimate"] == monthly
    assert plan["evidence"]["verified"] is True


def test_missing_evidence_blocks_without_exact_override(tmp_path: Path) -> None:
    docs = fixture(tmp_path)
    docs.pop("evidence-receipt")
    result = run_plan(tmp_path, docs)
    assert result.returncode != 0
    assert "evidence" in result.stderr.lower()
    result = run_plan(
        tmp_path,
        docs,
        "--evidence-override",
        "I ACCEPT LOSS OF UNCOLLECTED EVIDENCE",
    )
    assert result.returncode == 0, result.stderr
    assert json.loads((tmp_path / "plan.json").read_text())["evidence"]["override"] is True


def test_active_pipeline_and_wrong_deployment_tag_block(tmp_path: Path) -> None:
    docs = fixture(tmp_path)
    docs["remote-status"].write_text(json.dumps({"scientific_pipeline_active": True}))
    result = run_plan(tmp_path, docs)
    assert result.returncode != 0
    assert "active scientific pipeline" in result.stderr

    docs = fixture(tmp_path)
    volumes = json.loads(docs["volumes"].read_text())
    next(item for item in volumes["Volumes"][0]["Tags"] if item["Key"] == "DeploymentId")["Value"] = "wrong"
    docs["volumes"].write_text(json.dumps(volumes))
    result = run_plan(tmp_path, docs)
    assert result.returncode != 0
    assert "ownership tags" in result.stderr


def test_partial_decommission_rerun_accepts_only_recorded_absence(tmp_path: Path) -> None:
    docs = fixture(tmp_path)
    docs["instances"].write_text(json.dumps({"Reservations": []}))
    docs["volumes"].write_text(json.dumps({"Volumes": []}))
    docs["security-group"].write_text(json.dumps({"SecurityGroups": []}))
    docs["key-pairs"].write_text(json.dumps({"KeyPairs": []}))
    docs["decommission-state"] = write(
        tmp_path / "decommission-state.json",
        {
            "schema_version": 1,
            "volume_mode": "delete-root-volume",
            "phases": [
                "instance-stopped",
                "instance-terminated",
                "volume-policy-complete",
                "network-and-aws-key-removed",
            ],
        },
    )
    result = run_plan(tmp_path, docs)
    assert result.returncode == 0, result.stderr
    plan = json.loads((tmp_path / "plan.json").read_text())
    assert plan["resume"] is True
    assert plan["instance_state"] == "absent"
    assert plan["root_volume_id"] == "vol-abc123"


def test_missing_resource_without_completed_phase_blocks(tmp_path: Path) -> None:
    docs = fixture(tmp_path)
    docs["security-group"].write_text(json.dumps({"SecurityGroups": []}))
    result = run_plan(tmp_path, docs)
    assert result.returncode != 0
    assert "missing without a completed phase" in result.stderr


def test_rerun_cannot_change_recorded_volume_mode(tmp_path: Path) -> None:
    docs = fixture(tmp_path)
    docs["decommission-state"] = write(
        tmp_path / "decommission-state.json",
        {"schema_version": 1, "volume_mode": "retain-root-volume", "phases": ["instance-stopped"]},
    )
    result = run_plan(tmp_path, docs)
    assert result.returncode != 0
    assert "volume mode differs" in result.stderr


def test_confirmation_and_emergency_stop_source_guards() -> None:
    decommission = (ROOT / "infra/aws/scripts/12-decommission.sh").read_text()
    emergency = (ROOT / "infra/aws/scripts/emergency-stop.sh").read_text()
    assert "TERMINATE ${INSTANCE_ID}" in decommission
    assert "DELETE VOLUMES ${VOLUME_ID}" in decommission
    assert "DELETE NEUROFORGE IAM ${RESOLVED_DEPLOYMENT_ID}" in decommission
    assert "DELETE LOCAL KEY" in decommission
    assert 'phase_complete "instance-terminated"' in decommission
    assert 'phase_complete "volume-policy-complete"' in decommission
    assert 'phase_complete "network-and-aws-key-removed"' in decommission
    assert 'phase_complete "owned-iam-removed"' in decommission
    assert "terminate-instances" not in emergency
    assert "delete-volume" not in emergency
    assert "delete-security-group" not in emergency
    assert "stop-instances" in emergency
    assert not (ROOT / "infra/aws/scripts/10-destroy.sh").exists()


def test_common_uses_bounded_standard_aws_retries() -> None:
    common = (ROOT / "infra/aws/scripts/lib/common.sh").read_text()
    assert 'AWS_RETRY_MODE="${AWS_RETRY_MODE:-standard}"' in common
    assert 'AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-5}"' in common
