# AWS x86 deployment automation architecture

Status: **design checkpoint; no AWS resources have been created**.

This document defines the architecture that the automation under `infra/aws/`
will implement. It deliberately stops before implementation because the chosen
IAM trust, SSH-key lifecycle, storage-retention policy, and cost boundary need
human review. The scientific application baseline remains
`aec1aea247659f43a92a8f2fc39208d15a68914a`; the VM must check out the exact
preparation commit `8b9614c328463c9dfcb5337303cadde447985299`.

## Decision summary

| Area | Selected design | Reason and boundary |
| --- | --- | --- |
| Operator environment | AWS CloudShell | It uses the signed-in console identity and avoids permanent AWS access keys. The caller still needs explicit bootstrap permissions. |
| AWS region | `us-east-1` | Frozen by this verification milestone. A different region requires a new reviewed plan. |
| Compute | Exactly one On-Demand `m7i.2xlarge` | Native x86_64, 8 vCPU, and 32 GiB match the frozen verification commands. No Spot, GPU, Auto Scaling, or fallback type is automatic. |
| Operating system | Current official Canonical Ubuntu Server 24.04 LTS amd64 gp3 AMI | Resolve dynamically, then verify owner, architecture, name, root device, and state before launch. Never accept an arbitrary AMI ID from state. |
| Network | Existing default VPC and one selected public subnet; one dedicated security group | No VPC, NAT Gateway, load balancer, Elastic IP, or public application endpoint is created. If no suitable default VPC/public subnet exists, stop for a reviewed explicit configuration. |
| Inbound access | TCP 22 from one freshly resolved public IPv4 `/32` | Reject `0.0.0.0/0`, `::/0`, ports 3000/8000, IPv6 ingress, and broad ranges. Re-plan when the operator IP changes. |
| Application access | SSH forwarding to VM loopback ports 3000 and 8000 | A generated Compose override binds both published ports to `127.0.0.1`; the canonical Compose file and frontend/backend logic stay unchanged. |
| SSH strategy | One deployment-specific EC2 key pair | This is the clearest option for `rsync` fixture transfer and two-port SSH forwarding. Its PEM is short-lived, never printed, downloaded from CloudShell to the local Mac, and deleted separately during decommissioning. |
| Instance permissions | Instance profile with an EC2-trusted role and no attached permissions policy | Bootstrap needs public package, Git, and registry access, but no AWS API. An empty-permission role makes the trust boundary explicit without granting credentials useful against AWS APIs. |
| Storage | One 200 GiB encrypted gp3 root volume, 3,000 IOPS, 125 MiB/s | No extra data volume. Encryption is mandatory. `DeleteOnTermination=true` is the temporary-VM default, but decommissioning must verify downloaded evidence before termination and offer explicit retention alternatives. |
| Metadata | IMDS enabled, IMDSv2 tokens required, hop limit 1 | Required explicitly at launch and verified afterward. Containers do not need metadata access because the instance role has no AWS API permissions. A change to 2 requires empirical evidence and a new human review. |
| Lifecycle | Shutdown behavior `stop`; termination protection enabled | Stop is reversible. Termination requires the evidence gate, an exact instance-ID confirmation, and explicit protection removal. |
| Decommission default | Delete the root volume with the instance only after the evidence gate | This avoids silent EBS retention. `retain-root-volume`, `snapshot-then-delete-volume`, and `retain-selected-volumes` are deliberate alternatives that must show continuing cost. |

## Trust bootstrap

CloudShell uses the IAM credentials of the active AWS console session; it does
not bypass that identity's authorization. The first run therefore has a small,
unavoidable bootstrap trust boundary:

1. **CLOUDSHELL:** `00-preflight.sh` calls STS to identify the caller, rejects an
   account-root identity, records whether the session is an IAM user or assumed
   role, and requires a manual assertion that root MFA is enabled.
2. **HUMAN / AWS CONSOLE:** an account administrator reviews the bootstrap IAM
   policy. No script enrolls MFA, creates a root key, creates an IAM user, or
   attaches `AdministratorAccess`.
3. **CLOUDSHELL:** the current authorized console identity runs
   `02-bootstrap-iam.sh --apply` and types `CREATE NEUROFORGE IAM`.
4. The bootstrap creates one customer-managed deployer policy, one deployer
   role trusted only by the normalized current IAM principal, one EC2 role, and
   one instance profile. If the current principal cannot be represented safely
   or lacks the required bootstrap permissions, the workflow stops.
5. Later infrastructure mutations occur through the deployer role. Temporary
   STS credentials remain inside the CloudShell console session and are never
   written to repository state.

The deployer trust policy must not trust the account root principal broadly.
For an assumed-role caller, tooling must resolve and require the underlying IAM
role ARN rather than placing an STS session ARN in a long-lived trust policy.
Federated or IAM Identity Center sessions that cannot be scoped reliably are a
manual-administrator integration checkpoint, not a reason to widen trust.

## IAM model

### Bootstrap authority

The signed-in console identity is responsible only for creating and updating
the named NeuroForge-owned IAM resources. The implementation will print its
IAM plan before mutation and use exact names incorporating a non-secret
`DeploymentId`. Destroying owned IAM is a separate, confirmed phase.

### Deployer role

The deployer policy will allow the following categories only:

- read-only STS identity, EC2 inventory, AMI, instance-type offering, pricing,
  Service Quotas, IAM inspection, and Resource Groups Tagging API calls;
- create, tag, inspect, start, stop, and terminate one tag-owned EC2 instance;
- create, tag, inspect, and remove one tag-owned security group and its exact
  SSH rule;
- create, tag where supported, inspect, and remove one deployment key pair;
- inspect and modify the owned encrypted EBS volume and create/delete an
  explicitly confirmed encrypted snapshot;
- modify termination protection only for the exact owned instance;
- `iam:PassRole` on the exact instance-role ARN only, conditioned with
  `iam:PassedToService=ec2.amazonaws.com`;
- narrowly named IAM operations needed to maintain and later remove the two
  owned roles, instance profile, and customer policy;
- optional Budget actions only in a separate policy and separately approved
  script.

Tag conditions are used where the service and action support them. They cannot
be the only ownership proof: scripts require both saved state and the complete
tag set `Project=NeuroForge`, `Purpose=x86-verification`,
`ManagedBy=NeuroForgeProvisioner`, and `DeploymentId=<id>`. AWS documents that
resource-tag conditions are not reliable for constraining `iam:PassRole`, so
PassRole is scoped to the exact role ARN instead.

The policies omit IAM user and access-key creation, Organizations, account and
billing administration, S3, RDS, ECS, EKS, Lambda, Route 53, CloudFront, EFS,
Elastic IPs, load balancers, NAT Gateways, and unrestricted `iam:PassRole`.
Policy JSON must pass local structural tests and IAM Access Analyzer validation
when that API is available to the caller.

### Instance role

The instance role trusts only `ec2.amazonaws.com` and has no permissions policy
attached. User-data does not call AWS APIs. This avoids placing useful AWS API
credentials on a host that mounts the Docker socket. If a future feature needs
AWS access, it requires a separate architecture change; S3 and Systems Manager
are not silently introduced.

## Provisioning stages

Every command is assigned an execution location. A script must fail when its
environment does not match that location.

| Stage | Location | Mutates AWS? | Result |
| --- | --- | --- | --- |
| Clone and review | **CLOUDSHELL** | No | Auditable repository checkout at a reviewed commit. |
| `00-preflight.sh` | **CLOUDSHELL** | No | Identity, MFA gate, region, IP, quota, AMI, VPC/subnet, conflicts, IAM capability, and price inputs; machine-readable plan inputs. |
| `01-plan.sh` | **CLOUDSHELL** | No | Exact request preview, cost envelope, dependency graph, rollback, and GO/NO-GO result. |
| `02-bootstrap-iam.sh` | **CLOUDSHELL** | Only with `--apply` plus exact phrase | Owned deployer/instance IAM resources and non-secret IAM state. |
| `03-provision.sh` | **CLOUDSHELL** | Only with `--apply` plus `LAUNCH ONE M7I.2XLARGE` | One key pair, one security group, one encrypted volume, and exactly one EC2 instance. |
| Download PEM | **CLOUDSHELL → LOCAL MAC**, human-mediated | No AWS mutation | PEM saved on the Mac with mode 400; CloudShell copy retained until download is confirmed. CloudShell cannot write to the Mac directly. |
| `04-wait-and-verify.sh` | **CLOUDSHELL**, SSH to **REMOTE VM** | Read-only | AWS status, immutable configuration, bootstrap marker, Docker, commit, and absence of scientific execution verified. |
| `05-deploy-neuroforge.sh` | **LOCAL MAC** or **CLOUDSHELL**, SSH to **REMOTE VM** | No infrastructure mutation | Canonical stack plus loopback-only Compose override; health checks; tunnel command. Stops before inputs or pipelines. |
| Fixture/license transfer | **LOCAL MAC → REMOTE VM** | No AWS mutation | Six-file public fixture and license transferred separately, permissions/checksums verified without printing license content. |
| Evidence retrieval | **REMOTE VM → LOCAL MAC** | No AWS mutation | Small sanitized evidence ZIP copied and verified locally. No CloudShell-to-Mac assumption. |
| Stop/start/status | **CLOUDSHELL** | Yes for start/stop | Exact owned instance only; IP and SSH rule are revalidated after start. |
| Decommission | **CLOUDSHELL**, with local evidence checks on **LOCAL MAC** | Destructive only after phase-specific confirmations | Evidence gate, termination, selected volume/snapshot policy, network/key/IAM cleanup, and residual-resource report. |

## Network and application model

The system reuses an existing default VPC and a selected subnet that can assign
a public IPv4 address. It creates no shared network infrastructure. The
dedicated security group has one ingress permission:

```text
IPv4 TCP 22 from <current-public-ip>/32
```

Normal egress is allowed for Ubuntu packages, GitHub, Docker registries, and
TemplateFlow. The plan must display the egress rule and stop if account policy
would require creating a NAT Gateway or other chargeable network resource.

The repository's canonical `docker-compose.yml` currently publishes ports on
all interfaces. AWS deployment therefore generates an untracked Compose
override on the VM with `127.0.0.1:3000:3000` and
`127.0.0.1:8000:8000`. Security-group rules are not treated as a substitute for
loopback binding. Users connect from the Mac with SSH local forwarding; no
browser or API port is publicly reachable.

## SSH and key handling

A dedicated EC2 key pair is selected over EC2 Instance Connect and Session
Manager for this first reproducible workflow:

- EC2 Instance Connect avoids a stored EC2 private key but adds temporary-key
  push behavior and availability dependencies that complicate `rsync` and
  beginner-readable two-port tunnels.
- Session Manager avoids inbound SSH but requires an AWS-capable instance role,
  SSM agent/plugin setup, and a less direct file-transfer workflow. Adding S3
  solely for transfer is out of scope.
- A one-off EC2 key pair works directly with SSH, SCP, rsync, and port
  forwarding. Its risk is controlled by deployment scoping and deletion.

`03-provision.sh` creates the key only after launch approval, writes key
material directly to an ignored CloudShell path under `umask 077`, applies mode
400, and never echoes or logs it. The public guide requires a manual download to
the Mac, mode verification, and a typed confirmation before the CloudShell copy
can be removed. State stores only the key-pair name and paths, never key
material. Local PEM deletion is a distinct decommission confirmation and is
never implied by instance termination.

## Storage and evidence retention

The only block device is a 200 GiB encrypted gp3 root volume with 3,000 IOPS
and 125 MiB/s. The initial implementation uses the account's default EBS KMS
key; a customer-managed key would add key-policy and retention complexity and
is not necessary for this non-participant public fixture. Source participant
data must never be uploaded under this workflow.

`DeleteOnTermination=true` is selected because this is a temporary verification
VM whose public fixture and repository exist elsewhere. Evidence protection is
implemented as a mandatory pre-termination gate rather than silent storage
retention. Consequences are intentional:

- stopping the instance retains and charges for the 200 GiB volume;
- default termination deletes the root volume only after evidence has been
  downloaded, checksum-verified, and opened successfully;
- `retain-root-volume` changes the attachment to persist before termination and
  reports the continuing EBS estimate;
- `snapshot-then-delete-volume` must wait for an encrypted completed snapshot;
- `retain-selected-volumes` requires an explicit allow-list and continuing-cost
  report;
- termination is blocked until evidence is present and verified, unless the
  user types the evidence-loss override phrase.

The plan and final report calculate continuing EBS/snapshot estimates. The
decommission verifier returns nonzero for any unexpected billable owned
resource. Evidence archives, source repositories, fixture sources, user data,
and FreeSurfer licenses are never automatically deleted.

## User-data and host bootstrap

User-data is rendered from a committed template only after all substitutions
are validated. It contains the public Git URL and frozen commit, but no
credentials, PEM, fixture, license, participant data, or personal paths. On the
VM it:

1. verifies `x86_64` and Ubuntu 24.04;
2. installs Docker Engine and Compose from Docker's official Ubuntu repository;
3. clones the canonical repository and detaches at the exact VM commit;
4. verifies the application baseline is an ancestor;
5. prepares restricted fixture, secret, work, and evidence directories;
6. prepares, but does not execute, the canonical Compose deployment;
7. optionally pre-pulls only digest-pinned Linux/amd64 images;
8. writes `/var/lib/neuroforge/bootstrap-complete.json` atomically.

Logs go to `/var/log/neuroforge-bootstrap.log` and are scanned for secrets.
Re-entry verifies completed steps rather than recloning or changing the frozen
commit. It never runs pydeface, fMRIPrep, or FastSurfer.

## State, ownership, and repeatability

Generated state lives under `.neuroforge-aws/`, is excluded from Git, uses mode
600, contains no credentials, and is written atomically. `state.json` records
region, caller identity hash, DeploymentId, exact resource identifiers, tags,
configuration digest, AMI, commit, and lifecycle choices. It does not contain
account IDs in public output, IPs in tracked files, keys, licenses, or data.

Names alone never prove ownership. Every mutating operation requires agreement
between state, live AWS identity/region, resource identifiers, and required
tags. A missing state resource discovered by DeploymentId is reported and
blocks mutation until reviewed. An existing owned instance blocks a second
launch. Idempotent scripts reconcile verified state; they do not guess.

## Failure, rollback, and cleanup

Provision rollback is limited to resources created by the failed invocation and
only before an instance reaches a usable state. A launch failure may remove the
new security-group rule/group and AWS key-pair record after recording the local
PEM location. It may not delete a volume that could contain evidence. Once an
instance exists, automatic rollback stops it and reports manual next steps; it
does not terminate it.

Permanent teardown flows only through `11-decommission-plan.sh`,
`12-decommission.sh`, and `13-decommission-verify.sh`. The dependency order is:

1. verify and locally preserve evidence;
2. stop services and the exact instance;
3. disable termination protection after exact instance-ID confirmation;
4. apply the explicitly selected volume mode, then terminate the instance;
5. wait for termination and ENI detachment;
6. retain, snapshot-then-delete, or explicitly delete the volume;
7. remove the dedicated security group;
8. remove the AWS key-pair record and optionally the local PEM;
9. remove the instance profile, instance role, and owned deployer policy/role in
   dependency order, refusing shared or AWS-managed policies;
10. independently query service APIs and the Tagging API for residuals.

`emergency-stop.sh` is intentionally different: it stops one exact owned
instance after `EMERGENCY STOP <instance-id>`, waits for `stopped`, and reports
continuing EBS/snapshot charges. It never terminates or deletes anything.

## Human operations that remain mandatory

- Enable and verify MFA for the AWS account root user outside this system.
- Sign in with an appropriate non-root console identity.
- Review IAM policies and Access Analyzer findings.
- Approve IAM mutation with the exact phrase.
- Review current price/quota/AMI/IP and approve one instance launch.
- Download and protect the PEM; confirm the download before CloudShell removal.
- Transfer the public fixture and FreeSurfer license from the Mac.
- Decide when scientific verification runs; this automation stops beforehand.
- Inspect and download evidence before any destructive action.
- Select the volume retention mode and type each destructive confirmation.
- Check Billing and Cost Management after cleanup because usage reporting can
  lag resource deletion.

## Cost boundary

Planning must query or clearly label the source and timestamp of current prices.
It reports EC2 while running, public IPv4 while running, gp3 while allocated,
and snapshots while retained. It never represents a cached estimate as a quote.
The initial expected shape remains one `m7i.2xlarge`, one public IPv4 while
running, and one 200 GiB gp3 volume. Stop removes compute and public-IPv4 runtime
charges but not EBS charges. Complete removal targets zero deployment-owned
billable resources, subject to AWS billing-report delay.

Budgets are optional and separately approved because AWS Budgets is itself an
account mutation. The automation must not create or modify budgets during
ordinary provisioning.

## Security limitations

This is a research verification deployment, not a regulated clinical platform.
The public subnet and SSH daemon remain Internet-addressable from one `/32`.
CloudShell security depends on the console session and its upstream identity
controls. The VM mounts the Docker socket, so root-equivalent container control
is a deliberate local trust boundary. The default KMS key is account-managed,
not a project-specific separation boundary. Logs and retained EBS volumes can
contain operational metadata. No claim of HIPAA, GDPR, FedRAMP, clinical, or
other regulatory compliance is made.

## Implementation checkpoint

No IAM, EC2, key pair, security group, budget, volume, or other AWS resource was
created while writing this design. Implementation must not begin until the user
reviews these four material choices:

1. deployment-specific EC2 key pair rather than EIC or SSM;
2. explicitly scoped deployer role plus an instance role with no AWS API
   permissions;
3. `DeleteOnTermination=true` with evidence-gated deletion and explicit
   retention alternatives;
4. existing default VPC/public subnet with SSH `/32` and loopback-only app
   ports.

## Primary references

- [AWS CloudShell and console-session IAM credentials](https://docs.aws.amazon.com/cloudshell/latest/userguide/sec-auth-with-identities.html)
- [AWS guidance for restricting `iam:PassRole`](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_passrole.html)
- [EC2 IMDSv2 configuration](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-new-instances.html)
- [Preserving EBS volumes on termination](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/preserving-volumes-on-termination.html)
