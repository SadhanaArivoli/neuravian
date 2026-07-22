#!/usr/bin/env python3
"""Render and validate the exact EC2 run-instances request and user-data."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


class ProvisionError(ValueError):
    pass


def load(path: Path) -> Any:
    return json.loads(path.read_text())


def write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(data)
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def tags(deployment_id: str, name: str) -> list[dict[str, str]]:
    return [
        {"Key": "Name", "Value": name},
        {"Key": "Project", "Value": "Neuravian"},
        {"Key": "Purpose", "Value": "x86-verification"},
        {"Key": "ManagedBy", "Value": "NeuravianProvisioner"},
        {"Key": "DeploymentId", "Value": deployment_id},
    ]


def render_user_data(template: str, vm_commit: str, baseline: str, prepull: bool) -> str:
    replacements = {
        "__NEURAVIAN_VM_COMMIT__": vm_commit,
        "__APPLICATION_BASELINE_COMMIT__": baseline,
        "__PREPULL_IMAGES__": str(prepull).lower(),
    }
    rendered = template
    for token, value in replacements.items():
        rendered = rendered.replace(token, value)
    if re.search(r"__[A-Z0-9_]+__", rendered):
        raise ProvisionError("unresolved user-data token")
    forbidden = ("license.txt", "AWS_SECRET_ACCESS_KEY", "BEGIN PRIVATE KEY", "/Users/")
    if any(value in rendered for value in forbidden):
        raise ProvisionError("user-data contains a forbidden secret or private path marker")
    return rendered


def validate(request: dict[str, Any], expected: dict[str, Any]) -> None:
    if request.get("MinCount") != 1 or request.get("MaxCount") != 1:
        raise ProvisionError("run-instances must request exactly one instance")
    if request.get("InstanceType") != "m7i.2xlarge":
        raise ProvisionError("instance type must be m7i.2xlarge")
    if request.get("ImageId") != expected["ami_id"]:
        raise ProvisionError("request AMI differs from verified preflight AMI")
    interfaces = request.get("NetworkInterfaces", [])
    if interfaces != [
        {
            "AssociatePublicIpAddress": True,
            "DeleteOnTermination": True,
            "DeviceIndex": 0,
            "Groups": [expected["security_group_id"]],
            "SubnetId": expected["subnet_id"],
        }
    ]:
        raise ProvisionError("request must use one public interface in the verified subnet and security group")
    if request.get("MetadataOptions") != {
        "HttpEndpoint": "enabled",
        "HttpTokens": "required",
        "HttpPutResponseHopLimit": 1,
        "InstanceMetadataTags": "disabled",
    }:
        raise ProvisionError("IMDSv2 tokens/hop-limit configuration is invalid")
    if request.get("DisableApiTermination") is not True:
        raise ProvisionError("termination protection must be enabled")
    if request.get("InstanceInitiatedShutdownBehavior") != "stop":
        raise ProvisionError("shutdown behavior must be stop")
    mappings = request.get("BlockDeviceMappings", [])
    if len(mappings) != 1:
        raise ProvisionError("exactly one root block device is required")
    ebs = mappings[0].get("Ebs", {})
    if ebs != {
        "DeleteOnTermination": True,
        "Encrypted": True,
        "Iops": 3000,
        "Throughput": 125,
        "VolumeSize": 200,
        "VolumeType": "gp3",
    }:
        raise ProvisionError("root volume must be encrypted 200-GiB gp3 with DeleteOnTermination=true")
    tag_specs = {item["ResourceType"]: item["Tags"] for item in request.get("TagSpecifications", [])}
    if set(tag_specs) != {"instance", "volume", "network-interface"}:
        raise ProvisionError("instance, volume, and network-interface tag specifications are required")
    for resource_tags in tag_specs.values():
        mapping = {item["Key"]: item["Value"] for item in resource_tags}
        for key in ("Project", "Purpose", "ManagedBy", "DeploymentId"):
            if mapping.get(key) != expected["tags"][key]:
                raise ProvisionError(f"missing required {key} tag")
    if any(key in request for key in ("ElasticGpuSpecification", "ElasticInferenceAccelerators")):
        raise ProvisionError("GPU resources are forbidden")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", type=Path, required=True)
    parser.add_argument("--iam-plan", type=Path, required=True)
    parser.add_argument("--user-data-template", type=Path, required=True)
    parser.add_argument("--security-group-id", required=True)
    parser.add_argument("--prepull-images", choices=("true", "false"), default="false")
    parser.add_argument("--output-request", type=Path, required=True)
    parser.add_argument("--output-user-data", type=Path, required=True)
    args = parser.parse_args()
    try:
        preflight = load(args.preflight)
        iam = load(args.iam_plan)
        if preflight.get("status") != "GO" or iam.get("status") != "GO":
            raise ProvisionError("preflight and IAM plan must both be GO")
        if preflight["deployment_id"] != iam["deployment_id"]:
            raise ProvisionError("deployment IDs differ")
        if not re.fullmatch(r"sg-(?:planned|[0-9a-f])[0-9a-f]*", args.security_group_id):
            raise ProvisionError("invalid security-group identifier")
        deployment_id = preflight["deployment_id"]
        name = f"neuravian-{deployment_id}"
        rendered_user_data = render_user_data(
            args.user_data_template.read_text(),
            preflight["commits"]["vm"],
            preflight["commits"]["application_baseline"],
            args.prepull_images == "true",
        )
        common_tags = {**preflight["required_tags"]}
        request = {
            "ImageId": preflight["ami"]["ami_id"],
            "InstanceType": "m7i.2xlarge",
            "MinCount": 1,
            "MaxCount": 1,
            "KeyName": name,
            "NetworkInterfaces": [
                {
                    "AssociatePublicIpAddress": True,
                    "DeleteOnTermination": True,
                    "DeviceIndex": 0,
                    "Groups": [args.security_group_id],
                    "SubnetId": preflight["network"]["subnet_id"],
                }
            ],
            "Placement": {"AvailabilityZone": preflight["network"]["availability_zone"]},
            "IamInstanceProfile": {"Name": iam["instance_profile_name"]},
            "BlockDeviceMappings": [
                {
                    "DeviceName": preflight["ami"].get("root_device_name", "/dev/sda1"),
                    "Ebs": {
                        "DeleteOnTermination": True,
                        "Encrypted": True,
                        "Iops": 3000,
                        "Throughput": 125,
                        "VolumeSize": 200,
                        "VolumeType": "gp3",
                    },
                }
            ],
            "MetadataOptions": {
                "HttpEndpoint": "enabled",
                "HttpTokens": "required",
                "HttpPutResponseHopLimit": 1,
                "InstanceMetadataTags": "disabled",
            },
            "DisableApiTermination": True,
            "InstanceInitiatedShutdownBehavior": "stop",
            "Monitoring": {"Enabled": False},
            "EbsOptimized": True,
            "ClientToken": deployment_id,
            "UserData": base64.b64encode(rendered_user_data.encode()).decode(),
            "TagSpecifications": [
                {"ResourceType": resource_type, "Tags": tags(deployment_id, name)}
                for resource_type in ("instance", "volume", "network-interface")
            ],
        }
        validate(
            request,
            {
                "ami_id": preflight["ami"]["ami_id"],
                "subnet_id": preflight["network"]["subnet_id"],
                "security_group_id": args.security_group_id,
                "tags": common_tags,
            },
        )
        write_private(args.output_user_data, rendered_user_data.encode())
        write_private(args.output_request, (json.dumps(request, indent=2, sort_keys=True) + "\n").encode())
        print(
            json.dumps(
                {
                    "status": "GO",
                    "request": str(args.output_request),
                    "request_sha256": hashlib.sha256(args.output_request.read_bytes()).hexdigest(),
                    "user_data": str(args.output_user_data),
                    "security_group_id_is_plan_placeholder": args.security_group_id.startswith("sg-planned"),
                    "mutations_performed": False,
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ProvisionError) as exc:
        print(f"PROVISION PLAN ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
