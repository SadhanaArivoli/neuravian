#!/usr/bin/env python3
"""Validate the provisioned EC2 control-plane shape without mutation."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


class VerifyError(ValueError):
    pass


def load(path: Path) -> Any:
    return json.loads(path.read_text())


def tags(items: list[dict[str, str]]) -> dict[str, str]:
    return {item["Key"]: item["Value"] for item in items}


def main() -> int:
    parser = argparse.ArgumentParser()
    for name in ("state", "preflight", "instances", "termination", "security_group", "volume"):
        parser.add_argument(f"--{name.replace('_', '-')}", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        state = load(args.state)
        preflight = load(args.preflight)
        reservations = load(args.instances).get("Reservations", [])
        instances = [item for reservation in reservations for item in reservation.get("Instances", [])]
        if len(instances) != 1:
            raise VerifyError("expected exactly one instance")
        instance = instances[0]
        expected_tags = preflight["required_tags"]
        if instance.get("InstanceId") != state["instance_id"]:
            raise VerifyError("instance ID differs from state")
        if instance.get("State", {}).get("Name") != "running":
            raise VerifyError("instance is not running")
        if instance.get("InstanceType") != "m7i.2xlarge":
            raise VerifyError("instance type mismatch")
        if instance.get("ImageId") != preflight["ami"]["ami_id"]:
            raise VerifyError("AMI mismatch")
        if instance.get("SubnetId") != preflight["network"]["subnet_id"]:
            raise VerifyError("subnet mismatch")
        if instance.get("Architecture") != "x86_64":
            raise VerifyError("instance architecture is not x86_64")
        if tags(instance.get("Tags", [])) | expected_tags != tags(instance.get("Tags", [])):
            raise VerifyError("instance ownership tags mismatch")
        metadata = instance.get("MetadataOptions", {})
        if metadata.get("HttpTokens") != "required" or metadata.get("HttpPutResponseHopLimit") != 1:
            raise VerifyError("IMDSv2 configuration mismatch")
        groups = instance.get("SecurityGroups", [])
        if [item.get("GroupId") for item in groups] != [state["security_group_id"]]:
            raise VerifyError("instance must have exactly one owned security group")
        profile = instance.get("IamInstanceProfile", {}).get("Arn", "")
        if not profile.endswith(f"/NeuroForgeInstance-{state['deployment_id']}"):
            raise VerifyError("instance profile mismatch")
        public_ip = instance.get("PublicIpAddress", "")
        if not public_ip:
            raise VerifyError("instance has no public IPv4")
        mappings = instance.get("BlockDeviceMappings", [])
        if len(mappings) != 1 or mappings[0].get("Ebs", {}).get("DeleteOnTermination") is not True:
            raise VerifyError("root volume DeleteOnTermination must be true")
        volume_id = mappings[0]["Ebs"]["VolumeId"]

        termination = load(args.termination)
        if termination.get("DisableApiTermination", {}).get("Value") is not True:
            raise VerifyError("termination protection is not enabled")
        volumes = load(args.volume).get("Volumes", [])
        if len(volumes) != 1 or volumes[0].get("VolumeId") != volume_id:
            raise VerifyError("root volume lookup mismatch")
        volume = volumes[0]
        if not (
            volume.get("Encrypted") is True
            and volume.get("Size") == 200
            and volume.get("VolumeType") == "gp3"
            and volume.get("Iops") == 3000
            and volume.get("Throughput") == 125
        ):
            raise VerifyError("root volume shape/encryption mismatch")
        if tags(volume.get("Tags", [])) | expected_tags != tags(volume.get("Tags", [])):
            raise VerifyError("volume ownership tags mismatch")

        groups = load(args.security_group).get("SecurityGroups", [])
        if len(groups) != 1 or groups[0].get("GroupId") != state["security_group_id"]:
            raise VerifyError("security-group lookup mismatch")
        group = groups[0]
        if tags(group.get("Tags", [])) | expected_tags != tags(group.get("Tags", [])):
            raise VerifyError("security-group ownership tags mismatch")
        permissions = group.get("IpPermissions", [])
        expected_cidr = preflight["network"]["ssh_allowed_cidr"]
        if permissions != [
            {
                "FromPort": 22,
                "IpProtocol": "tcp",
                "IpRanges": [{"CidrIp": expected_cidr, "Description": "NeuroForge-x86-operator"}],
                "Ipv6Ranges": [],
                "PrefixListIds": [],
                "ToPort": 22,
                "UserIdGroupPairs": [],
            }
        ]:
            raise VerifyError("security-group ingress is not exact SSH /32")

        result = {
            "schema_version": 1,
            "status": "GO",
            "instance_id": state["instance_id"],
            "public_ip": public_ip,
            "volume_id": volume_id,
            "control_plane_verified": True,
            "instance_type": "m7i.2xlarge",
            "architecture": "x86_64",
            "ami_owner_verified_by_preflight": preflight["ami"]["owner_verified"],
            "imds": {"http_tokens": "required", "hop_limit": 1},
            "root_volume": {"size_gib": 200, "type": "gp3", "encrypted": True, "delete_on_termination": True},
            "ingress": {"protocol": "tcp", "port": 22, "cidr": expected_cidr},
            "public_application_ports": [],
        }
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        args.output.chmod(0o600)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, KeyError, TypeError, VerifyError) as exc:
        print(f"INSTANCE VERIFY ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
