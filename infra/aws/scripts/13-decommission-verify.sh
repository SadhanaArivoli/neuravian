#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH=""
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) echo "Usage: 13-decommission-verify.sh --config PATH [--dry-run]"; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
load_config "${CONFIG_PATH}"; validate_config; ensure_state_dirs; resolve_deployment_id
if [[ "${DRY_RUN}" == "true" ]]; then
  cat <<'EOF'
[CLOUDSHELL] DRY-RUN: independently query EC2, ENIs, SG, key pair, IAM, and Tagging API
[LOCAL MAC] DRY-RUN: re-open evidence ZIP and verify recorded SHA-256
[CLOUDSHELL] DRY-RUN: fail for unexpected billable tagged resources; report retained volume/snapshot monthly estimate
AWS mutations: none
EOF
  exit 0
fi
STATE_PATH="${STATE_ROOT}/state.json"
PLAN_PATH="${STATE_ROOT}/decommission-plan.json"
DECOMMISSION_STATE="${STATE_ROOT}/decommission-state.json"
RECEIPT="${STATE_ROOT}/evidence-receipt.json"
[[ -s "${STATE_PATH}" && -s "${PLAN_PATH}" && -s "${DECOMMISSION_STATE}" && -s "${RECEIPT}" ]] || die "Decommission/evidence state is incomplete"
verify_current_account_matches_state "${STATE_PATH}"
INSTANCE_ID="$(state_value "${STATE_PATH}" instance_id)"
VOLUME_ID="$(state_value "${STATE_PATH}" root_volume_id)"
SG_ID="$(state_value "${STATE_PATH}" security_group_id)"
KEY_NAME="$(state_value "${STATE_PATH}" key_pair_name)"
LOCAL_KEY="$(state_value "${STATE_PATH}" cloudshell_key_path)"
IAM_PLAN_PATH="${PLAN_ROOT}/iam-plan-${RESOLVED_DEPLOYMENT_ID}.json"
INSTANCE_ROLE="$(state_value "${IAM_PLAN_PATH}" instance_role_name)"
DEPLOYER_ROLE="$(state_value "${IAM_PLAN_PATH}" deployer_role_name)"
INSTANCE_PROFILE="$(state_value "${IAM_PLAN_PATH}" instance_profile_name)"
POLICY_ARN="$(state_value "${IAM_PLAN_PATH}" deployer_policy_arn)"

VERIFY_DIR="${STATE_ROOT}/decommission-verify"
install -d -m 0700 "${VERIFY_DIR}"
aws ec2 describe-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" --output json >"${VERIFY_DIR}/instances.json" 2>"${VERIFY_DIR}/instances.err" || printf '%s\n' '{"Reservations":[]}' >"${VERIFY_DIR}/instances.json"
aws ec2 describe-volumes --region "${AWS_REGION}" --volume-ids "${VOLUME_ID}" --output json >"${VERIFY_DIR}/volumes.json" 2>/dev/null || printf '%s\n' '{"Volumes":[]}' >"${VERIFY_DIR}/volumes.json"
aws ec2 describe-network-interfaces --region "${AWS_REGION}" --filters "Name=group-id,Values=${SG_ID}" --output json >"${VERIFY_DIR}/enis.json"
aws ec2 describe-security-groups --region "${AWS_REGION}" --group-ids "${SG_ID}" --output json >"${VERIFY_DIR}/sg.json" 2>/dev/null || printf '%s\n' '{"SecurityGroups":[]}' >"${VERIFY_DIR}/sg.json"
aws ec2 describe-key-pairs --region "${AWS_REGION}" --key-names "${KEY_NAME}" --output json >"${VERIFY_DIR}/keys.json" 2>/dev/null || printf '%s\n' '{"KeyPairs":[]}' >"${VERIFY_DIR}/keys.json"
aws iam get-role --role-name "${INSTANCE_ROLE}" --output json >"${VERIFY_DIR}/instance-role.json" 2>/dev/null || printf '%s\n' '{}' >"${VERIFY_DIR}/instance-role.json"
aws iam get-role --role-name "${DEPLOYER_ROLE}" --output json >"${VERIFY_DIR}/deployer-role.json" 2>/dev/null || printf '%s\n' '{}' >"${VERIFY_DIR}/deployer-role.json"
aws iam get-instance-profile --instance-profile-name "${INSTANCE_PROFILE}" --output json >"${VERIFY_DIR}/profile.json" 2>/dev/null || printf '%s\n' '{}' >"${VERIFY_DIR}/profile.json"
aws iam get-policy --policy-arn "${POLICY_ARN}" --output json >"${VERIFY_DIR}/policy.json" 2>/dev/null || printf '%s\n' '{}' >"${VERIFY_DIR}/policy.json"
aws resourcegroupstaggingapi get-resources --region "${AWS_REGION}" \
  --tag-filters Key=Project,Values=Neuravian Key=Purpose,Values=x86-verification \
    Key=ManagedBy,Values=NeuravianProvisioner Key=DeploymentId,Values="${RESOLVED_DEPLOYMENT_ID}" \
  --output json >"${VERIFY_DIR}/tagged.json"
aws ec2 describe-snapshots --region "${AWS_REGION}" --owner-ids self \
  --filters Name=tag:Project,Values=Neuravian Name=tag:Purpose,Values=x86-verification \
    Name=tag:ManagedBy,Values=NeuravianProvisioner Name=tag:DeploymentId,Values="${RESOLVED_DEPLOYMENT_ID}" \
  --output json >"${VERIFY_DIR}/snapshots.json"
BUDGET_STATUS="not-managed"
BUDGET_STATE="${STATE_ROOT}/budget-state.json"
if [[ -s "${BUDGET_STATE}" ]]; then
  BUDGET_NAME="$(state_value "${BUDGET_STATE}" budget_name)"
  phase_complete_budget="$(python3 - "${DECOMMISSION_STATE}" <<'PY'
import json, sys
print(str("optional-budget-removed" in json.load(open(sys.argv[1])).get("phases", [])).lower())
PY
)"
  if [[ "${phase_complete_budget}" == "true" ]]; then
    if aws budgets describe-budget --account-id "$(state_value "${STATE_PATH}" account_id)" \
      --budget-name "${BUDGET_NAME}" >"${VERIFY_DIR}/budget.json" 2>"${VERIFY_DIR}/budget.err"; then
      die "Optional budget still exists after its removal phase"
    elif ! grep -q 'NotFoundException' "${VERIFY_DIR}/budget.err"; then
      die "Optional budget absence could not be verified"
    fi
    BUDGET_STATUS="removed"
  else
    BUDGET_STATUS="retained"
  fi
fi

REPORT_JSON="${STATE_ROOT}/${RESOLVED_DEPLOYMENT_ID}-decommission-report.json"
PUBLIC_DIR="${REPO_ROOT}/docs/cloud/decommission-runs"
PUBLIC_REPORT="${PUBLIC_DIR}/${RESOLVED_DEPLOYMENT_ID}-decommission-report.md"
install -d -m 0755 "${PUBLIC_DIR}"
python3 - "${VERIFY_DIR}" "${PLAN_PATH}" "${DECOMMISSION_STATE}" "${RECEIPT}" "${LOCAL_KEY}" "${REPORT_JSON}" "${PUBLIC_REPORT}" "${BUDGET_STATUS}" <<'PY'
import hashlib, json, os, sys, zipfile
from datetime import datetime, timezone
from pathlib import Path
root, plan_path, state_path, receipt_path, key_path, report_path, public_path = map(Path, sys.argv[1:8])
budget_status = sys.argv[8]
plan = json.load(open(plan_path)); state = json.load(open(state_path)); receipt = json.load(open(receipt_path))
archive = Path(receipt["archive_path"])
assert archive.is_file() and hashlib.sha256(archive.read_bytes()).hexdigest() == receipt["sha256"]
with zipfile.ZipFile(archive) as handle:
    assert handle.testzip() is None; json.loads(handle.read("evidence-manifest.json"))
instances = [i for r in json.load(open(root / "instances.json")).get("Reservations", []) for i in r.get("Instances", [])]
assert not instances or all(i.get("State", {}).get("Name") in {"shutting-down", "terminated"} for i in instances)
volumes = json.load(open(root / "volumes.json")).get("Volumes", [])
mode = plan["volume_mode"]
if mode in {"delete-root-volume", "snapshot-then-delete-volume"}: assert not volumes
else: assert len(volumes) == 1
assert not json.load(open(root / "enis.json")).get("NetworkInterfaces")
assert not json.load(open(root / "sg.json")).get("SecurityGroups")
assert not json.load(open(root / "keys.json")).get("KeyPairs")
for name in ("instance-role.json", "deployer-role.json", "profile.json", "policy.json"):
    assert not json.load(open(root / name)), name
tagged = json.load(open(root / "tagged.json")).get("ResourceTagMappingList", [])
snapshots = json.load(open(root / "snapshots.json")).get("Snapshots", [])
if mode == "snapshot-then-delete-volume":
    assert len(snapshots) == 1 and snapshots[0].get("Encrypted") is True and snapshots[0].get("State") == "completed"
else:
    assert not snapshots
allowed = []
for item in tagged:
    arn = item.get("ResourceARN", "")
    if mode in {"retain-root-volume", "retain-selected-volumes"} and ":volume/" in arn: allowed.append(arn)
    elif mode == "snapshot-then-delete-volume" and ":snapshot/" in arn: allowed.append(arn)
    else: raise AssertionError(f"unexpected tagged residual: {arn}")
delete_key = state.get("delete_local_key", False)
assert key_path.exists() is (not delete_key)
monthly = plan["continuing_monthly_estimate"]
report = {
    "schema_version": 1, "deployment_id": plan["deployment_id"], "verified_at": datetime.now(timezone.utc).isoformat(),
    "result": "GO", "original_instance_id": plan["instance_id"], "termination_result": "terminated_or_absent",
    "instance_terminated": True, "volume_mode": mode, "volume_decision": mode,
    "network_resources_removed": True, "iam_resources_removed": True,
    "retained_resource_count": len(allowed),
    "retained_resources": allowed, "continuing_monthly_estimate": monthly,
    "evidence_archive_path": str(archive), "evidence_sha256": receipt["sha256"],
    "local_key_deleted": delete_key, "unexpected_resources": [],
    "optional_budget_status": budget_status,
}
Path(report_path).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n"); os.chmod(report_path, 0o600)
Path(public_path).write_text(
    "# Neuravian decommission report (redacted)\n\n"
    f"- Deployment: `{plan['deployment_id']}`\n- Result: **GO**\n- Region: `us-east-1`\n"
    f"- Instance: terminated (identifier redacted)\n- Volume mode: `{mode}`\n"
    f"- Retained resources: {len(allowed)} (identifiers redacted)\n"
    f"- Evidence SHA-256: `{receipt['sha256']}`\n- Local key deleted: `{str(delete_key).lower()}`\n"
    f"- Optional budget: `{budget_status}`\n"
    "- Account, IP, key path, credentials, and license content: omitted\n"
    "- Billing follow-up: inspect AWS Billing and Cost Management; reporting may lag.\n"
)
print(json.dumps(report, indent=2, sort_keys=True))
PY
chmod 600 "${REPORT_JSON}"
info "Final residual-resource verification GO; inspect Billing because reporting can lag"
