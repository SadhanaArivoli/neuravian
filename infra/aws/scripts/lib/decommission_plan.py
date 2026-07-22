#!/usr/bin/env python3
"""Validate decommission safety inputs and render a restartable destruction plan."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


MODES = {
    "delete-root-volume",
    "retain-root-volume",
    "snapshot-then-delete-volume",
    "retain-selected-volumes",
}


class DecommissionError(ValueError):
    pass


def load(path: Path) -> Any:
    return json.loads(path.read_text())


def tag_map(items: list[dict[str, str]]) -> dict[str, str]:
    return {item["Key"]: item["Value"] for item in items}


def verify_tags(items: list[dict[str, str]], deployment_id: str) -> None:
    actual = tag_map(items)
    required = {
        "Project": "Neuravian",
        "Purpose": "x86-verification",
        "ManagedBy": "NeuravianProvisioner",
        "DeploymentId": deployment_id,
    }
    if any(actual.get(key) != value for key, value in required.items()):
        raise DecommissionError("resource ownership tags do not match state")


def verify_evidence(receipt_path: Path | None, override: str) -> dict[str, Any]:
    if receipt_path is None or not receipt_path.is_file():
        if override == "I ACCEPT LOSS OF UNCOLLECTED EVIDENCE":
            return {"verified": False, "override": True}
        raise DecommissionError("verified local evidence receipt is required")
    receipt = load(receipt_path)
    archive = Path(receipt.get("archive_path", ""))
    if not archive.is_file() or receipt.get("opened_successfully") is not True:
        raise DecommissionError("evidence archive is missing or was not opened successfully")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != receipt.get("sha256"):
        raise DecommissionError("evidence archive checksum differs from receipt")
    with zipfile.ZipFile(archive) as handle:
        if handle.testzip() is not None:
            raise DecommissionError("evidence ZIP integrity check failed")
        json.loads(handle.read("evidence-manifest.json"))
    return {"verified": True, "override": False, "archive_path": str(archive), "sha256": digest}


def write_private(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--preflight", type=Path, required=True)
    parser.add_argument("--instances", type=Path, required=True)
    parser.add_argument("--volumes", type=Path, required=True)
    parser.add_argument("--security-group", type=Path, required=True)
    parser.add_argument("--key-pairs", type=Path, required=True)
    parser.add_argument("--remote-status", type=Path, required=True)
    parser.add_argument("--evidence-receipt", type=Path)
    parser.add_argument("--decommission-state", type=Path)
    parser.add_argument("--evidence-override", default="")
    parser.add_argument("--volume-mode", choices=sorted(MODES), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        state = load(args.state)
        preflight = load(args.preflight)
        deployment = state["deployment_id"]
        progress = (
            load(args.decommission_state)
            if args.decommission_state and args.decommission_state.is_file()
            else {"phases": []}
        )
        phases = set(progress.get("phases", []))
        if progress.get("volume_mode") not in {None, args.volume_mode}:
            raise DecommissionError("volume mode differs from the in-progress decommission")
        evidence = verify_evidence(args.evidence_receipt, args.evidence_override)
        instances = [
            item
            for reservation in load(args.instances).get("Reservations", [])
            for item in reservation.get("Instances", [])
        ]
        instance_done = "instance-terminated" in phases
        if len(instances) > 1:
            raise DecommissionError("multiple instances matched exact state")
        if instances:
            instance = instances[0]
            if instance.get("InstanceId") != state["instance_id"]:
                raise DecommissionError("instance differs from state")
            verify_tags(instance.get("Tags", []), deployment)
            instance_state = instance.get("State", {}).get("Name", "unknown")
        elif instance_done:
            instance = None
            instance_state = "absent"
        else:
            raise DecommissionError("exact state-recorded instance was not found")
        remote = load(args.remote_status)
        if remote.get("scientific_pipeline_active") is True:
            raise DecommissionError("an active scientific pipeline blocks decommissioning")
        if remote.get("scientific_pipeline_active") not in {False}:
            raise DecommissionError("scientific pipeline state is unknown")
        volumes = load(args.volumes).get("Volumes", [])
        if len(volumes) > 1:
            raise DecommissionError("multiple volumes matched exact state")
        volume_done = "volume-policy-complete" in phases
        deletion_mode = args.volume_mode in {"delete-root-volume", "snapshot-then-delete-volume"}
        if volumes:
            volume = volumes[0]
            verify_tags(volume.get("Tags", []), deployment)
            if volume.get("VolumeId") != state.get("root_volume_id"):
                raise DecommissionError("root volume differs from state")
        elif (volume_done or instance_done) and deletion_mode:
            volume = None
        else:
            raise DecommissionError("expected the exact managed volume")
        groups = load(args.security_group).get("SecurityGroups", [])
        network_done = "network-and-aws-key-removed" in phases
        if len(groups) > 1:
            raise DecommissionError("multiple security groups matched exact state")
        if groups:
            if groups[0].get("GroupId") != state["security_group_id"]:
                raise DecommissionError("security group differs from state")
            verify_tags(groups[0].get("Tags", []), deployment)
        elif not network_done:
            raise DecommissionError("security group is missing without a completed phase")
        keys = load(args.key_pairs).get("KeyPairs", [])
        if len(keys) > 1:
            raise DecommissionError("multiple key pairs matched exact state")
        if keys:
            if keys[0].get("KeyName") != state["key_pair_name"]:
                raise DecommissionError("key pair differs from state")
            if keys[0].get("Tags"):
                verify_tags(keys[0]["Tags"], deployment)
        elif not network_done:
            raise DecommissionError("key pair is missing without a completed phase")

        volume_id = state["root_volume_id"]
        monthly = preflight["cost"]["gp3_200_gib_month"]
        retained_monthly = monthly if args.volume_mode in {"retain-root-volume", "retain-selected-volumes"} else 0.0
        if args.volume_mode == "snapshot-then-delete-volume":
            retained_monthly = preflight["cost"]["snapshot_200_gib_upper_bound_month"]
        plan = {
            "schema_version": 1,
            "created_at": datetime.now(UTC).isoformat(),
            "status": "GO",
            "execution_location": "CLOUDSHELL",
            "mutations_performed": False,
            "deployment_id": deployment,
            "instance_id": state["instance_id"],
            "instance_state": instance_state,
            "root_volume_id": volume_id,
            "security_group_id": state["security_group_id"],
            "key_pair_name": state["key_pair_name"],
            "volume_mode": args.volume_mode,
            "evidence": evidence,
            "remote_status": remote,
            "completed_phases": sorted(phases),
            "resume": bool(phases),
            "confirmations": {
                "terminate": f"TERMINATE {state['instance_id']}",
                "delete_volumes": f"DELETE VOLUMES {volume_id}",
                "delete_iam": f"DELETE NEURAVIAN IAM {deployment}",
                "delete_local_key": f"DELETE LOCAL KEY {Path(state['cloudshell_key_path']).name}",
            },
            "dependency_order": [
                "verify evidence locally",
                "verify no scientific pipeline is active",
                "stop Neuravian services and instance",
                "apply selected volume policy",
                "disable termination protection",
                "terminate exact instance and wait",
                "wait for ENI detachment",
                "delete or retain volume/snapshot as selected",
                "delete dedicated security group",
                "delete AWS key pair",
                "optionally delete local PEM",
                "remove instance profile, roles, and owned policy",
                "run independent residual-resource verification",
            ],
            "continuing_monthly_estimate": retained_monthly,
            "warnings": [
                "Billing reports can lag resource deletion.",
                "A retained volume or snapshot continues charging.",
                "Live account identifiers remain only in ignored private state.",
            ],
        }
        write_private(args.output, plan)
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, KeyError, TypeError, zipfile.BadZipFile, DecommissionError) as exc:
        print(f"DECOMMISSION PLAN ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
