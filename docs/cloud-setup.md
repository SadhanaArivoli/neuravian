# Cloud Setup Guide

Cloud execution is optional. NeuroForge remains local-first and transfers only
the verified artifact required by the next remote workflow node.

## Before connecting

1. Deploy the reviewed EC2 configuration in `infra/terraform/aws-ec2/`.
2. Complete the security and launch checklists in `docs/cloud/`.
3. Confirm the remote `/api/health` endpoint is reachable through HTTPS.
4. Keep credentials outside the repository and share them only with authorized
   researchers.

## Add a workspace

1. Open **Workspace** in NeuroForge Desktop.
2. Choose **Add workspace**.
3. Select **EC2 instance ID** for managed start/stop behavior, or **Server URL**
   for an already managed server.
4. Enter a descriptive name, the AWS region and instance ID, and the configured
   Basic authentication credential.
5. Test the connection before running a workflow.

## Mixed local/cloud workflow

When the execution planner reaches a cloud-recommended node, NeuroForge pauses
after the last successful local node. The handoff panel lists the remote nodes
and required artifact type. Selecting **Continue in Cloud** creates or resumes
one idempotent execution, uploads the verified input, launches the remote node,
and synchronizes completed results back to the same workflow history.

Stopping and starting an instance with an ephemeral public IP changes its
`sslip.io` hostname. Follow the gateway update procedure in
`infra/terraform/aws-ec2/README.md`, or use a stable domain for long-lived labs.
