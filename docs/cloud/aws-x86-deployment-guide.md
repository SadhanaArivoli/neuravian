# Deploy Neuravian for native AWS x86 verification

This guide provisions one temporary, native Linux x86_64 Neuravian verification
workstation in an AWS account you control. It is for research software
verification, not participant-data hosting or clinical use.

> **Cost warning:** planning is free, but an applied deployment charges for EC2
> while running, public IPv4 while associated, and EBS while allocated. Stopping
> the instance does not stop EBS or snapshot charges. Prices can change; require
> a fresh `00-preflight.sh` result immediately before launch.

## 1. Security prerequisites

- Enable MFA for the AWS account root user manually.
- Do not create a root access key.
- Sign in with a non-root console identity authorized to bootstrap the reviewed
  Neuravian IAM resources.
- Use AWS CloudShell so the AWS CLI uses the active console session's temporary
  credentials.
- Do not place AWS credentials, PEM content, participant data, or FreeSurfer
  license content in Git, configuration, user-data, logs, or screenshots.

The scripts stop for an account-root identity. They do not automate root MFA
enrollment and do not attach `AdministratorAccess`.

## 2. Clone and review

**CLOUDSHELL**

```bash
git clone https://github.com/SadhanaArivoli/neuravian.git
cd neuravian
git fetch origin main
git checkout --detach origin/main
export AUTOMATION_COMMIT="$(git rev-parse HEAD)"
git log -1 --oneline
```

Review `infra/aws/`, this guide, the
[architecture](aws-automated-deployment-architecture.md), and the
[security model](aws-security-model.md). Record the reviewed automation commit.
The VM itself always checks out the distinct frozen verification commit
`8b9614c328463c9dfcb5337303cadde447985299`.

## 3. Configure without secrets

**CLOUDSHELL**

```bash
mkdir -p .neuravian-aws
cp infra/aws/config/neuravian-x86.env.example .neuravian-aws/config.env
chmod 600 .neuravian-aws/config.env
sed -n '1,200p' .neuravian-aws/config.env
```

After manually confirming root MFA, change `ROOT_MFA_CONFIRMED=false` to
`true`. Leave the fixed region, instance, volume, commit, IMDS, and ownership
values unchanged. `SSH_ALLOWED_CIDR=auto` resolves the current CloudShell public
IPv4 and requires `/32`.

The target is:

- `us-east-1`;
- official Canonical Ubuntu Server 24.04 LTS amd64;
- exactly one On-Demand `m7i.2xlarge`;
- one encrypted 200 GiB gp3 root volume, 3,000 IOPS, 125 MiB/s;
- `DeleteOnTermination=true`;
- IMDSv2 required, hop limit 1;
- one security group with TCP 22 from the current IPv4 `/32`;
- no public 3000/8000;
- no Elastic IP, NAT Gateway, load balancer, database, shared filesystem,
  container service, cluster, or GPU.

## 4. Read-only preflight

**CLOUDSHELL**

```bash
infra/aws/scripts/00-preflight.sh --config .neuravian-aws/config.env
```

Require `GO`. The script checks AWS CLI v2, caller identity, root rejection,
manual root-MFA assertion, current IPv4, region, Canonical AMI and owner,
x86_64, instance-type shape/availability, vCPU quota and conservatively
remaining vCPU capacity, default VPC/public subnet,
existing owned resources, IAM bootstrap capabilities, and current compute/gp3
pricing. It writes a mode-600 JSON plan under `.neuravian-aws/plans/`.

## 5. Resource and IAM plans

**CLOUDSHELL**

```bash
infra/aws/scripts/01-plan.sh --config .neuravian-aws/config.env
infra/aws/scripts/02-bootstrap-iam.sh --config .neuravian-aws/config.env
```

Both are non-mutating by default. Review the rendered policy files under the
ignored plan directory. The instance role has no AWS API actions. PassRole is
limited to the exact instance-role ARN and `ec2.amazonaws.com`.

## 6. Explicit IAM apply — only after final approval

Do not run this during design or dry-run review. After the reserved live
approval is given in the active review session:

**CLOUDSHELL**

```bash
read -r -s -p 'Live approval: ' NEURAVIAN_AWS_LIVE_APPROVAL; echo
export NEURAVIAN_AWS_LIVE_APPROVAL
infra/aws/scripts/02-bootstrap-iam.sh \
  --config .neuravian-aws/config.env \
  --apply \
  --confirmation 'CREATE NEURAVIAN IAM'
```

Never paste the approval into documentation, CI, shell history, or Git. The
first IAM bootstrap runs with the current signed-in console identity.

## 7. Preview EC2 provisioning

**CLOUDSHELL**

```bash
infra/aws/scripts/03-provision.sh \
  --config .neuravian-aws/config.env \
  --dry-run
```

Review the complete request. It must contain `MinCount=1`, `MaxCount=1`, the
resolved official AMI, `m7i.2xlarge`, one public interface, encrypted 200 GiB
gp3, deletion on termination, termination protection, shutdown-to-stop, IMDSv2
hop 1, the permissionless instance profile, and all ownership tags.

An optional budget is a separate, separately approved account mutation:

```bash
# CLOUDSHELL — plan only
infra/aws/scripts/10-cost-controls.sh \
  --config .neuravian-aws/config.env \
  --limit-usd 15 \
  --dry-run
```

Its standalone policy uses the AWS Budget Service authorization actions
`budgets:ModifyBudget` and `budgets:ViewBudget`, plus the documented
`billing:GetBillingViewData` dependency for budget reads; it is not attached to
the EC2 deployer role.

It is not created automatically and is not part of the deployer role.

## 8. Decommission preview before launch

No instance exists yet, so use the structural dry-run:

**CLOUDSHELL**

```bash
infra/aws/scripts/11-decommission-plan.sh \
  --config .neuravian-aws/config.env \
  --volume-mode delete-root-volume \
  --dry-run
infra/aws/scripts/13-decommission-verify.sh \
  --config .neuravian-aws/config.env \
  --dry-run
```

Do not launch unless provisioning and decommissioning previews both pass.

## 9. Explicit one-instance launch — only after final approval

**CLOUDSHELL**

```bash
infra/aws/scripts/03-provision.sh \
  --config .neuravian-aws/config.env \
  --apply \
  --confirmation 'LAUNCH ONE M7I.2XLARGE'
```

The script re-runs all plans and pricing, creates one tagged security group,
one `/32` SSH rule, one deployment key pair, and exactly one instance. A launch
failure rolls back newly created access resources only. It never automatically
terminates an instance or a volume that may contain evidence.

## 10. Secure PEM download

The private key is initially written inside CloudShell with mode 400 and never
printed.

1. **CLOUDSHELL:** note the displayed ignored PEM path.
2. Use CloudShell's **Actions → Download file** control. CloudShell cannot write
   directly to the Mac.
3. **LOCAL MAC:** save the file outside the Git repository and run:

   ```bash
   chmod 400 "$HOME/.ssh/neuravian-x86.pem"
   test -s "$HOME/.ssh/neuravian-x86.pem"
   git -C /path/to/neuravian status --short
   ```

4. Confirm the local copy works before removing the CloudShell copy.
5. Preserve the local key until evidence is verified and final decommissioning
   explicitly authorizes key deletion.

Never display, paste, checksum into public evidence, or commit the PEM.

## 11. Wait and verify bootstrap

**CLOUDSHELL**

```bash
infra/aws/scripts/04-wait-and-verify.sh \
  --config .neuravian-aws/config.env
```

This verifies EC2 status checks, instance type/architecture/AMI, volume,
metadata policy, termination protection, exact tags/SG, Ubuntu, Docker,
Compose, CPU/RAM/disk, exact Git commit, the bootstrap completion marker, and
that no container or scientific pipeline ran.

## 12. Deploy the local-only application stack

Preview first:

```bash
# CLOUDSHELL or LOCAL MAC
infra/aws/scripts/05-deploy-neuravian.sh \
  --config .neuravian-aws/config.env \
  --identity-file "$HOME/.ssh/neuravian-x86.pem" \
  --dry-run
```

After live approval:

```bash
# CLOUDSHELL or LOCAL MAC
infra/aws/scripts/05-deploy-neuravian.sh \
  --config .neuravian-aws/config.env \
  --identity-file "$HOME/.ssh/neuravian-x86.pem" \
  --apply \
  --confirmation 'DEPLOY LOCAL-ONLY NEURAVIAN'
```

Only backend and frontend start. The Compose override must render exactly
`127.0.0.1:3000` and `127.0.0.1:8000`. Health, registry, and preflight endpoints
are checked. The script stops before fixture/license transfer or pipelines.

## 13. SSH tunnel

**LOCAL MAC**

```bash
ssh -i "$HOME/.ssh/neuravian-x86.pem" \
  -L 3000:127.0.0.1:3000 \
  -L 8000:127.0.0.1:8000 \
  "ubuntu@<instance-public-ip>"
```

Use `http://127.0.0.1:3000` locally. Never add public security-group rules for
3000 or 8000.

## 14. Transfer the public fixture

**LOCAL MAC**

```bash
verification/x86/transfer-fixture.sh \
  --host 'ubuntu@<instance-public-ip>' \
  --identity-file "$HOME/.ssh/neuravian-x86.pem" \
  --destination neuravian-fixture \
  --repo-dir neuravian
```

The transfer is restricted to the six manifest-listed public files and verifies
all 52,914,200 bytes. Do not substitute participant data.

## 15. Transfer the FreeSurfer license separately

**LOCAL MAC**

```bash
ssh -i "$HOME/.ssh/neuravian-x86.pem" 'ubuntu@<instance-public-ip>' \
  'install -d -m 700 "$HOME/.neuravian-secrets"'
scp -i "$HOME/.ssh/neuravian-x86.pem" "$HOME/freesurfer/license.txt" \
  'ubuntu@<instance-public-ip>:/tmp/neuravian-fs-license'
ssh -i "$HOME/.ssh/neuravian-x86.pem" 'ubuntu@<instance-public-ip>' \
  'install -m 600 /tmp/neuravian-fs-license "$HOME/.neuravian-secrets/freesurfer-license.txt" && rm -f /tmp/neuravian-fs-license && test -s "$HOME/.neuravian-secrets/freesurfer-license.txt" && test "$(stat -c %a "$HOME/.neuravian-secrets/freesurfer-license.txt")" = 600'
```

Never print the file or put it in user-data/evidence.

## 16. Verification sessions

Follow the checked-in [AWS launch checklist](aws-launch-checklist.md) and
[x86 session plan](x86-session-plan.md):

- Session A: infrastructure, lightweight pydeface, and bounded smoke checks.
- Stop the VM when leaving; EBS continues charging.
- Session B: complete minimal fMRIPrep/FastSurfer verification only after Session
  A gates pass.

Scientific execution is outside the deployment-automation task.

## 17. Status, pause, and resume

**CLOUDSHELL**

```bash
infra/aws/scripts/06-status.sh --config .neuravian-aws/config.env
infra/aws/scripts/07-stop.sh --config .neuravian-aws/config.env --dry-run
infra/aws/scripts/08-start.sh --config .neuravian-aws/config.env --dry-run
```

Applied stop/start require exact instance-ID confirmations. Start re-resolves
the operator IPv4 `/32`, updates only the owned SSH rule if needed, and reports
the new public IP. Rerun script 04 after start.

## 18. Emergency cost stop

For runaway cost, unexpectedly long work, a required departure, or uncertain
scientific state:

**CLOUDSHELL**

```bash
infra/aws/scripts/emergency-stop.sh \
  --config .neuravian-aws/config.env \
  --apply \
  --confirmation 'EMERGENCY STOP <instance-id>'
```

This stops and waits. It never terminates, deletes volumes, or cleans IAM/network
resources. EBS and snapshots continue charging.

## 19. Collect evidence

**LOCAL MAC**

```bash
infra/aws/scripts/09-collect-evidence.sh \
  --config .neuravian-aws/config.env \
  --identity-file "$HOME/.ssh/neuravian-x86.pem" \
  --output-dir "$HOME/neuravian-evidence" \
  --apply \
  --confirmation 'COLLECT NEURAVIAN EVIDENCE'
```

The script downloads only the sanitized ZIP, opens it, validates the manifest,
records SHA-256, and creates an ignored local receipt. Decommissioning blocks
without this receipt unless the exact evidence-loss override is deliberately
provided.

## 20. Complete teardown

Read and follow the [decommissioning guide](aws-decommissioning-guide.md). The
only permanent teardown path is scripts 11, 12, and 13. There is no generic
destroy command.

## 21. Cost inspection

**CLOUDSHELL**

```bash
infra/aws/scripts/06-status.sh --config .neuravian-aws/config.env
aws ec2 describe-volumes --region us-east-1 \
  --filters Name=tag:Project,Values=Neuravian Name=tag:Purpose,Values=x86-verification
aws ec2 describe-snapshots --region us-east-1 --owner-ids self \
  --filters Name=tag:Project,Values=Neuravian Name=tag:Purpose,Values=x86-verification
```

Also inspect AWS Billing and Cost Management; reporting may lag. The planning
baseline is approximately `$0.4032/hour` for EC2, `$0.005/hour` for public IPv4,
and `$16/month` for 200 GiB gp3, but the live plan is authoritative.

## 22. Troubleshooting

- Root identity: sign out and use a non-root IAM/Identity Center role.
- MFA assertion: enable root MFA manually, then update the local config.
- No default/public subnet: stop and provide a reviewed explicit VPC/subnet;
  the automation will not create a VPC/NAT Gateway.
- Quota/availability failure: request quota or wait for capacity; do not silently
  switch instance type or region.
- IP mismatch: rerun preflight from the current network.
- IAM simulation/Access Analyzer failure: have an administrator review the exact
  policy; do not attach AdministratorAccess.
- Bootstrap failure: inspect `/var/log/neuravian-bootstrap.log`; do not leave a
  failed running instance—use emergency stop.
- IMDS hop-limit issue: stop and report. Do not increase to 2 without empirical
  proof and review.

## 23. Privacy and contributions

Use only the approved public fixture. Neuravian does not claim HIPAA, GDPR,
FedRAMP, or clinical compliance. Contributions must preserve plan-only defaults,
exact confirmations, loopback services, ownership tags, evidence gates, and
mocked destructive tests. Region or instance-type adaptations require new
pricing, quota, architecture, policy, and cost review rather than editing one
string.
