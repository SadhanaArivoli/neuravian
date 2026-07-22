# Neuravian x86 verification: AWS launch checklist

Status: **pre-launch only**. No AWS resource has been created. Prices were
checked at `2026-07-15T00:30:15Z` for Linux On-Demand in `us-east-1` (N.
Virginia), excluding tax and data transfer. Recheck immediately before launch.

Application/scientific baseline commit:
`aec1aea247659f43a92a8f2fc39208d15a68914a`.

Exact VM preparation checkout commit:
`8b9614c328463c9dfcb5337303cadde447985299`. This tooling commit descends from
the application baseline and changes verification orchestration, documentation,
timeouts, and tests only; it does not change scientific pipeline behavior.

## Decision and cost envelope

Use `m7i.2xlarge` as the primary instance. Its 8 Intel vCPUs and 32 GiB RAM
match the checked-in 8-thread FastSurfer and 4-worker fMRIPrep parameters
without paying for 16 vCPUs those commands do not currently request. Use
`m6i.2xlarge` if M7i capacity is unavailable. Do not use Spot for this first
empirical pass.

| Instance | vCPU | RAM | Linux On-Demand / h | 4 h incl. 200 GB gp3 | 8 h incl. gp3 | 14 h incl. gp3 | Suitability and main risk |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `c7i.4xlarge` | 16 | 32 GiB | $0.7140 | $2.94 | $5.89 | $10.30 | Highest CPU headroom; risks paying for CPUs the frozen commands may not consume. |
| `c6i.4xlarge` | 16 | 32 GiB | $0.6800 | $2.81 | $5.62 | $9.83 | Adequate and slightly cheaper than C7i; older CPU and still overprovisioned. |
| `m7i.2xlarge` | 8 | 32 GiB | $0.4032 | $1.70 | $3.40 | $5.95 | **Primary:** balanced, exact RAM/thread fit; longer CPU wall time than a 16-vCPU C instance is possible. |
| `m6i.2xlarge` | 8 | 32 GiB | $0.3840 | $1.62 | $3.25 | $5.68 | **Fallback:** same capacity envelope; older CPU can lengthen CPU-heavy stages. |

The table adds gp3 at `$0.08/GB-month` (200 GB is about `$16/month` or
`$0.0219/hour`) but does not add the Amazon-provided public IPv4 charge of
`$0.005/hour` while running. Expected two-session use is 10.5 compute hours on
M7i plus up to 24 hours of retained EBS: about **$4.76**, plus about **$0.06**
for 10.5 public-IPv4 hours. A 14-hour running envelope is about **$6.02**
including gp3 and public IPv4. EBS continues billing while stopped.

Pricing/specification references: [AWS On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/),
[AWS C7i specifications](https://aws.amazon.com/ec2/instance-types/c7i/),
[AWS general-purpose specifications](https://aws.amazon.com/ec2/instance-types/general-purpose/),
[AWS EBS pricing](https://aws.amazon.com/ebs/pricing/), and
[AWS public IPv4 pricing](https://aws.amazon.com/vpc/pricing/).

## Frozen image verification

| Pipeline | Exact pull / expected local image name | Platform | Registry compressed bytes |
| --- | --- | --- | ---: |
| pydeface | `poldracklab/pydeface@sha256:40855352a8dd6dde3f0bcd9ed0fff110b07849871c7c70f62db8bac5ab099541` | `linux/amd64` | 223,911,610 |
| fMRIPrep | `nipreps/fmriprep@sha256:15cbf8dcd17440d26ff5e80e9f7313f1cb3c54f13673f1ec4aed4465e8e12d77` | `linux/amd64` | 2,650,733,239 |
| FastSurfer | `deepmi/fastsurfer@sha256:34c8ff3eb96ad1d14eadbb0cd468ae6bae83072a5845dcb96d7dbc2f7109c14f` | `linux/amd64` via manifest `sha256:de0e93135b54d636316e3f9601b702662794e003365cec07a58b0f613888a5fa` | 1,858,498,488 |

Each registry digest resolved at the timestamp above. The first two are
single-platform manifests whose configs report Linux/amd64; FastSurfer is an
OCI index with the stated Linux/amd64 child manifest. The exact total is
4,733,143,337 compressed bytes. `verification/x86/prepull-images.sh` reads only
these `repository@sha256:digest` references, invokes `docker pull --platform
linux/amd64` under a two-hour hard timeout, and rejects any inspected platform
other than Linux/amd64. There is no tag or `latest` fallback.

## Local variables and one-resource topology

Use one EBS-backed instance in a public subnet, one temporary security group,
one temporary key pair, and no other resource. The instance receives an
auto-assigned public IPv4 address, not an Elastic IP. There is no load balancer,
NAT Gateway, or public application port.

```bash
export AWS_REGION=us-east-1
export APPLICATION_BASELINE_COMMIT=aec1aea247659f43a92a8f2fc39208d15a68914a
export VM_PREPARATION_COMMIT=8b9614c328463c9dfcb5337303cadde447985299
export INSTANCE_TYPE=m7i.2xlarge
export KEY_NAME=neuravian-x86-oneoff
export KEY_FILE="$HOME/.ssh/neuravian-x86-oneoff.pem"
export SG_NAME=neuravian-x86-ssh-oneoff
export FS_LICENSE_LOCAL="$HOME/freesurfer/license.txt"
export VM_FIXTURE=neuravian-fixture
export VM_LICENSE=.neuravian-secrets/freesurfer-license.txt
export MY_IP="$(curl -fsS --connect-timeout 10 --max-time 30 https://checkip.amazonaws.com | tr -d '\n')"
export MY_CIDR="${MY_IP}/32"
test -n "$MY_IP"
test -s "$FS_LICENSE_LOCAL"
```

The confirmed local FreeSurfer source is `$HOME/freesurfer/license.txt`. Never
copy it into this repository, print it, checksum it into evidence, or place it
in shell tracing.

## AWS launch settings

Console settings:

- AMI: Canonical Ubuntu Server 24.04 LTS, 64-bit x86, EBS gp3.
- Instance: `m7i.2xlarge` (`m6i.2xlarge` fallback), On-Demand.
- Root volume: 200 GiB gp3, encrypted, 3,000 IOPS, 125 MiB/s, delete on termination.
- Network: public subnet with auto-assigned public IPv4; no Elastic IP.
- Security group: inbound TCP 22 from the just-measured `$MY_CIDR` only; no
  rules for 3000, 8000, or any other inbound port. Default outbound is enough.
- Metadata: enabled, IMDSv2 required, hop limit 2.
- Termination protection: enabled. Stop protection: disabled so Session A can
  end safely. Shutdown behavior: stop.
- Tag: `Name=neuravian-x86-verification` and `Purpose=oneoff-x86-verification`.

Resolve Canonical's current AMI rather than hard-coding an AMI that can age:

```bash
export AMI_ID="$(aws ssm get-parameter \
  --region "$AWS_REGION" \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameter.Value' --output text)"
aws ec2 describe-images --region "$AWS_REGION" --image-ids "$AMI_ID" \
  --query 'Images[0].{Id:ImageId,Architecture:Architecture,State:State,Name:Name}'
```

Create the key and security group only after replacing `VPC_ID` and `SUBNET_ID`
with the selected default-VPC/public-subnet identifiers:

```bash
umask 077
aws ec2 create-key-pair --region "$AWS_REGION" --key-name "$KEY_NAME" \
  --query 'KeyMaterial' --output text >"$KEY_FILE"
chmod 600 "$KEY_FILE"

export SG_ID="$(aws ec2 create-security-group --region "$AWS_REGION" \
  --group-name "$SG_NAME" --description 'Temporary Neuravian SSH from one IP' \
  --vpc-id "$VPC_ID" --query 'GroupId' --output text)"
aws ec2 authorize-security-group-ingress --region "$AWS_REGION" \
  --group-id "$SG_ID" --protocol tcp --port 22 --cidr "$MY_CIDR"

export INSTANCE_ID="$(aws ec2 run-instances --region "$AWS_REGION" \
  --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" --security-group-ids "$SG_ID" --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address --disable-api-termination \
  --metadata-options 'HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2' \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=200,VolumeType=gp3,Iops=3000,Throughput=125,Encrypted=true,DeleteOnTermination=true}' \
  --instance-initiated-shutdown-behavior stop \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=neuravian-x86-verification},{Key=Purpose,Value=oneoff-x86-verification}]' \
  --query 'Instances[0].InstanceId' --output text)"
aws ec2 wait instance-status-ok --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
export VM_IP="$(aws ec2 describe-instances --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
```

Immediately verify architecture, metadata policy, volume encryption, security
group rules, and termination protection with `describe-instances`,
`describe-volumes`, and `describe-instance-attribute`. Abort before bootstrap
if any value differs.

## Secure fixture and license transfer

Bootstrap once without the fixture/license so the remote checkout and validator
environment exist. Copy the locally audited helper; it checks out exactly the
frozen application commit. It is safe for bootstrap to report both inputs absent:

```bash
scp -i "$KEY_FILE" ./scripts/cloud/bootstrap-x86-ubuntu.sh \
  "ubuntu@$VM_IP:/tmp/bootstrap-x86-ubuntu.sh"
ssh -i "$KEY_FILE" "ubuntu@$VM_IP" \
  "chmod 700 /tmp/bootstrap-x86-ubuntu.sh && timeout --signal=TERM --kill-after=60s 7200 /tmp/bootstrap-x86-ubuntu.sh --commit $VM_PREPARATION_COMMIT --prepull"
```

Transfer exactly the six manifest-listed fixture files (52,914,200 bytes). The
script validates locally, uses resumable `rsync --partial --append-verify`, then
validates every byte on the VM using the committed SHA-256 manifest:

```bash
./verification/x86/transfer-fixture.sh \
  --host "ubuntu@$VM_IP" \
  --identity-file "$KEY_FILE" \
  --destination "$VM_FIXTURE" \
  --repo-dir neuravian
```

Transfer the license separately without printing it:

```bash
ssh -i "$KEY_FILE" "ubuntu@$VM_IP" 'install -d -m 700 "$HOME/.neuravian-secrets"'
scp -i "$KEY_FILE" -p "$FS_LICENSE_LOCAL" "ubuntu@$VM_IP:/tmp/neuravian-fs-license"
ssh -i "$KEY_FILE" "ubuntu@$VM_IP" \
  'install -m 600 /tmp/neuravian-fs-license "$HOME/.neuravian-secrets/freesurfer-license.txt" && rm -f /tmp/neuravian-fs-license && test -s "$HOME/.neuravian-secrets/freesurfer-license.txt" && test "$(stat -c %a "$HOME/.neuravian-secrets/freesurfer-license.txt")" = 600'
```

## Session A: readiness and smoke gates

Expected 2.5 hours; operator maximum 4 hours. Expected disk growth is roughly
5 GB compressed image transfer, 15-35 GB expanded images/builds, 53 MB fixture,
and less than 10 GB smoke/work data. Expected M7i compute + 4-hour running
gp3/IPv4 ceiling: about `$1.72`.

```bash
ssh -i "$KEY_FILE" "ubuntu@$VM_IP"
cd "$HOME/neuravian"
test "$(git rev-parse HEAD)" = "$VM_PREPARATION_COMMIT"
git merge-base --is-ancestor "$APPLICATION_BASELINE_COMMIT" HEAD
export FIXTURE_DIR="$HOME/neuravian-fixture"
export FS_LICENSE="$HOME/.neuravian-secrets/freesurfer-license.txt"
export EVIDENCE_DIR="$HOME/neuravian/verification/x86/evidence"
verification/x86/commands/00-system-check.sh
verification/x86/commands/01-neuravian-health.sh
verification/x86/commands/02-pydeface-verify.sh
verification/x86/commands/03-fmriprep-verify.sh --mode smoke
verification/x86/commands/04-fastsurfer-smoke.sh
verification/x86/commands/07-collect-evidence.sh
```

Stop Session A immediately for wrong architecture/OS, any digest/platform or
fixture mismatch, missing/empty license, failed preflight, OOM, less than 80 GB
free after pulls/build, or smoke failure without an accepted progress marker.
Do not run Session B. Download and verify the evidence archive before stopping:

```bash
scp -i "$KEY_FILE" "ubuntu@$VM_IP:neuravian/verification/x86/neuravian-x86-evidence.zip" ./
unzip -t neuravian-x86-evidence.zip
aws ec2 stop-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-stopped --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
```

Review the ZIP locally while compute billing is stopped. EBS continues at about
`$0.53/day`. Do not terminate: Session B depends on the same encrypted EBS
volume, Docker cache, work directories, and evidence.

## Session B: complete executions and evidence

Expected 8 hours; maximum 14 operator hours, while script watchdogs remain 24
hours for fMRIPrep and 40 hours for FastSurfer. Expected additional disk growth
is up to 100 GB for fMRIPrep and 25 GB for FastSurfer; require at least 80 GB
free before each full run and never overlap them. Expected 8-hour M7i compute +
gp3/IPv4 is about `$3.44`.

```bash
aws ec2 start-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-status-ok --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
export VM_IP="$(aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
ssh -i "$KEY_FILE" "ubuntu@$VM_IP"
cd "$HOME/neuravian"
test "$(git rev-parse HEAD)" = "$VM_PREPARATION_COMMIT"
git merge-base --is-ancestor "$APPLICATION_BASELINE_COMMIT" HEAD
export FIXTURE_DIR="$HOME/neuravian-fixture"
export FS_LICENSE="$HOME/.neuravian-secrets/freesurfer-license.txt"
export EVIDENCE_DIR="$HOME/neuravian/verification/x86/evidence"
verification/x86/commands/00-system-check.sh
verification/x86/commands/01-neuravian-health.sh
df -h "$HOME/neuravian"
verification/x86/commands/03-fmriprep-verify.sh --mode full
df -h "$HOME/neuravian"
verification/x86/commands/05-fastsurfer-full.sh
verification/x86/commands/06-output-validation.sh
verification/x86/commands/07-collect-evidence.sh
verification/x86/commands/08-stop-and-cleanup.sh --stop-services
```

Stop for any non-completed run, validator `all_valid: false`, OOM, disk below 20
GB, cancellation failure, or the 14-hour operator ceiling. Preserve the EBS
volume and collect evidence; do not improvise parameters during the verification
run.

## Budget, idle detection, stop, and cleanup

Before launch, create a `$15` monthly cost budget with email alerts at 50%, 80%,
and 100%. In Billing and Cost Management choose Budgets, Cost budget, Monthly,
Fixed, `$15`, then add actual-cost email thresholds and confirm the email. Also
create a CloudWatch per-instance `CPUUtilization < 5%` alarm for three
consecutive one-hour periods with an EC2 **stop** action. This is a safety net,
not the session timer; long scientific stages can have variable CPU use.

Detect forgotten instances at any time:

```bash
aws ec2 describe-instances --region "$AWS_REGION" \
  --filters 'Name=tag:Purpose,Values=oneoff-x86-verification' \
  'Name=instance-state-name,Values=pending,running,stopping,stopped' \
  --query 'Reservations[].Instances[].{Id:InstanceId,State:State.Name,Type:InstanceType,Launch:LaunchTime,PublicIp:PublicIpAddress}'
```

`stop-instances` stops compute and releases the auto public IPv4, while the
encrypted root EBS and all work/evidence remain billable and resumable.
`terminate-instances` is irreversible and deletes the root volume because
`DeleteOnTermination=true`. Only terminate after both evidence copies validate.

```bash
# Safe between sessions
aws ec2 stop-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-stopped --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"

# Final license removal before final evidence/termination
ssh -i "$KEY_FILE" "ubuntu@$VM_IP" 'rm -f "$HOME/.neuravian-secrets/freesurfer-license.txt" && rmdir "$HOME/.neuravian-secrets"'

# Irreversible final cleanup
aws ec2 modify-instance-attribute --region "$AWS_REGION" --instance-id "$INSTANCE_ID" --no-disable-api-termination
aws ec2 terminate-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-terminated --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
aws ec2 delete-security-group --region "$AWS_REGION" --group-id "$SG_ID"
aws ec2 delete-key-pair --region "$AWS_REGION" --key-name "$KEY_NAME"
rm -f "$KEY_FILE"
```

Final cleanup verification must show no matching non-terminated instance, no
security group, no key pair, and no orphan EBS volume or snapshot.

## Final go/no-go table

| Area | Status | Blocker | Required action |
| --- | --- | --- | --- |
| Fixture | GO | None locally; remote transfer pending by design | Run `transfer-fixture.sh` and require remote SHA-256 validation. |
| License | GO | Secret transfer pending by design | Use the separate 0600 workflow; never log or commit contents. |
| Images | GO | Native execution pending | Digests resolve and linux/amd64 metadata is confirmed; pull only by digest. |
| Bootstrap | GO | VM execution pending | Run only the exact VM preparation commit; verify it contains application baseline `aec1aea...`. |
| Scripts | GO | None | Use exact VM preparation commit `8b9614c...`; retain `aec1aea...` as the application baseline. |
| Timeouts | GO | None | Keep both script watchdogs and 4/14-hour operator ceilings. |
| Validators | GO | Real output absent by design | Require `all_valid: true` after Session B. |
| Evidence | GO | Remote evidence absent by design | Download and validate ZIP before every stop/termination. |
| Storage | GO | Actual expansion unknown | 200 GB encrypted gp3; abort below stated free-space gates. |
| RAM | GO | Actual peak unknown | 32 GiB; stop on OOM and preserve evidence. |
| Security | GO | AWS settings not yet instantiated | SSH from current `/32` only; IMDSv2; termination protection; no app ports. |
| Costs | GO | Prices can change | Recheck immediately before launch; create `$15` budget and stop alarm. |
| Cleanup | GO | Resources do not yet exist | Use exact stop/terminate/SG/key commands and confirm no orphan EBS. |

**Pre-launch verdict: GO after origin/main and fresh-clone verification confirm
the exact preparation commit above.** Launch remains contingent on the
immediately-before-launch price, quota, AMI, `/32`, and console/CLI configuration
rechecks. Native scientific verification remains pending until Sessions A and B
succeed.
