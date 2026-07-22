# AWS x86 automation security model

Status: **design only; no live AWS execution has occurred**.

This threat model applies to the one-instance native Linux x86_64 verification
workflow described in
[`aws-automated-deployment-architecture.md`](aws-automated-deployment-architecture.md).
It does not expand Neuravian's scientific scope and does not establish
regulatory compliance.

## Assets and trust boundaries

| Asset | Location | Primary protection |
| --- | --- | --- |
| AWS console session | Browser and CloudShell | Root MFA prerequisite, non-root operating identity, temporary credentials, least privilege |
| Provisioning authority | Deployer role | Explicit principal trust, narrow customer policy, exact PassRole target, short CloudShell sessions |
| EC2 host | Public subnet | SSH `/32`, key authentication, IMDSv2, encrypted EBS, termination protection, patchable Ubuntu |
| EC2 private key | Temporary CloudShell file and local Mac | `umask 077`, mode 400, never printed, ignored from Git, separate deletion confirmation |
| Public verification fixture | Local Mac and VM | Manifest allow-list, SHA-256 validation, no participant data |
| FreeSurfer license | Local Mac and VM secret directory | Separate transfer, mode 600, no content logging, excluded from evidence and user-data |
| Neuravian evidence | VM then local Mac | Sanitizing collector, integrity manifest, SHA-256, evidence gate before teardown |
| Deployment state | CloudShell/local checkout | Mode 600, atomic JSON, no secrets, state plus live-tag ownership checks |

CloudShell is inside the AWS console trust boundary. It uses the permissions of
the signed-in console identity, so opening CloudShell does not reduce an
overprivileged session. The workflow stops for account root, requires root MFA
to be enabled manually, and never creates root or IAM-user access keys.

## Security objectives

1. Create no billable resource without a human-readable plan, `--apply`, and an
   exact typed confirmation.
2. Create exactly one owned EC2 instance and no adjacent cloud platform.
3. Make the application reachable only through authenticated SSH forwarding.
4. Keep AWS credentials, PEM material, license content, participant data, and
   private local paths out of Git and public logs.
5. Prevent unrelated-resource mutation through state, identifiers, tags,
   identity, and region checks.
6. Preserve reviewed evidence before destructive operations.
7. Make residual costs visible after stop, termination, and partial cleanup.

## Identity and authorization

### Console and CloudShell

- Root MFA is a prerequisite checked by a human; enrollment is never automated.
- Account-root STS identity is a hard stop even if MFA is present.
- CloudShell uses temporary console-session credentials. Scripts never run
  `aws configure`, export secret keys, or copy credential files.
- The initial caller must already have narrowly sufficient permission to create
  the owned IAM bootstrap resources. Lack of permission is a stop condition,
  not justification for `AdministratorAccess`.
- Caller identity, account, and region are rechecked before every mutation.
  Public reports hash or redact the account identifier.

### Deployer and instance roles

- The deployer role trusts one normalized IAM principal, not `*` and not the
  account root principal as a shortcut.
- `iam:PassRole` targets only the exact Neuravian instance-role ARN and uses
  `iam:PassedToService=ec2.amazonaws.com`.
- EC2 resource actions use required ownership tags where AWS supports tag
  authorization, plus service-specific identifier checks.
- The EC2 role has no attached permissions policy. The VM cannot call AWS APIs
  through its role during this milestone.
- No IAM users, access keys, AWS-managed administrator policies, Organizations
  changes, or unrelated roles are created or modified.

IAM Access Analyzer policy validation is a verification gate where available.
A warning about wildcard PassRole, unsupported tag conditions, privilege
escalation, or cross-account access blocks apply until reviewed.

## Network isolation

- The workflow creates one dedicated security group in an existing VPC.
- Ingress is exactly TCP 22 from the freshly resolved operator IPv4 `/32`.
- `0.0.0.0/0`, `::/0`, IPv6 ingress, TCP 3000, TCP 8000, and port ranges are
  rejected both by configuration validation and generated-request tests.
- No Elastic IP, load balancer, public DNS record, NAT Gateway, or application
  ingress rule is created.
- The backend and frontend are published on VM loopback only through an
  untracked Compose override. Users access them through SSH tunnels.
- Normal outbound Internet access is required for Ubuntu, GitHub, Docker image
  registries, and scientific template downloads. This permits data exfiltration
  by compromised VM software and is a documented residual risk.
- The source fixture is public and approved. Participant data must not be
  transferred under this workflow.

## Host and metadata protections

- The AMI is resolved from Canonical's public parameter and independently
  checked for the expected owner, Ubuntu 24.04 naming, amd64 architecture, EBS
  root device, and available state.
- User-data verifies the live kernel architecture and OS release before
  installing software.
- Docker Engine comes from Docker's official Ubuntu repository; Compose uses the
  plugin package.
- IMDS is explicitly configured with `HttpTokens=required`, endpoint enabled,
  and hop limit 1, then verified from EC2 control-plane data. Containers do not
  need metadata access because the instance role has no AWS API permissions.
- The root volume is 200 GiB encrypted gp3. Encryption, size, type, IOPS,
  throughput, and delete-on-termination setting are post-launch assertions.
- Termination protection is enabled; instance-initiated shutdown stops rather
  than terminates.
- The `ubuntu` user receives Docker-group access. Docker socket access is
  effectively root-equivalent on the VM and remains a significant accepted
  risk. Only reviewed images pinned by digest may be pre-pulled.

## SSH private-key lifecycle

The private key exists only after explicit provisioning approval.

1. **CLOUDSHELL:** create one deployment-specific EC2 key pair and redirect key
   material directly to a mode-400 file under `umask 077`; never capture it in
   shell tracing or command output logs.
2. **HUMAN:** use CloudShell's download control to move the file to the local
   Mac. CloudShell cannot write directly to the Mac.
3. **LOCAL MAC:** apply mode 400, verify the file is outside the repository, and
   confirm it is not staged.
4. **HUMAN:** confirm successful download before optionally removing the
   CloudShell copy.
5. **DECOMMISSION:** remove the AWS key-pair record only after termination and
   evidence verification. Delete the local PEM only with the separate exact
   phrase `DELETE LOCAL KEY <filename>`.

The key is not a long-lived AWS credential, but compromise permits SSH access
from an allowed source address. IP restriction does not replace key protection.

## Secret and data handling

The following are forbidden in configuration, user-data, state, Git, public
logs, screenshots, reports, and evidence bundles:

- AWS access-key IDs, secret keys, session tokens, or credential-file content;
- PEM/private-key content;
- FreeSurfer license content;
- participant MRI data or identifiers;
- live account IDs, public IPs, and private user paths in public/redacted mode.

The FreeSurfer license is transferred independently from the public fixture,
installed with mode 600, and validated only with existence/permission checks.
Fixture transfer is limited to the six manifest paths and verified by SHA-256.
Temporary transfer copies are removed only after destination verification.

No fixture, license, or PEM is embedded in user-data. No S3 bucket is introduced
for transfer. The automation never uploads user datasets.

## Logging and evidence

- CloudShell command logs must redact account identifiers in public mode and
  must never enable `set -x` around credentials or key creation.
- VM bootstrap writes `/var/log/neuravian-bootstrap.log`; secret scans are part
  of verification.
- Scientific evidence is collected only by the existing sanitized evidence
  workflow. Approved screenshots use redacted names and require review.
- Before termination, the local evidence archive must exist, open successfully,
  match its recorded SHA-256, and pass its manifest/schema checks.
- An explicit `I ACCEPT LOSS OF UNCOLLECTED EVIDENCE` override is required to
  proceed without valid evidence; it is recorded in the private destruction
  report.
- Public decommission reports omit account IDs, IPs, resource IDs where they
  could identify the account, local key paths, credentials, and license content.

## Ownership and unrelated-resource protection

All supported resources carry, where tagging is supported:

```text
Project=Neuravian
Purpose=x86-verification
ManagedBy=NeuravianProvisioner
DeploymentId=<unique-id>
```

Mutation requires the resource ID in state, matching live region/account,
matching DeploymentId, and the full static tag set. Names are informational.
Wrong or missing tags block deletion. Resources found by DeploymentId but
missing from state are reported for review. Default security groups, VPC
components, AWS-managed policies, shared customer policies, IAM users, and
unrelated resources are never cleanup targets.

## Stop, emergency stop, and decommission

These actions are intentionally distinct:

- **Stop:** ends EC2 compute execution and the running public IPv4 charge;
  encrypted EBS and any snapshots continue charging.
- **Emergency stop:** after `EMERGENCY STOP <instance-id>`, stops the exact owned
  instance and waits. It never collects large evidence, terminates, deletes, or
  changes IAM/network resources.
- **Decommission:** first validates evidence, then uses separate confirmations
  for termination, volume/snapshot decisions, IAM removal, and local-key
  deletion. It is restartable and derives progress from live AWS state.

The selected root-volume setting is `DeleteOnTermination=true`. Termination is
blocked until evidence has been downloaded, checksum-verified, and opened.
Explicit alternatives are `retain-root-volume`,
`snapshot-then-delete-volume`, and `retain-selected-volumes`; each reports
continuing charges and requires deliberate selection. Snapshot and retained
volume storage incur charges. Final verification uses both service-specific
APIs and the Resource Groups Tagging API and fails if an unexpected owned
billable resource remains.

## Threats and mitigations

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Root or overprivileged console session | Root identity hard stop, manual root-MFA gate, least-privilege deployer role | Upstream console administrator can still override controls. |
| Permanent credential leakage | CloudShell temporary credentials; no access-key creation/storage | Console/session compromise remains possible. |
| IAM privilege escalation | Exact trust principal, exact PassRole ARN/service, policy linting | Bootstrap caller necessarily has IAM creation authority. |
| Public application exposure | SSH-only `/32`, no 3000/8000 ingress, loopback Compose override | SSH remains public to one address; operator IP may be shared/NATed. |
| Malicious or compromised container | Digest pins, x86 platform check, no AWS permissions on instance role | Docker socket grants host-root capability; registries and images remain supply-chain dependencies. |
| Secret leakage in logs/evidence | No shell tracing, content exclusions, sanitizer, scans, redacted reports | Novel secret formats or manual screenshots may evade automated detection. |
| Accidental evidence deletion | Termination protection, mandatory local evidence gate, exact confirmations, explicit retention alternatives | The evidence-loss override remains available and must be treated as destructive. |
| Wrong-resource deletion | State plus identifiers plus tags plus identity/region checks | AWS tagging coverage is incomplete; service-specific checks are required. |
| Runaway cost | One-instance invariant, plan estimates, status/emergency stop, optional separately approved budget | Pricing and billing reports can lag; retained EBS/snapshots continue charging. |
| Participant-data exposure | Public fixture only, explicit prohibition, no S3 or uploads | A user with shell access could manually violate the workflow. |

## Verification requirements before apply

Implementation is not eligible for live use until mocked/non-billable tests
prove:

- plan and dry-run modes make no mutations;
- exact confirmations gate every mutation/destructive phase;
- generated IAM, launch, ingress, storage, metadata, and tagging requests match
  this design;
- invalid architecture, OS, region, instance type, CIDR, encryption, IMDS, tag,
  state, caller, and duplicate-instance conditions fail closed;
- secret/key/license contents never appear in output;
- stop/start, rollback, interrupted decommission, retention modes, evidence
  gates, emergency stop, and residual-resource detection work against mocked AWS
  responses;
- ShellCheck, shell syntax, JSON validation, secret scans, and `git diff
  --check` pass.

Even after those tests, no IAM or EC2 action is authorized until the user says
exactly `APPROVE NEURAVIAN AWS AUTOMATION`.

## Remaining limitations

- This design relies on an Internet-accessible SSH endpoint rather than a
  private network, VPN, EIC-only, or Session Manager-only posture.
- Default-VPC reuse assumes a suitable public subnet; the workflow does not
  remediate accounts without one.
- Default EBS encryption uses an AWS-managed account key, not a
  project-controlled customer key.
- The Docker daemon and socket are privileged local components.
- CloudTrail, GuardDuty, centralized log retention, vulnerability scanning, and
  host intrusion detection are not provisioned by this one-instance workflow.
- Cost estimates are planning aids, not billing guarantees.
- AWS service and policy behavior can change; live preflight must revalidate
  current documentation and account controls.
- No HIPAA, GDPR, FedRAMP, clinical, security certification, or regulatory
  compliance claim is made.

## References

- [CloudShell IAM authentication](https://docs.aws.amazon.com/cloudshell/latest/userguide/sec-auth-with-identities.html)
- [Restricting IAM role passing](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_passrole.html)
- [IAM Access Analyzer policy checks](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-reference-policy-checks.html)
- [Requiring IMDSv2 for new EC2 instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-new-instances.html)
- [EBS volume preservation and continuing charges](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/preserving-volumes-on-termination.html)
