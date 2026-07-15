#!/usr/bin/env python3
"""Validate read-only AWS responses and render NeuroForge deployment plans."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


CANONICAL_OWNER_SHA256 = "2bf6b89161f25119eb9937dd6beec8c86b9c354e32fdd85411f10173d537468c"
REQUIRED_TAGS = {
    "Project": "NeuroForge",
    "Purpose": "x86-verification",
    "ManagedBy": "NeuroForgeProvisioner",
}
BOOTSTRAP_IAM_ACTIONS = {
    "access-analyzer:ValidatePolicy",
    "iam:AddRoleToInstanceProfile",
    "iam:AttachRolePolicy",
    "iam:CreateInstanceProfile",
    "iam:CreatePolicy",
    "iam:CreatePolicyVersion",
    "iam:CreateRole",
    "iam:DeletePolicyVersion",
    "iam:DeleteRole",
    "iam:GetInstanceProfile",
    "iam:GetPolicy",
    "iam:GetPolicyVersion",
    "iam:GetRole",
    "iam:ListAttachedRolePolicies",
    "iam:ListPolicyVersions",
    "iam:ListRolePolicies",
    "iam:SetDefaultPolicyVersion",
    "iam:TagInstanceProfile",
    "iam:TagPolicy",
    "iam:TagRole",
    "iam:UpdateAssumeRolePolicy",
}


class PlanError(ValueError):
    """A fail-closed plan validation error."""


def load(path: str | Path) -> Any:
    return json.loads(Path(path).read_text())


def write_private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)
    path.chmod(0o600)


def expected_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise PlanError(f"missing environment value: {name}")
    return value


def parse_price(document: dict[str, Any], unit: str) -> float:
    values: list[float] = []
    for encoded in document.get("PriceList", []):
        product = json.loads(encoded) if isinstance(encoded, str) else encoded
        for term in product.get("terms", {}).get("OnDemand", {}).values():
            for dimension in term.get("priceDimensions", {}).values():
                if dimension.get("unit") != unit:
                    continue
                usd = dimension.get("pricePerUnit", {}).get("USD")
                if usd is not None:
                    values.append(float(usd))
    positive = sorted({value for value in values if value > 0})
    if len(positive) != 1:
        raise PlanError(f"expected one positive {unit} price, found {positive}")
    return positive[0]


def choose_vpc(document: dict[str, Any], configured: str) -> str:
    candidates = [
        item
        for item in document.get("Vpcs", [])
        if item.get("State") == "available"
        and (configured == "auto" and item.get("IsDefault") is True
             or configured != "auto" and item.get("VpcId") == configured)
    ]
    if len(candidates) != 1:
        raise PlanError(f"expected exactly one eligible VPC, found {len(candidates)}")
    return str(candidates[0]["VpcId"])


def choose_subnet(document: dict[str, Any], configured: str) -> dict[str, str]:
    candidates = [
        item
        for item in document.get("Subnets", [])
        if item.get("State") == "available"
        and item.get("MapPublicIpOnLaunch") is True
        and (configured == "auto" or item.get("SubnetId") == configured)
    ]
    if not candidates:
        raise PlanError("no available public subnet assigns public IPv4 addresses")
    item = sorted(candidates, key=lambda entry: (entry["AvailabilityZone"], entry["SubnetId"]))[0]
    return {"subnet_id": str(item["SubnetId"]), "availability_zone": str(item["AvailabilityZone"])}


def validate_ami(document: dict[str, Any], expected_id: str) -> dict[str, str]:
    images = document.get("Images", [])
    if len(images) != 1:
        raise PlanError("AMI lookup did not return exactly one image")
    image = images[0]
    owner_hash = hashlib.sha256(str(image.get("OwnerId", "")).encode()).hexdigest()
    checks = {
        "id": image.get("ImageId") == expected_id,
        "owner": owner_hash == CANONICAL_OWNER_SHA256,
        "architecture": image.get("Architecture") == "x86_64",
        "state": image.get("State") == "available",
        "root_device": image.get("RootDeviceType") == "ebs",
        "root_device_name": str(image.get("RootDeviceName", "")).startswith("/dev/"),
        "ubuntu_noble": bool(
            re.search(r"ubuntu.*noble.*24\.04.*amd64", str(image.get("Name", "")), re.I)
        ),
    }
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        raise PlanError(f"official Ubuntu AMI validation failed: {', '.join(failed)}")
    return {
        "ami_id": expected_id,
        "architecture": "x86_64",
        "name": str(image["Name"]),
        "owner_verified": True,
        "root_device_name": str(image["RootDeviceName"]),
    }


def validate_instance_type(document: dict[str, Any]) -> dict[str, int | str]:
    types = document.get("InstanceTypes", [])
    if len(types) != 1 or types[0].get("InstanceType") != "m7i.2xlarge":
        raise PlanError("m7i.2xlarge instance-type metadata unavailable")
    item = types[0]
    architectures = item.get("ProcessorInfo", {}).get("SupportedArchitectures", [])
    vcpus = int(item.get("VCpuInfo", {}).get("DefaultVCpus", 0))
    memory = int(item.get("MemoryInfo", {}).get("SizeInMiB", 0))
    if "x86_64" not in architectures or vcpus != 8 or memory != 32768:
        raise PlanError("m7i.2xlarge metadata does not match expected x86_64/8-vCPU/32-GiB shape")
    return {"instance_type": "m7i.2xlarge", "vcpus": vcpus, "memory_mib": memory}


def validate_offering(document: dict[str, Any], availability_zone: str) -> None:
    if not any(
        item.get("InstanceType") == "m7i.2xlarge"
        and item.get("Location") == availability_zone
        for item in document.get("InstanceTypeOfferings", [])
    ):
        raise PlanError(f"m7i.2xlarge is not offered in {availability_zone}")


def active_instances(document: dict[str, Any]) -> list[str]:
    result: list[str] = []
    for reservation in document.get("Reservations", []):
        for instance in reservation.get("Instances", []):
            state = instance.get("State", {}).get("Name")
            if state not in {"terminated", "shutting-down"}:
                result.append(str(instance.get("InstanceId", "unknown")))
    return result


def active_vcpus(document: dict[str, Any]) -> int:
    """Conservatively count all running/pending vCPUs against Standard quota."""
    total = 0
    for reservation in document.get("Reservations", []):
        for instance in reservation.get("Instances", []):
            if instance.get("State", {}).get("Name") not in {"pending", "running"}:
                continue
            cpu = instance.get("CpuOptions", {})
            cores = int(cpu.get("CoreCount", 0))
            threads = int(cpu.get("ThreadsPerCore", 0))
            if cores <= 0 or threads <= 0:
                raise PlanError("running instance vCPU usage could not be determined")
            total += cores * threads
    return total


def count_resources(document: dict[str, Any], key: str) -> int:
    value = document.get(key, [])
    if not isinstance(value, list):
        raise PlanError(f"unexpected resource response for {key}")
    return len(value)


def validate_iam_simulation(document: dict[str, Any]) -> list[str]:
    decisions = {
        str(item.get("EvalActionName")): str(item.get("EvalDecision"))
        for item in document.get("EvaluationResults", [])
    }
    missing = sorted(BOOTSTRAP_IAM_ACTIONS - decisions.keys())
    denied = sorted(action for action in BOOTSTRAP_IAM_ACTIONS if decisions.get(action) != "allowed")
    if missing or denied:
        raise PlanError(f"caller lacks verifiable IAM bootstrap capability; missing={missing}, denied={denied}")
    return sorted(BOOTSTRAP_IAM_ACTIONS)


def render_preflight(args: argparse.Namespace) -> dict[str, Any]:
    identity = load(args.identity)
    account = str(identity.get("Account", ""))
    arn = str(identity.get("Arn", ""))
    if not re.fullmatch(r"\d{12}", account):
        raise PlanError("STS returned an invalid account identifier")
    if arn.endswith(":root"):
        raise PlanError("AWS account root identity is forbidden")
    if not (":user/" in arn or ":assumed-role/" in arn):
        raise PlanError("caller must be an IAM user or assumed role")

    current_ip = ipaddress.ip_address(args.current_ip.strip())
    if current_ip.version != 4 or current_ip.is_unspecified or current_ip.is_multicast:
        raise PlanError("current public address is not a usable IPv4")
    resolved_cidr = f"{current_ip}/32"
    configured_cidr = expected_env("SSH_ALLOWED_CIDR")
    if configured_cidr != "auto" and configured_cidr != resolved_cidr:
        raise PlanError("configured SSH CIDR does not match the current public IPv4 /32")

    vpc_id = choose_vpc(load(args.vpcs), expected_env("VPC_ID"))
    subnet = choose_subnet(load(args.subnets), expected_env("SUBNET_ID"))
    validate_offering(load(args.offerings), subnet["availability_zone"])
    ami = validate_ami(load(args.image), args.ami_id)
    shape = validate_instance_type(load(args.instance_type))
    quota = float(load(args.quota).get("Value", 0))
    used_vcpus = active_vcpus(load(args.quota_instances))
    available_vcpus = quota - used_vcpus
    if available_vcpus < 8:
        raise PlanError(
            f"On-Demand vCPU quota has only {available_vcpus:g} conservatively available; "
            "at least 8 is required"
        )

    instances = active_instances(load(args.instances))
    if instances:
        raise PlanError("an existing owned instance blocks provisioning a second instance")
    conflicts = {
        "active_instances": 0,
        "security_groups": count_resources(load(args.security_groups), "SecurityGroups"),
        "volumes": count_resources(load(args.volumes), "Volumes"),
        "key_pairs": count_resources(load(args.key_pairs), "KeyPairs"),
    }
    if any(conflicts[name] > 1 for name in ("security_groups", "volumes", "key_pairs")):
        raise PlanError(f"ambiguous existing owned resources: {conflicts}")

    hourly = parse_price(load(args.compute_price), "Hrs")
    storage_monthly_per_gib = parse_price(load(args.storage_price), "GB-Mo")
    snapshot_monthly_per_gib = parse_price(load(args.snapshot_price), "GB-Mo")
    storage_monthly = storage_monthly_per_gib * 200
    public_ipv4_hourly = float(args.public_ipv4_hourly)
    max_hours = int(expected_env("SESSION_A_MAX_HOURS"))
    session_cost = max_hours * (hourly + public_ipv4_hourly) + storage_monthly * max_hours / 730
    bootstrap_actions = validate_iam_simulation(load(args.iam_simulation))

    return {
        "schema_version": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "status": "GO",
        "execution_location": "CLOUDSHELL",
        "read_only": True,
        "identity": {
            "account_id": account,
            "account_sha256": hashlib.sha256(account.encode()).hexdigest(),
            "caller_arn": arn,
            "caller_type": "assumed-role" if ":assumed-role/" in arn else "iam-user",
            "root_mfa_manually_confirmed": True,
        },
        "deployment_id": expected_env("RESOLVED_DEPLOYMENT_ID"),
        "region": "us-east-1",
        "network": {"vpc_id": vpc_id, **subnet, "ssh_allowed_cidr": resolved_cidr},
        "ami": ami,
        "compute": {
            **shape,
            "on_demand_vcpu_quota": quota,
            "active_vcpus_conservative": used_vcpus,
            "available_vcpus_conservative": available_vcpus,
        },
        "storage": {
            "size_gib": 200,
            "type": "gp3",
            "iops": 3000,
            "throughput_mib_s": 125,
            "encrypted": True,
            "delete_on_termination": True,
        },
        "metadata": {"http_tokens": "required", "hop_limit": 1},
        "existing_owned_resources": conflicts,
        "cost": {
            "currency": "USD",
            "compute_hourly": hourly,
            "public_ipv4_hourly": public_ipv4_hourly,
            "gp3_per_gib_month": storage_monthly_per_gib,
            "gp3_200_gib_month": storage_monthly,
            "snapshot_per_gib_month": snapshot_monthly_per_gib,
            "snapshot_200_gib_upper_bound_month": snapshot_monthly_per_gib * 200,
            "session_a_max_hours": max_hours,
            "session_a_estimate": round(session_cost, 4),
            "pricing_is_live_account_query": True,
        },
        "commits": {
            "vm": expected_env("NEUROFORGE_VM_COMMIT"),
            "application_baseline": expected_env("APPLICATION_BASELINE_COMMIT"),
        },
        "required_tags": {**REQUIRED_TAGS, "DeploymentId": expected_env("RESOLVED_DEPLOYMENT_ID")},
        "iam_capability_check": {
            "status": "allowed",
            "simulated_principal_arn": args.simulated_principal_arn,
            "bootstrap_actions": bootstrap_actions,
        },
        "warnings": [
            "No AWS resource was created; this plan contains read-only account metadata.",
            "Price estimates are not billing guarantees and must be refreshed before apply.",
        ],
    }


def render_resource_plan(preflight: dict[str, Any]) -> dict[str, Any]:
    if preflight.get("status") != "GO" or preflight.get("read_only") is not True:
        raise PlanError("preflight is not a clean read-only GO")
    deployment_id = preflight["deployment_id"]
    tags = preflight["required_tags"]
    return {
        "schema_version": 1,
        "status": "GO",
        "execution_location": "CLOUDSHELL",
        "mutations_performed": False,
        "deployment_id": deployment_id,
        "resources": [
            {"type": "iam-deployer-role", "count": 1, "name": f"NeuroForgeDeployer-{deployment_id}"},
            {"type": "iam-instance-role", "count": 1, "name": f"NeuroForgeInstance-{deployment_id}", "permissions": []},
            {"type": "iam-instance-profile", "count": 1, "name": f"NeuroForgeInstance-{deployment_id}"},
            {"type": "ec2-key-pair", "count": 1, "name": f"neuroforge-{deployment_id}"},
            {
                "type": "ec2-security-group",
                "count": 1,
                "ingress": [{"protocol": "tcp", "from_port": 22, "to_port": 22, "cidr": preflight["network"]["ssh_allowed_cidr"]}],
                "public_application_ports": [],
            },
            {
                "type": "ec2-instance",
                "count": 1,
                "instance_type": "m7i.2xlarge",
                "ami": preflight["ami"]["ami_id"],
                "architecture": "x86_64",
                "subnet_id": preflight["network"]["subnet_id"],
                "termination_protection": True,
                "shutdown_behavior": "stop",
                "metadata": {"http_tokens": "required", "hop_limit": 1},
            },
            {
                "type": "ebs-root-volume",
                "count": 1,
                "size_gib": 200,
                "volume_type": "gp3",
                "iops": 3000,
                "throughput_mib_s": 125,
                "encrypted": True,
                "delete_on_termination": True,
            },
        ],
        "tags": tags,
        "cost": preflight["cost"],
        "approval_required_later": "LAUNCH ONE M7I.2XLARGE",
        "prohibited_resources": [
            "elastic-ip", "nat-gateway", "load-balancer", "rds", "efs", "ecs", "eks", "gpu",
        ],
        "teardown_path": [
            "11-decommission-plan.sh", "12-decommission.sh", "13-decommission-verify.sh",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    preflight = subparsers.add_parser("preflight")
    for name in (
        "identity", "vpcs", "subnets", "offerings", "image", "instance_type",
        "quota", "quota_instances", "instances", "security_groups", "volumes", "key_pairs",
        "compute_price", "storage_price", "snapshot_price", "iam_simulation",
    ):
        preflight.add_argument(f"--{name.replace('_', '-')}", required=True)
    preflight.add_argument("--ami-id", required=True)
    preflight.add_argument("--current-ip", required=True)
    preflight.add_argument("--public-ipv4-hourly", default="0.005")
    preflight.add_argument("--simulated-principal-arn", required=True)
    preflight.add_argument("--output", type=Path, required=True)
    plan = subparsers.add_parser("plan")
    plan.add_argument("--preflight", type=Path, required=True)
    plan.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "preflight":
            result = render_preflight(args)
        else:
            result = render_resource_plan(load(args.preflight))
        write_private_json(args.output, result)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, PlanError, KeyError, TypeError) as exc:
        print(f"PLAN ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
