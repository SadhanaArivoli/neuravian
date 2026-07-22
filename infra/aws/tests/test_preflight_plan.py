from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / "infra/aws/scripts"
EXAMPLE = ROOT / "infra/aws/config/neuravian-x86.env.example"


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
        "Arn": f"arn:aws:iam::{account}:{'root' if root else 'user/neuravian-test'}",
    },
    ("ec2", "describe-vpcs"): {"Vpcs": [{"VpcId": "vpc-abc123", "State": "available", "IsDefault": True}]},
    ("ec2", "describe-subnets"): {"Subnets": [{"SubnetId": "subnet-abc123", "VpcId": "vpc-abc123", "State": "available", "MapPublicIpOnLaunch": True, "AvailabilityZone": "us-east-1a"}]},
    ("ec2", "describe-instance-type-offerings"): {"InstanceTypeOfferings": [{"InstanceType": "m7i.2xlarge", "LocationType": "availability-zone", "Location": "us-east-1a"}]},
    ("ec2", "describe-instance-types"): {"InstanceTypes": [{"InstanceType": "m7i.2xlarge", "ProcessorInfo": {"SupportedArchitectures": ["x86_64"]}, "VCpuInfo": {"DefaultVCpus": 8}, "MemoryInfo": {"SizeInMiB": 32768}}]},
    ("service-quotas", "get-service-quota"): {"Value": 64.0, "QuotaCode": "L-1216C47A"},
    ("ec2", "describe-images"): {"Images": [{"ImageId": "ami-abc123", "OwnerId": owner, "Architecture": "arm64" if bad_arch else "x86_64", "State": "available", "RootDeviceType": "ebs", "RootDeviceName": "/dev/sda1", "Name": "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260701"}]},
    ("ec2", "describe-instances"): {"Reservations": []},
    ("ec2", "describe-security-groups"): {"SecurityGroups": []},
    ("ec2", "describe-volumes"): {"Volumes": []},
    ("ec2", "describe-key-pairs"): {"KeyPairs": []},
}
if (service, operation) == ("ec2", "describe-instances") and any("instance-state-name" in arg for arg in args):
    busy = int(os.environ.get("FAKE_BUSY_VCPUS", "0"))
    instances = [] if busy == 0 else [{"InstanceId": "i-unrelated", "InstanceType": "m7i.2xlarge", "State": {"Name": "running"}, "CpuOptions": {"CoreCount": busy // 2, "ThreadsPerCore": 2}}]
    print(json.dumps({"Reservations": [] if not instances else [{"Instances": instances}]}))
elif (service, operation) == ("ssm", "get-parameter"):
    print("ami-abc123")
elif (service, operation) == ("pricing", "get-products"):
    snapshot = any("SnapshotUsage" in arg for arg in args)
    storage = any("volumeApiName" in arg for arg in args)
    unit = "GB-Mo" if storage or snapshot else "Hrs"
    price = "0.05" if snapshot else "0.08" if storage else "0.4032"
    product = {"terms": {"OnDemand": {"term": {"priceDimensions": {"dimension": {"unit": unit, "pricePerUnit": {"USD": price}}}}}}}
    print(json.dumps({"PriceList": [json.dumps(product)]}))
elif (service, operation) == ("iam", "simulate-principal-policy"):
    action_index = args.index("--action-names") + 1
    action_names = []
    for value in args[action_index:]:
        if value.startswith("--"):
            break
        action_names.append(value)
    print(json.dumps({"EvaluationResults": [{"EvalActionName": value, "EvalDecision": "allowed"} for value in action_names]}))
elif (service, operation) == ("accessanalyzer", "validate-policy"):
    print(json.dumps({"findings": []}))
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
    assert plan["compute"]["active_vcpus_conservative"] == 0
    assert plan["compute"]["available_vcpus_conservative"] == 64
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
    assert plan["cost"]["snapshot_200_gib_upper_bound_month"] == pytest.approx(10.0)
    assert plan["iam_capability_check"]["status"] == "allowed"
    assert len(plan["iam_capability_check"]["bootstrap_actions"]) == 21
    assert "access-analyzer:ValidatePolicy" in plan["iam_capability_check"]["bootstrap_actions"]
    assert "iam:DeleteRole" in plan["iam_capability_check"]["bootstrap_actions"]
    assert "iam:TagRole" in plan["iam_capability_check"]["bootstrap_actions"]
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


def test_insufficient_remaining_vcpu_quota_is_rejected(harness: dict) -> None:
    harness["env"]["FAKE_BUSY_VCPUS"] = "58"
    result = run_script(harness, "00-preflight.sh")
    assert result.returncode != 0
    assert "only 6 conservatively available" in result.stderr
    assert_no_mutations(harness["log"])


def test_config_parser_rejects_command_substitution(harness: dict) -> None:
    config = harness["config"]
    config.write_text(config.read_text().replace("VPC_ID=auto", "VPC_ID=$(touch /tmp/forbidden)"))
    result = run_script(harness, "00-preflight.sh")
    assert result.returncode != 0
    assert "Executable syntax is forbidden" in result.stderr
    assert not harness["log"].exists()


def test_iam_plan_is_scoped_permissionless_and_idempotent(harness: dict) -> None:
    result = run_script(harness, "02-bootstrap-iam.sh")
    assert result.returncode == 0, result.stderr
    plan_root = ROOT / ".neuravian-aws/plans"
    plan_path = plan_root / "iam-plan-nf-x86-test0001.json"
    plan = json.loads(plan_path.read_text())
    assert plan["status"] == "GO"
    assert plan["mutations_performed"] is False
    assert plan["instance_role_actions"] == []
    assert "iam:PassRole" in plan["deployer_actions"]
    deployer_policy_path = Path(plan["rendered_files"]["deployer_policy"])
    deployer_policy_before = deployer_policy_path.read_bytes()
    policy = json.loads(deployer_policy_before)
    pass_role = next(
        statement for statement in policy["Statement"] if statement.get("Action") == "iam:PassRole"
    )
    assert pass_role["Resource"] == plan["instance_role_arn"]
    assert pass_role["Condition"] == {
        "StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}
    }
    assert json.loads(Path(plan["rendered_files"]["instance_policy_audit"]).read_text())["Statement"] == []
    result = run_script(harness, "02-bootstrap-iam.sh")
    assert result.returncode == 0, result.stderr
    assert deployer_policy_path.read_bytes() == deployer_policy_before
    assert_no_mutations(harness["log"])


def test_iam_apply_is_blocked_without_reserved_future_approval(harness: dict) -> None:
    result = run_script(
        harness,
        "02-bootstrap-iam.sh",
        "--apply",
        "--confirmation",
        "CREATE NEURAVIAN IAM",
    )
    assert result.returncode != 0
    assert "Live AWS automation approval is absent" in result.stderr
    assert not harness["log"].exists()


def test_committed_iam_templates_are_valid_json_and_contain_no_user_key_actions() -> None:
    paths = [
        ROOT / "infra/aws/iam/neuravian-deployer-trust-policy.json",
        ROOT / "infra/aws/iam/neuravian-instance-trust-policy.json",
        ROOT / "infra/aws/iam/neuravian-instance-role-policy.json",
        ROOT / "infra/aws/policies/neuravian-deployer-policy.json",
    ]
    documents = [json.loads(path.read_text()) for path in paths]
    encoded = json.dumps(documents)
    assert "iam:CreateAccessKey" not in encoded
    assert "iam:CreateUser" not in encoded
    assert "AdministratorAccess" not in encoded
    assert documents[2]["Statement"] == []


def test_provision_dry_run_generates_exact_safe_request(harness: dict) -> None:
    result = run_script(harness, "03-provision.sh", "--dry-run")
    assert result.returncode == 0, result.stderr
    request_path = (
        ROOT
        / ".neuravian-aws/plans/provision-nf-x86-test0001/run-instances.json"
    )
    request = json.loads(request_path.read_text())
    assert request["MinCount"] == request["MaxCount"] == 1
    assert request["InstanceType"] == "m7i.2xlarge"
    assert request["NetworkInterfaces"] == [
        {
            "AssociatePublicIpAddress": True,
            "DeleteOnTermination": True,
            "DeviceIndex": 0,
            "Groups": ["sg-planned00000000"],
            "SubnetId": "subnet-abc123",
        }
    ]
    assert request["BlockDeviceMappings"][0]["Ebs"] == {
        "DeleteOnTermination": True,
        "Encrypted": True,
        "Iops": 3000,
        "Throughput": 125,
        "VolumeSize": 200,
        "VolumeType": "gp3",
    }
    assert request["MetadataOptions"] == {
        "HttpEndpoint": "enabled",
        "HttpPutResponseHopLimit": 1,
        "HttpTokens": "required",
        "InstanceMetadataTags": "disabled",
    }
    assert request["DisableApiTermination"] is True
    assert request["InstanceInitiatedShutdownBehavior"] == "stop"
    assert {item["ResourceType"] for item in request["TagSpecifications"]} == {
        "instance",
        "network-interface",
        "volume",
    }
    import base64

    user_data = base64.b64decode(request["UserData"]).decode()
    assert "8b9614c328463c9dfcb5337303cadde447985299" in user_data
    assert "HttpPutResponseHopLimit" not in user_data
    assert "license.txt" not in user_data
    assert "AWS_SECRET_ACCESS_KEY" not in user_data
    assert "verification/x86/commands/02" not in user_data
    assert "docker run" not in user_data
    assert_no_mutations(harness["log"])


def test_provision_apply_is_blocked_before_any_aws_call(harness: dict) -> None:
    result = run_script(
        harness,
        "03-provision.sh",
        "--apply",
        "--confirmation",
        "LAUNCH ONE M7I.2XLARGE",
    )
    assert result.returncode != 0
    assert "Live AWS automation approval is absent" in result.stderr
    assert not harness["log"].exists()


def test_wait_and_deploy_dry_runs_are_non_mutating(harness: dict) -> None:
    wait = run_script(harness, "04-wait-and-verify.sh", "--dry-run")
    assert wait.returncode == 0, wait.stderr
    assert "no container or scientific pipeline ran" in wait.stdout
    deploy = run_script(harness, "05-deploy-neuravian.sh", "--dry-run")
    assert deploy.returncode == 0, deploy.stderr
    assert "no scientific pipeline" in deploy.stdout.lower()
    assert "127.0.0.1:3000" in deploy.stdout
    assert "127.0.0.1:8000" in deploy.stdout
    assert not harness["log"].exists()


def test_deploy_apply_is_blocked_before_state_or_network(harness: dict) -> None:
    result = run_script(
        harness,
        "05-deploy-neuravian.sh",
        "--apply",
        "--confirmation",
        "DEPLOY LOCAL-ONLY NEURAVIAN",
    )
    assert result.returncode != 0
    assert "Live AWS automation approval is absent" in result.stderr
    assert not harness["log"].exists()


@pytest.mark.parametrize(
    "script",
    [
        "06-status.sh",
        "07-stop.sh",
        "08-start.sh",
        "09-collect-evidence.sh",
        "10-cost-controls.sh",
        "11-decommission-plan.sh",
        "12-decommission.sh",
        "13-decommission-verify.sh",
        "emergency-stop.sh",
    ],
)
def test_lifecycle_and_decommission_dry_runs_make_no_aws_calls(harness: dict, script: str) -> None:
    result = run_script(harness, script, "--dry-run")
    assert result.returncode == 0, result.stderr
    assert not harness["log"].exists()


def test_optional_budget_apply_is_separately_blocked(harness: dict) -> None:
    result = run_script(
        harness,
        "10-cost-controls.sh",
        "--apply",
        "--email",
        "researcher@example.org",
        "--confirmation",
        "CREATE NEURAVIAN BUDGET",
    )
    assert result.returncode != 0
    assert "Live AWS automation approval is absent" in result.stderr
    assert not harness["log"].exists()


def test_optional_budget_policy_uses_documented_iam_actions() -> None:
    policy = json.loads(
        (ROOT / "infra/aws/policies/neuravian-optional-budget-policy.json").read_text()
    )
    assert policy["Statement"][0]["Action"] == ["budgets:ModifyBudget", "budgets:ViewBudget"]
    assert policy["Statement"][1] == {
        "Sid": "ReadBillingViewRequiredByViewBudget",
        "Effect": "Allow",
        "Action": "billing:GetBillingViewData",
        "Resource": "*",
    }
