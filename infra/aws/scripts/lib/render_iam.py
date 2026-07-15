#!/usr/bin/env python3
"""Render and lint deployment-scoped NeuroForge IAM documents."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


FORBIDDEN_ACTION_PREFIXES = (
    "organizations:",
    "rds:",
    "eks:",
    "ecs:",
    "lambda:",
    "route53:",
    "cloudfront:",
    "s3:",
)
FORBIDDEN_ACTIONS = {
    "iam:CreateAccessKey",
    "iam:CreateUser",
    "iam:AttachUserPolicy",
    "iam:PutUserPolicy",
}


class PolicyError(ValueError):
    pass


def load(path: Path) -> Any:
    return json.loads(path.read_text())


def write_private(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    path.chmod(0o600)


def replace_tokens(value: Any, replacements: dict[str, str]) -> Any:
    encoded = json.dumps(value)
    for token, replacement in replacements.items():
        encoded = encoded.replace(token, replacement)
    if re.search(r"__[A-Z0-9_]+__", encoded):
        raise PolicyError("unresolved IAM template token")
    return json.loads(encoded)


def actions(policy: dict[str, Any]) -> list[str]:
    result: list[str] = []
    for statement in policy.get("Statement", []):
        value = statement.get("Action", [])
        result.extend([value] if isinstance(value, str) else value)
    return sorted(set(result))


def lint_policy(policy: dict[str, Any], instance_role_arn: str) -> None:
    policy_actions = actions(policy)
    if not policy_actions:
        raise PolicyError("deployer policy has no actions")
    if "*" in policy_actions or any(action.endswith(":*") for action in policy_actions):
        raise PolicyError("wildcard actions are forbidden")
    if FORBIDDEN_ACTIONS.intersection(policy_actions):
        raise PolicyError("IAM user/access-key actions are forbidden")
    if any(action.lower().startswith(FORBIDDEN_ACTION_PREFIXES) for action in policy_actions):
        raise PolicyError("an unrelated AWS service action is present")
    pass_statements = [
        statement
        for statement in policy["Statement"]
        if "iam:PassRole" in ([statement.get("Action")] if isinstance(statement.get("Action"), str) else statement.get("Action", []))
    ]
    if len(pass_statements) != 1:
        raise PolicyError("exactly one PassRole statement is required")
    statement = pass_statements[0]
    if statement.get("Resource") != instance_role_arn:
        raise PolicyError("PassRole must target the exact instance role")
    if statement.get("Condition", {}).get("StringEquals", {}).get("iam:PassedToService") != "ec2.amazonaws.com":
        raise PolicyError("PassRole must be limited to EC2")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", type=Path, required=True)
    parser.add_argument("--bootstrap-principal-arn", required=True)
    parser.add_argument("--deployer-policy-template", type=Path, required=True)
    parser.add_argument("--deployer-trust-template", type=Path, required=True)
    parser.add_argument("--instance-trust-template", type=Path, required=True)
    parser.add_argument("--instance-policy-template", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--plan-output", type=Path, required=True)
    args = parser.parse_args()
    try:
        preflight = load(args.preflight)
        if preflight.get("status") != "GO":
            raise PolicyError("preflight is not GO")
        account_id = preflight["identity"]["account_id"]
        if not re.fullmatch(r"\d{12}", account_id):
            raise PolicyError("invalid account identifier")
        principal = args.bootstrap_principal_arn
        expected_prefix = f"arn:aws:iam::{account_id}:"
        if not principal.startswith(expected_prefix) or not (":user/" in principal or ":role/" in principal):
            raise PolicyError("bootstrap principal must be an exact same-account IAM user or role ARN")
        deployment_id = preflight["deployment_id"]
        deployer_name = f"NeuroForgeDeployer-{deployment_id}"
        instance_name = f"NeuroForgeInstance-{deployment_id}"
        if max(len(deployer_name), len(instance_name)) > 64:
            raise PolicyError("generated IAM name exceeds 64 characters")
        instance_role_arn = f"arn:aws:iam::{account_id}:role/{instance_name}"
        replacements = {
            "__ACCOUNT_ID__": account_id,
            "__REGION__": preflight["region"],
            "__AMI_ID__": preflight["ami"]["ami_id"],
            "__VPC_ID__": preflight["network"]["vpc_id"],
            "__SUBNET_ID__": preflight["network"]["subnet_id"],
            "__DEPLOYMENT_ID__": deployment_id,
            "__BOOTSTRAP_PRINCIPAL_ARN__": principal,
        }
        deployer_policy = replace_tokens(load(args.deployer_policy_template), replacements)
        deployer_trust = replace_tokens(load(args.deployer_trust_template), replacements)
        instance_trust = replace_tokens(load(args.instance_trust_template), replacements)
        instance_policy = replace_tokens(load(args.instance_policy_template), replacements)
        lint_policy(deployer_policy, instance_role_arn)
        if instance_policy.get("Statement") != []:
            raise PolicyError("instance role must have no AWS API permissions")
        if deployer_trust["Statement"][0]["Principal"]["AWS"] != principal:
            raise PolicyError("deployer trust is not scoped to the bootstrap principal")
        if instance_trust["Statement"][0]["Principal"] != {"Service": "ec2.amazonaws.com"}:
            raise PolicyError("instance role trust must target EC2 only")

        files = {
            "deployer_policy": args.output_dir / "deployer-policy.json",
            "deployer_trust": args.output_dir / "deployer-trust.json",
            "instance_trust": args.output_dir / "instance-trust.json",
            "instance_policy_audit": args.output_dir / "instance-policy-no-permissions.json",
        }
        write_private(files["deployer_policy"], deployer_policy)
        write_private(files["deployer_trust"], deployer_trust)
        write_private(files["instance_trust"], instance_trust)
        write_private(files["instance_policy_audit"], instance_policy)
        plan = {
            "schema_version": 1,
            "status": "GO",
            "execution_location": "CLOUDSHELL",
            "mutations_performed": False,
            "deployment_id": deployment_id,
            "bootstrap_principal_arn": principal,
            "deployer_role_name": deployer_name,
            "deployer_policy_name": deployer_name,
            "deployer_policy_arn": f"arn:aws:iam::{account_id}:policy/{deployer_name}",
            "instance_role_name": instance_name,
            "instance_role_arn": instance_role_arn,
            "instance_profile_name": instance_name,
            "instance_role_actions": [],
            "deployer_actions": actions(deployer_policy),
            "rendered_files": {name: str(path) for name, path in files.items()},
            "apply_confirmation": "CREATE NEUROFORGE IAM",
            "live_approval_required": True,
        }
        write_private(args.plan_output, plan)
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, KeyError, TypeError, PolicyError) as exc:
        print(f"IAM PLAN ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
