from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
VERIFY = ROOT / "infra/aws/scripts/lib/verify_instance.py"
DEPLOYMENT = "nf-x86-test0001"
TAGS = [
    {"Key": "Project", "Value": "Neuravian"},
    {"Key": "Purpose", "Value": "x86-verification"},
    {"Key": "ManagedBy", "Value": "NeuravianProvisioner"},
    {"Key": "DeploymentId", "Value": DEPLOYMENT},
]


def write(path: Path, value: dict) -> Path:
    path.write_text(json.dumps(value))
    return path


def documents(tmp_path: Path) -> dict[str, Path]:
    account = "".join(["111", "111", "111", "111"])
    state = {
        "deployment_id": DEPLOYMENT,
        "instance_id": "i-abc123",
        "security_group_id": "sg-abc123",
    }
    preflight = {
        "ami": {"ami_id": "ami-abc123", "owner_verified": True},
        "network": {"subnet_id": "subnet-abc123", "ssh_allowed_cidr": "198.51.100.42/32"},
        "required_tags": {item["Key"]: item["Value"] for item in TAGS},
    }
    instance = {
        "Reservations": [
            {
                "Instances": [
                    {
                        "InstanceId": "i-abc123",
                        "State": {"Name": "running"},
                        "InstanceType": "m7i.2xlarge",
                        "ImageId": "ami-abc123",
                        "SubnetId": "subnet-abc123",
                        "Architecture": "x86_64",
                        "Tags": TAGS,
                        "PublicIpAddress": "198.51.100.99",
                        "MetadataOptions": {"HttpTokens": "required", "HttpPutResponseHopLimit": 1},
                        "SecurityGroups": [{"GroupId": "sg-abc123", "GroupName": "test"}],
                        "IamInstanceProfile": {"Arn": f"arn:aws:iam::{account}:instance-profile/NeuravianInstance-{DEPLOYMENT}"},
                        "BlockDeviceMappings": [
                            {"DeviceName": "/dev/sda1", "Ebs": {"VolumeId": "vol-abc123", "DeleteOnTermination": True}}
                        ],
                    }
                ]
            }
        ]
    }
    security_group = {
        "SecurityGroups": [
            {
                "GroupId": "sg-abc123",
                "Tags": TAGS,
                "IpPermissions": [
                    {
                        "FromPort": 22,
                        "IpProtocol": "tcp",
                        "IpRanges": [{"CidrIp": "198.51.100.42/32", "Description": "Neuravian-x86-operator"}],
                        "Ipv6Ranges": [],
                        "PrefixListIds": [],
                        "ToPort": 22,
                        "UserIdGroupPairs": [],
                    }
                ],
            }
        ]
    }
    volume = {
        "Volumes": [
            {
                "VolumeId": "vol-abc123",
                "Encrypted": True,
                "Size": 200,
                "VolumeType": "gp3",
                "Iops": 3000,
                "Throughput": 125,
                "Tags": TAGS,
            }
        ]
    }
    return {
        "state": write(tmp_path / "state.json", state),
        "preflight": write(tmp_path / "preflight.json", preflight),
        "instances": write(tmp_path / "instances.json", instance),
        "termination": write(tmp_path / "termination.json", {"DisableApiTermination": {"Value": True}}),
        "security-group": write(tmp_path / "security-group.json", security_group),
        "volume": write(tmp_path / "volume.json", volume),
    }


def run_verify(tmp_path: Path, docs: dict[str, Path]) -> subprocess.CompletedProcess[str]:
    command = [str(VERIFY)]
    for name, path in docs.items():
        command.extend([f"--{name}", str(path)])
    command.extend(["--output", str(tmp_path / "verified.json")])
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True)


def test_exact_control_plane_shape_passes(tmp_path: Path) -> None:
    result = run_verify(tmp_path, documents(tmp_path))
    assert result.returncode == 0, result.stderr
    verified = json.loads((tmp_path / "verified.json").read_text())
    assert verified["status"] == "GO"
    assert verified["public_application_ports"] == []
    assert verified["imds"] == {"hop_limit": 1, "http_tokens": "required"}
    assert verified["root_volume"]["delete_on_termination"] is True


def test_public_application_ingress_is_rejected(tmp_path: Path) -> None:
    docs = documents(tmp_path)
    group = json.loads(docs["security-group"].read_text())
    group["SecurityGroups"][0]["IpPermissions"].append(
        {
            "FromPort": 8000,
            "IpProtocol": "tcp",
            "IpRanges": [{"CidrIp": "0.0.0.0/0"}],
            "Ipv6Ranges": [],
            "PrefixListIds": [],
            "ToPort": 8000,
            "UserIdGroupPairs": [],
        }
    )
    docs["security-group"].write_text(json.dumps(group))
    result = run_verify(tmp_path, docs)
    assert result.returncode != 0
    assert "exact SSH /32" in result.stderr


def test_unencrypted_volume_and_imds_hop_two_are_rejected(tmp_path: Path) -> None:
    docs = documents(tmp_path)
    volume = json.loads(docs["volume"].read_text())
    volume["Volumes"][0]["Encrypted"] = False
    docs["volume"].write_text(json.dumps(volume))
    result = run_verify(tmp_path, docs)
    assert result.returncode != 0
    assert "shape/encryption" in result.stderr

    docs = documents(tmp_path)
    instances = json.loads(docs["instances"].read_text())
    instances["Reservations"][0]["Instances"][0]["MetadataOptions"]["HttpPutResponseHopLimit"] = 2
    docs["instances"].write_text(json.dumps(instances))
    result = run_verify(tmp_path, docs)
    assert result.returncode != 0
    assert "IMDSv2" in result.stderr
