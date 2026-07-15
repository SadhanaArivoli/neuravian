from __future__ import annotations

import re
from pathlib import Path


MODULE = Path(__file__).resolve().parents[1]


def read(name: str) -> str:
    return (MODULE / name).read_text()


def test_exact_compute_storage_and_metadata_contract() -> None:
    variables = read("variables.tf")
    compute = read("compute.tf")
    data = read("data.tf")
    assert 'default     = "m7i.2xlarge"' in variables
    assert '"m7i-flex.large"' in variables
    assert "volume_size           = 200" in compute
    assert 'volume_type           = "gp3"' in compute
    assert "iops                  = 3000" in compute
    assert "throughput            = 125" in compute
    assert "encrypted             = true" in compute
    assert "delete_on_termination = true" in compute
    assert 'http_tokens                 = "required"' in compute
    assert "http_put_response_hop_limit = 1" in compute
    assert re.search(
        r"disable_api_termination\s*=\s*var\.enable_termination_protection", compute
    )
    assert "ignore_changes = [associate_public_ip_address]" in compute
    assert 'data "aws_ec2_instance_type_offering" "selected"' in data
    assert 'quota_code   = "L-1216C47A"' in data
    assert "standard_vcpus.value >= data.aws_ec2_instance_type.selected.default_vcpus" in compute


def test_network_is_ssh_only_and_application_is_loopback_only() -> None:
    network = read("network.tf")
    override = read("templates/compose.aws-loopback.yaml")
    assert "from_port   = 22" in network
    assert "to_port     = 22" in network
    assert "cidr_blocks = [var.operator_ssh_cidr]" in network
    assert "from_port   = 3000" not in network
    assert "from_port   = 8000" not in network
    assert '"127.0.0.1:3000:3000"' in override
    assert '"127.0.0.1:8000:8000"' in override


def test_instance_role_has_no_permissions_policy() -> None:
    terraform = "\n".join(path.read_text() for path in MODULE.glob("*.tf"))
    assert 'resource "aws_iam_role" "instance"' in terraform
    assert 'resource "aws_iam_instance_profile" "instance"' in terraform
    assert 'resource "aws_iam_role_policy"' not in terraform
    assert 'resource "aws_iam_role_policy_attachment"' not in terraform
    assert 'resource "aws_iam_policy_attachment"' not in terraform


def test_cloud_init_pins_repo_commit_and_starts_service_without_pipeline() -> None:
    template = read("templates/cloud-init.tftpl")
    assert "git -C \"$REPOSITORY_DIR\" checkout --detach \"$GIT_COMMIT\"" in template
    assert "systemctl enable --now neuroforge.service" in template
    assert "http://127.0.0.1:8000/api/health" in template
    assert '"scientific_pipelines_run": False' in template
    assert "fmriprep" not in template.lower()
    assert "fastsurfer" not in template.lower()


def test_private_repository_bootstrap_is_credential_free_and_exact() -> None:
    helper = read("scripts/complete-private-bootstrap.sh")
    assert 'git -C "${verify_repository}" bundle verify "${BUNDLE_PATH}"' in helper
    assert 'checkout --detach "${GIT_COMMIT}"' in helper
    assert 'remote set-url origin "${REPOSITORY_URL}"' in helper
    assert '"source_transfer": "authenticated-local-git-bundle"' in helper
    assert "GITHUB_TOKEN" not in helper
    assert "AWS_SECRET_ACCESS_KEY" not in helper


def test_no_secret_or_private_key_material_is_committed() -> None:
    contents = "\n".join(
        path.read_text()
        for path in MODULE.rglob("*")
        if path.is_file()
        and ".terraform" not in path.parts
        and "tests" not in path.parts
        and "__pycache__" not in path.parts
        and (
            path.suffix in {".tf", ".hcl", ".md", ".yaml", ".sh", ".py", ".example"}
            or path.name == ".gitignore"
        )
    )
    forbidden = (
        "AWS_SECRET_ACCESS_KEY=",
        "aws_secret_access_key =",
        "BEGIN OPENSSH PRIVATE KEY",
        "BEGIN RSA PRIVATE KEY",
        "/Users/",
        "license.txt",
    )
    assert not any(marker in contents for marker in forbidden)
    assert not re.search(r"(?:AKIA|ASIA)[0-9A-Z]{16}", contents)


def test_tfvars_and_state_are_documented_as_ignored() -> None:
    ignore = (MODULE.parents[2] / ".gitignore").read_text()
    assert "**/.terraform/" in ignore
    assert "*.tfstate" in ignore
    assert "*.tfplan" in ignore
    assert "*.tfvars" in ignore
    assert "!*.tfvars.example" in ignore
