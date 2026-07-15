# NeuroForge AWS x86 automation

Status: **non-billable implementation; do not apply yet**.

This directory contains the reviewable AWS CloudShell workflow for exactly one
native Linux x86_64 NeuroForge verification VM. The scripts default to read-only
or plan mode. No IAM or EC2 mutation is authorized until the separately reserved
live-approval phrase is provided after the final non-billable gate.

Execution locations:

- **CLOUDSHELL:** configuration, preflight, planning, IAM, provisioning, and
  lifecycle control.
- **LOCAL MAC:** secure PEM receipt, fixture/license transfer, SSH tunneling,
  and evidence download/verification.
- **REMOTE VM:** user-data bootstrap and the local-only NeuroForge stack.

Start in **CLOUDSHELL**:

```bash
git clone https://github.com/SadhanaArivoli/neuroforge.git
cd neuroforge
git checkout --detach 7881cd6ce56a9ccb838ef8dc1d90b7ff86a36fd3
mkdir -p .neuroforge-aws
cp infra/aws/config/neuroforge-x86.env.example .neuroforge-aws/config.env
chmod 600 .neuroforge-aws/config.env
```

Review and edit the copied configuration. Set
`ROOT_MFA_CONFIRMED=true` only after manually confirming MFA is enabled for the
AWS account root user. Leave `SSH_ALLOWED_CIDR=auto` to resolve the current
CloudShell public IPv4 as an exact `/32`.

Read-only commands:

```bash
# CLOUDSHELL
infra/aws/scripts/00-preflight.sh --config .neuroforge-aws/config.env
infra/aws/scripts/01-plan.sh --config .neuroforge-aws/config.env
```

Generated plans and state remain under `.neuroforge-aws/`, which is ignored by
Git. PEM files are also ignored. Never copy participant data, AWS credentials,
or FreeSurfer license contents into this directory.

Architecture and security rationale:

- [`docs/cloud/aws-automated-deployment-architecture.md`](../../docs/cloud/aws-automated-deployment-architecture.md)
- [`docs/cloud/aws-security-model.md`](../../docs/cloud/aws-security-model.md)
