from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / "infra/aws/scripts"
EXAMPLE = ROOT / "infra/aws/config/neuroforge-x86.env.example"


FAKE_AWS = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

args = sys.argv[1:]
if args == ["--version"]:
    print("aws-cli/2.24.0 Python/3.12 Linux/6 botocore/2.0")
    raise SystemExit(0)
service = args[0]
operation = args[1]
with Path(os.environ["AWS_CALL_LOG"]).open("a") as stream:
    stream.write(f"{service} {operation}\n")

account = "".join(["111", "111", "111", "111"])
owner = "".join(["099", "720", "109", "477"])
root = os.environ.get("FAKE_ROOT") == "1"
bad_arch = os.environ.get("FAKE_BAD_ARCH") == "1"
responses = {
    ("sts", "get-caller-identity"): {
        "UserId": "AIDATEST",
        "Account": account,
        "Arn": f"arn:aws:iam::{account}:{'root' if root else 'user/neuroforge-test'}",
    },
    ("ec2", "describe-vpcs"): {"Vpcs": [{"VpcId": "vpc-abc123", "State": "available", "IsDefault": True}]},
    ("ec2", "describe-subnets"): {"Subnets": [{"SubnetId": "subnet-abc123", "VpcId": "vpc-abc123", "State": "available", "MapPublicIpOnLaunch": True, "AvailabilityZone": "us-east-1a"}]},
    ("ec2", "describe-instance-type-offerings"): {"InstanceTypeOfferings": [{"InstanceType": "m7i.2xlarge", "LocationType": "availability-zone", "Location": "us-east-1a"}]},
    ("ec2", "describe-instance-types"): {"InstanceTypes": [{"InstanceType": "m7i.2xlarge", "ProcessorInfo": {"SupportedArchitectures": ["x86_64"]}, "VCpuInfo": {"DefaultVCpus": 8}, "MemoryInfo": {"SizeInMiB": 32768}}]},
    ("service-quotas", "get-service-quota"): {"Value": 64.0, "QuotaCode": "L-1216C47A"},
    ("ec2", "describe-images"): {"Images": [{"ImageId": "ami-abc123", "OwnerId": owner, "Architecture": "arm64" if bad_arch else "x86_64", "State": "available", "RootDeviceType": "ebs", "Name": "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260701"}]},
    ("ec2", "describe-instances"): {"Reservations": []},
    ("ec2", "describe-security-groups"): {"SecurityGroups": []},
    ("ec2", "describe-volumes"): {"Volumes": []},
    ("ec2", "describe-key-pairs"): {"KeyPairs": []},
}
if (service, operation) == ("ssm", "get-parameter"):
    print("ami-abc123")
elif (service, operation) == ("pricing", "get-products"):
    storage = any("volumeApiName" in arg for arg in args)
    unit = "GB-Mo" if storage else "Hrs"
    price = "0.08" if storage else "0.4032"
    product = {"terms": {"OnDemand": {"term": {"priceDimensions": {"dimension": {"unit": unit, "pricePerUnit": {"USD": price}}}}}}}
    print(json.dumps({"PriceList": [json.dumps(product)]}))
else:
    print(json.dumps(responses[(service, operation)]))
'''


FAKE_CURL = '''#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${FAKE_CURRENT_IP:-198.51.100.42}"
'''


MUTATING_OPERATIONS = {
    "run-instances",
    "create-key-pair",
    "create-security-group",
    "authorize-security-group-ingress",
    "create-role",
    "create-policy",
    "create-instance-profile",
    "start-instances",
    "stop-instances",
    "terminate-instances",
    "delete-security-group",
    "delete-key-pair",
}


@pytest.fixture()
def harness(tmp_path: Path) -> dict[str, Path | dict[str, str]]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    aws = bin_dir / "aws"
    curl = bin_dir / "curl"
    aws.write_text(FAKE_AWS)
    curl.write_text(FAKE_CURL)
    aws.chmod(0o755)
    curl.chmod(0o755)
    config = tmp_path / "config.env"
    config.write_text(
        EXAMPLE.read_text()
        .replace("DEPLOYMENT_ID=auto", "DEPLOYMENT_ID=nf-x86-test0001")
        .replace("ROOT_MFA_CONFIRMED=false", "ROOT_MFA_CONFIRMED=true")
    )
    log = tmp_path / "aws-calls.log"
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{bin_dir}:{env['PATH']}",
            "AWS_CALL_LOG": str(log),
            "HOME": str(tmp_path / "home"),
        }
    )
    return {"config": config, "log": log, "env": env, "tmp": tmp_path}


def run_script(harness: dict, script: str, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(SCRIPTS / script), "--config", str(harness["config"]), *extra],
        cwd=ROOT,
        env=harness["env"],
        text=True,
        capture_output=True,
    )


def assert_no_mutations(log: Path) -> None:
    operations = {line.split()[1] for line in log.read_text().splitlines()}
    assert operations.isdisjoint(MUTATING_OPERATIONS)


def test_preflight_is_read_only_and_validates_exact_shape(harness: dict) -> None:
    output = harness["tmp"] / "preflight.json"
    result = run_script(harness, "00-preflight.sh", "--output", str(output), "--dry-run")
    assert result.returncode == 0, result.stderr
    plan = json.loads(output.read_text())
    assert plan["status"] == "GO"
    assert plan["read_only"] is True
    assert plan["ami"]["architecture"] == "x86_64"
    assert plan["compute"]["instance_type"] == "m7i.2xlarge"
    assert plan["network"]["ssh_allowed_cidr"] == "198.51.100.42/32"
    assert plan["storage"] == {
        "delete_on_termination": True,
        "encrypted": True,
        "iops": 3000,
        "size_gib": 200,
        "throughput_mib_s": 125,
        "type": "gp3",
    }
    assert plan["metadata"] == {"hop_limit": 1, "http_tokens": "required"}
    assert plan["cost"]["compute_hourly"] == pytest.approx(0.4032)
    assert plan["cost"]["gp3_200_gib_month"] == pytest.approx(16.0)
    assert_no_mutations(harness["log"])


def test_resource_plan_proposes_exactly_one_instance_and_no_public_app_ports(harness: dict) -> None:
    output = harness["tmp"] / "resource-plan.json"
    result = run_script(harness, "01-plan.sh", "--output", str(output), "--dry-run")
    assert result.returncode == 0, result.stderr
    plan = json.loads(output.read_text())
    instances = [item for item in plan["resources"] if item["type"] == "ec2-instance"]
    assert len(instances) == 1
    assert instances[0]["count"] == 1
    assert instances[0]["metadata"] == {"hop_limit": 1, "http_tokens": "required"}
    security_group = next(item for item in plan["resources"] if item["type"] == "ec2-security-group")
    assert security_group["ingress"] == [
        {"cidr": "198.51.100.42/32", "from_port": 22, "protocol": "tcp", "to_port": 22}
    ]
    assert security_group["public_application_ports"] == []
    root = next(item for item in plan["resources"] if item["type"] == "ebs-root-volume")
    assert root["delete_on_termination"] is True
    assert_no_mutations(harness["log"])


@pytest.mark.parametrize(
    ("old", "new", "message"),
    [
        ("INSTANCE_TYPE=m7i.2xlarge", "INSTANCE_TYPE=t3.micro", "INSTANCE_TYPE"),
        ("SSH_ALLOWED_CIDR=auto", "SSH_ALLOWED_CIDR=0.0.0.0/0", "SSH_ALLOWED_CIDR"),
        ("ROOT_VOLUME_ENCRYPTED=true", "ROOT_VOLUME_ENCRYPTED=false", "encryption"),
        ("ROOT_DELETE_ON_TERMINATION=true", "ROOT_DELETE_ON_TERMINATION=false", "DeleteOnTermination"),
        ("IMDS_HOP_LIMIT=1", "IMDS_HOP_LIMIT=2", "IMDS_HOP_LIMIT"),
    ],
)
def test_invalid_security_configuration_fails_before_aws(
    harness: dict, old: str, new: str, message: str
) -> None:
    config = harness["config"]
    config.write_text(config.read_text().replace(old, new))
    result = run_script(harness, "00-preflight.sh")
    assert result.returncode != 0
    assert message.lower() in result.stderr.lower()
    assert not harness["log"].exists()


def test_root_identity_is_rejected(harness: dict) -> None:
    harness["env"]["FAKE_ROOT"] = "1"
    result = run_script(harness, "00-preflight.sh")
    assert result.returncode != 0
    assert "root identity is forbidden" in result.stderr
    assert_no_mutations(harness["log"])


def test_arm_ami_is_rejected(harness: dict) -> None:
    harness["env"]["FAKE_BAD_ARCH"] = "1"
    result = run_script(harness, "00-preflight.sh")
    assert result.returncode != 0
    assert "architecture" in result.stderr
    assert_no_mutations(harness["log"])


def test_config_parser_rejects_command_substitution(harness: dict) -> None:
    config = harness["config"]
    config.write_text(config.read_text().replace("VPC_ID=auto", "VPC_ID=$(touch /tmp/forbidden)"))
    result = run_script(harness, "00-preflight.sh")
    assert result.returncode != 0
    assert "Executable syntax is forbidden" in result.stderr
    assert not harness["log"].exists()
