# Pause, retain, or completely remove an AWS x86 deployment

Permanent teardown is available only through:

1. `11-decommission-plan.sh`
2. `12-decommission.sh`
3. `13-decommission-verify.sh`

There is no generic destroy command. All commands run in **CLOUDSHELL** unless
explicitly labeled **LOCAL MAC**.

## Before any destructive action

Collect evidence on the **LOCAL MAC** and require a successful ZIP open,
manifest read, and SHA-256 receipt:

```bash
# LOCAL MAC
infra/aws/scripts/09-collect-evidence.sh \
  --config .neuroforge-aws/config.env \
  --identity-file "$HOME/.ssh/neuroforge-x86.pem" \
  --output-dir "$HOME/neuroforge-evidence" \
  --apply \
  --confirmation 'COLLECT NEUROFORGE EVIDENCE'
```

The plan also verifies caller/region, state, DeploymentId, exact resource IDs,
required tags, instance/volume/SG/key ownership, termination state, services,
and active scientific containers. A running or unknown pipeline blocks teardown.

The evidence override `I ACCEPT LOSS OF UNCOLLECTED EVIDENCE` is destructive and
recorded. It should not be routine.

## Workflow 1: pause and resume

Pause compute without deleting evidence:

```bash
# CLOUDSHELL
infra/aws/scripts/07-stop.sh \
  --config .neuroforge-aws/config.env \
  --apply \
  --confirmation 'STOP <instance-id>'
```

Resume later:

```bash
# CLOUDSHELL
infra/aws/scripts/08-start.sh \
  --config .neuroforge-aws/config.env \
  --apply \
  --confirmation 'START <instance-id>'
infra/aws/scripts/04-wait-and-verify.sh --config .neuroforge-aws/config.env
```

The public IP can change. Start re-resolves the operator IPv4 `/32` and updates
only the owned SSH rule. EC2 compute/public-IPv4 charges stop while stopped;
EBS and snapshots continue charging.

## Workflow 2: finish compute and retain selected storage

Choose one explicit mode:

- `retain-root-volume`: sets root deletion false before termination and retains
  the encrypted 200 GiB volume.
- `snapshot-then-delete-volume`: creates and waits for one encrypted snapshot,
  terminates, then deletes the volume while retaining the snapshot.
- `retain-selected-volumes`: retains only the state-listed selected managed
  volumes. The current one-volume design is equivalent to retaining root.

Preview:

```bash
# CLOUDSHELL
infra/aws/scripts/11-decommission-plan.sh \
  --config .neuroforge-aws/config.env \
  --volume-mode snapshot-then-delete-volume
```

Every retained volume or snapshot appears in the final report with continuing
cost. Retention is never silent.

## Workflow 3: complete removal

Default plan:

```bash
# CLOUDSHELL
infra/aws/scripts/11-decommission-plan.sh \
  --config .neuroforge-aws/config.env \
  --volume-mode delete-root-volume
```

Review its exact IDs and phrases, then—only after reserved live approval—run:

```bash
# CLOUDSHELL
infra/aws/scripts/12-decommission.sh \
  --config .neuroforge-aws/config.env \
  --volume-mode delete-root-volume \
  --apply \
  --confirm-termination 'TERMINATE <instance-id>' \
  --confirm-volumes 'DELETE VOLUMES <volume-id>' \
  --confirm-iam 'DELETE NEUROFORGE IAM <DeploymentId>'
```

The local PEM is preserved by default. Delete it only with the additional flag
and exact phrase:

```bash
--delete-local-key --confirm-local-key 'DELETE LOCAL KEY neuroforge-x86.pem'
```

An optional budget is also preserved unless separately selected and confirmed:

```bash
--delete-budget --confirm-budget 'DELETE NEUROFORGE BUDGET <budget-name>'
```

## Dependency order

1. Verify local evidence and checksum.
2. Verify no scientific pipeline is active.
3. Stop NeuroForge services and the exact instance.
4. Apply the selected root-volume policy.
5. For snapshot mode, create an encrypted snapshot and wait for completion.
6. Disable termination protection after exact instance confirmation.
7. Terminate and wait.
8. Confirm ENIs are gone.
9. Delete or retain the confirmed volume/snapshot.
10. Delete only the dedicated security group.
11. Delete the AWS key-pair record.
12. Optionally delete the local PEM with its separate confirmation.
13. Remove the role from the instance profile, then profile and instance role.
14. Refuse shared policies; detach/delete only the deployment role/policy and
    non-default policy versions in required order.
15. Independently query EC2, ENIs, SG, key, IAM, snapshots, volumes, and the
    Resource Groups Tagging API.
16. Reopen evidence and confirm SHA-256.
17. Write private JSON plus a redacted Markdown report.

The decommission state file is restartable. Already deleted resources are
reported and skipped; wrong tags, region/account mismatch, ambiguity,
permission denial, active runs, missing evidence, and dependency violations
block progress rather than guessing.

Each completed phase is written atomically. Before the deployer role removes
itself, a credential-handoff phase is recorded so an interrupted rerun uses the
original CloudShell identity instead of trying to assume a deleted role. The
same volume mode is mandatory on every rerun. AWS CLI calls use standard retry
mode with at most five attempts; final verification still fails closed if a
delete response was ambiguous or a resource remains.

## Independent residual verification

```bash
# CLOUDSHELL
infra/aws/scripts/13-decommission-verify.sh \
  --config .neuroforge-aws/config.env
```

It returns nonzero for an unexpected running/stopped instance, public IPv4,
network interface, security group, key pair, IAM resource, tagged volume,
snapshot, or other deployment residual. Explicitly retained storage is allowed
only when it matches the plan and is reported with ongoing cost.

The private machine report stays under `.neuroforge-aws/`. A redacted Markdown
report is generated under `docs/cloud/decommission-runs/` but ignored by Git
until manually reviewed.

## Emergency cost shutdown

For runaway cost, unexpectedly long pipelines, leaving unexpectedly, or an
uncertain configuration:

```bash
# CLOUDSHELL
infra/aws/scripts/emergency-stop.sh \
  --config .neuroforge-aws/config.env \
  --apply \
  --confirmation 'EMERGENCY STOP <instance-id>'
```

Emergency stop never terminates, deletes, snapshots, or changes IAM/network
resources. It writes a private log and reports continuing EBS/snapshot charges.
It is not full decommissioning.

## Partial teardown recovery

Rerun script 11 to reconstruct a plan from live AWS state and the saved
DeploymentId. Rerun script 12 with the same exact confirmations; completed
phases are skipped and missing resources are accepted only when the applicable
phase is recorded.
Do not manually delete by resource name: names are not ownership proof. If a
resource is tagged correctly but missing from state, stop and review it.

For throttling, wait and retry; scripts should use bounded waits. For permission
denial, restore only the exact reviewed permission. Never add AdministratorAccess
as a workaround.

## Billing follow-up

After script 13 returns GO:

- inspect EC2 instances, volumes, snapshots, public IPv4 addresses, and the
  Billing and Cost Management console;
- remember that cost reporting may lag;
- stopped instances retain EBS charges;
- retained root volumes cost roughly the current 200 GiB gp3 monthly estimate;
- retained snapshots charge for stored snapshot data;
- complete removal targets zero deployment-owned billable resources.

The workflow never deletes source repositories, user datasets, fixture source
data, evidence archives, or FreeSurfer licenses automatically.
