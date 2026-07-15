#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH=""
VOLUME_MODE="delete-root-volume"
APPLY=false
CONFIRM_TERMINATION=""
CONFIRM_VOLUMES=""
CONFIRM_IAM=""
DELETE_LOCAL_KEY=false
CONFIRM_LOCAL_KEY=""
EVIDENCE_OVERRIDE=""
DELETE_BUDGET=false
CONFIRM_BUDGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --volume-mode) VOLUME_MODE="$2"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    --confirm-termination) CONFIRM_TERMINATION="$2"; shift 2 ;;
    --confirm-volumes) CONFIRM_VOLUMES="$2"; shift 2 ;;
    --confirm-iam) CONFIRM_IAM="$2"; shift 2 ;;
    --delete-local-key) DELETE_LOCAL_KEY=true; shift ;;
    --confirm-local-key) CONFIRM_LOCAL_KEY="$2"; shift 2 ;;
    --evidence-override) EVIDENCE_OVERRIDE="$2"; shift 2 ;;
    --delete-budget) DELETE_BUDGET=true; shift ;;
    --confirm-budget) CONFIRM_BUDGET="$2"; shift 2 ;;
    --dry-run) shift ;;
    -h|--help)
      echo "Usage: 12-decommission.sh --config PATH --volume-mode MODE [--apply plus exact phase confirmations]"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
load_config "${CONFIG_PATH}"; validate_config; ensure_state_dirs; resolve_deployment_id
STATE_PATH="${STATE_ROOT}/state.json"
PLAN_PATH="${STATE_ROOT}/decommission-plan.json"
IAM_PLAN_PATH="${PLAN_ROOT}/iam-plan-${RESOLVED_DEPLOYMENT_ID}.json"
DECOMMISSION_STATE="${STATE_ROOT}/decommission-state.json"
phase_complete() {
  local phase="$1"
  [[ -s "${DECOMMISSION_STATE}" ]] && python3 - "${DECOMMISSION_STATE}" "${phase}" <<'PY'
import json, sys
raise SystemExit(0 if sys.argv[2] in json.load(open(sys.argv[1])).get("phases", []) else 1)
PY
}
if [[ "${APPLY}" != "true" ]]; then
  "${SCRIPT_DIR}/11-decommission-plan.sh" --config "${CONFIG_PATH}" --volume-mode "${VOLUME_MODE}" --dry-run
  echo "[CLOUDSHELL] DRY-RUN: no terminate, volume, snapshot, network, key, IAM, or local-file deletion occurred"
  exit 0
fi
require_live_approval
[[ -s "${STATE_PATH}" && -s "${IAM_PLAN_PATH}" ]] || die "Deployment/IAM state is missing"
PLAN_ARGS=(--config "${CONFIG_PATH}" --volume-mode "${VOLUME_MODE}")
[[ -n "${EVIDENCE_OVERRIDE}" ]] && PLAN_ARGS+=(--evidence-override "${EVIDENCE_OVERRIDE}")
"${SCRIPT_DIR}/11-decommission-plan.sh" "${PLAN_ARGS[@]}" >/dev/null
INSTANCE_ID="$(state_value "${PLAN_PATH}" instance_id)"
VOLUME_ID="$(state_value "${PLAN_PATH}" root_volume_id)"
SG_ID="$(state_value "${PLAN_PATH}" security_group_id)"
KEY_NAME="$(state_value "${PLAN_PATH}" key_pair_name)"
LOCAL_KEY="$(state_value "${STATE_PATH}" cloudshell_key_path)"
[[ "${CONFIRM_TERMINATION}" == "TERMINATE ${INSTANCE_ID}" ]] || die "Exact instance termination confirmation is required"
if [[ "${VOLUME_MODE}" == "delete-root-volume" || "${VOLUME_MODE}" == "snapshot-then-delete-volume" ]]; then
  [[ "${CONFIRM_VOLUMES}" == "DELETE VOLUMES ${VOLUME_ID}" ]] || die "Exact volume deletion confirmation is required"
fi
[[ "${CONFIRM_IAM}" == "DELETE NEUROFORGE IAM ${RESOLVED_DEPLOYMENT_ID}" ]] || die "Exact IAM removal confirmation is required"
if [[ "${DELETE_LOCAL_KEY}" == "true" ]]; then
  [[ "${CONFIRM_LOCAL_KEY}" == "DELETE LOCAL KEY $(basename "${LOCAL_KEY}")" ]] || die "Exact local-key deletion confirmation is required"
fi
BUDGET_STATE="${STATE_ROOT}/budget-state.json"
if [[ "${DELETE_BUDGET}" == "true" ]]; then
  [[ -s "${BUDGET_STATE}" ]] || die "No owned optional budget state exists"
  BUDGET_NAME="$(state_value "${BUDGET_STATE}" budget_name)"
  [[ "${CONFIRM_BUDGET}" == "DELETE NEUROFORGE BUDGET ${BUDGET_NAME}" ]] || die "Exact optional-budget deletion confirmation is required"
fi

record_phase() {
  local phase="$1"
  python3 - "${DECOMMISSION_STATE}" "${phase}" "${VOLUME_MODE}" "${DELETE_LOCAL_KEY}" <<'PY'
import json, os, sys
path, phase, mode, delete_key = sys.argv[1:]
value = json.load(open(path)) if os.path.exists(path) else {"schema_version": 1, "phases": []}
if phase not in value["phases"]: value["phases"].append(phase)
value.update({"last_verified_phase": phase, "volume_mode": mode, "delete_local_key": delete_key == "true"})
temporary = path + ".tmp"
with open(temporary, "w") as stream:
    json.dump(value, stream, indent=2, sort_keys=True); stream.write("\n")
os.chmod(temporary, 0o600); os.replace(temporary, path)
PY
}

record_snapshot_id() {
  local snapshot_id="$1"
  python3 - "${DECOMMISSION_STATE}" "${snapshot_id}" <<'PY'
import json, os, sys
path, snapshot = sys.argv[1:]
value = json.load(open(path)) if os.path.exists(path) else {"schema_version": 1, "phases": []}
value["retained_snapshot_id"] = snapshot or None
temporary = path + ".tmp"
with open(temporary, "w") as stream:
    json.dump(value, stream, indent=2, sort_keys=True); stream.write("\n")
os.chmod(temporary, 0o600); os.replace(temporary, path)
PY
}

DEPLOYER_SESSION_ACTIVE=false
if ! phase_complete "owned-iam-removed" && ! phase_complete "deployer-self-removal-started"; then
  assume_deployer_session "${STATE_PATH}" "${IAM_PLAN_PATH}" "decommission-${RESOLVED_DEPLOYMENT_ID}"
  DEPLOYER_SESSION_ACTIVE=true
  trap clear_deployer_session EXIT
fi
INSTANCE_STATE="$(state_value "${PLAN_PATH}" instance_state)"
DEVICE_NAME=""
PUBLIC_IP=""
if ! phase_complete "instance-terminated" && [[ "${INSTANCE_STATE}" != "absent" ]]; then
  INSTANCE_JSON="${STATE_ROOT}/decommission-instance.json"
  aws ec2 describe-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" --output json >"${INSTANCE_JSON}"
  read -r INSTANCE_STATE DEVICE_NAME PUBLIC_IP < <(python3 - "${INSTANCE_JSON}" <<'PY'
import json, sys
i = json.load(open(sys.argv[1]))["Reservations"][0]["Instances"][0]
print(i["State"]["Name"], i.get("BlockDeviceMappings", [{}])[0].get("DeviceName", ""), i.get("PublicIpAddress", ""))
PY
)
fi

if ! phase_complete "instance-stopped" && [[ "${INSTANCE_STATE}" == "running" && -s "${LOCAL_KEY}" && -n "${PUBLIC_IP}" ]]; then
  KNOWN_HOSTS="${STATE_ROOT}/known_hosts"; touch "${KNOWN_HOSTS}"; chmod 600 "${KNOWN_HOSTS}"
  ssh -i "${LOCAL_KEY}" -o BatchMode=yes -o ConnectTimeout=20 \
    -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
    "ubuntu@${PUBLIC_IP}" 'cd "$HOME/neuroforge" && if [[ -f compose.aws-loopback.yaml ]]; then docker compose -f docker-compose.yml -f compose.aws-loopback.yaml down; fi'
fi
if ! phase_complete "instance-stopped" && [[ "${INSTANCE_STATE}" == "running" || "${INSTANCE_STATE}" == "pending" ]]; then
  aws ec2 stop-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" >/dev/null
  aws ec2 wait instance-stopped --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}"
fi
phase_complete "instance-stopped" || record_phase "instance-stopped"

SNAPSHOT_ID="$(state_value "${DECOMMISSION_STATE}" retained_snapshot_id 2>/dev/null || true)"
[[ "${SNAPSHOT_ID}" == "None" ]] && SNAPSHOT_ID=""
if ! phase_complete "instance-terminated" && [[ "${VOLUME_MODE}" != "delete-root-volume" && -n "${DEVICE_NAME}" ]]; then
  aws ec2 modify-instance-attribute --region "${AWS_REGION}" --instance-id "${INSTANCE_ID}" \
    --block-device-mappings "[{\"DeviceName\":\"${DEVICE_NAME}\",\"Ebs\":{\"DeleteOnTermination\":false}}]"
fi
if [[ "${VOLUME_MODE}" == "snapshot-then-delete-volume" ]] && ! phase_complete "encrypted-snapshot-complete"; then
  mapfile -t EXISTING_SNAPSHOTS < <(aws ec2 describe-snapshots --region "${AWS_REGION}" --owner-ids self \
    --filters Name=tag:Project,Values=NeuroForge Name=tag:Purpose,Values=x86-verification \
      Name=tag:ManagedBy,Values=NeuroForgeProvisioner Name=tag:DeploymentId,Values="${RESOLVED_DEPLOYMENT_ID}" \
    --query 'Snapshots[].SnapshotId' --output text | tr '\t' '\n')
  [[ "${#EXISTING_SNAPSHOTS[@]}" -le 1 ]] || die "Multiple owned snapshots exist; refusing to choose one"
  SNAPSHOT_ID="${EXISTING_SNAPSHOTS[0]:-}"
  SNAPSHOT_TAGS="ResourceType=snapshot,Tags=[{Key=Name,Value=neuroforge-${RESOLVED_DEPLOYMENT_ID}-final},{Key=Project,Value=NeuroForge},{Key=Purpose,Value=x86-verification},{Key=ManagedBy,Value=NeuroForgeProvisioner},{Key=DeploymentId,Value=${RESOLVED_DEPLOYMENT_ID}}]"
  if [[ -z "${SNAPSHOT_ID}" ]]; then
    SNAPSHOT_ID="$(aws ec2 create-snapshot --region "${AWS_REGION}" --volume-id "${VOLUME_ID}" \
      --description "NeuroForge x86 final retained snapshot" --tag-specifications "${SNAPSHOT_TAGS}" \
      --query SnapshotId --output text)"
  fi
  aws ec2 wait snapshot-completed --region "${AWS_REGION}" --snapshot-ids "${SNAPSHOT_ID}"
  SNAPSHOT_ENCRYPTED="$(aws ec2 describe-snapshots --region "${AWS_REGION}" --snapshot-ids "${SNAPSHOT_ID}" --query 'Snapshots[0].Encrypted' --output text)"
  [[ "${SNAPSHOT_ENCRYPTED}" == "True" || "${SNAPSHOT_ENCRYPTED}" == "true" ]] || die "Retained snapshot is not encrypted"
  record_snapshot_id "${SNAPSHOT_ID}"
  record_phase "encrypted-snapshot-complete"
fi

if ! phase_complete "instance-terminated"; then
  if [[ "${INSTANCE_STATE}" != "terminated" && "${INSTANCE_STATE}" != "absent" ]]; then
    aws ec2 modify-instance-attribute --region "${AWS_REGION}" --instance-id "${INSTANCE_ID}" --no-disable-api-termination
    aws ec2 terminate-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" >/dev/null
    aws ec2 wait instance-terminated --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}"
  fi
  record_phase "instance-terminated"
fi

if ! phase_complete "volume-policy-complete" && [[ "${VOLUME_MODE}" == "snapshot-then-delete-volume" ]]; then
  if aws ec2 describe-volumes --region "${AWS_REGION}" --volume-ids "${VOLUME_ID}" >/dev/null 2>&1; then
    aws ec2 delete-volume --region "${AWS_REGION}" --volume-id "${VOLUME_ID}"
  else
    info "Confirmed volume is already absent; continuing rerun"
  fi
elif ! phase_complete "volume-policy-complete" && [[ "${VOLUME_MODE}" == "delete-root-volume" ]]; then
  if aws ec2 describe-volumes --region "${AWS_REGION}" --volume-ids "${VOLUME_ID}" >/dev/null 2>&1; then
    die "DeleteOnTermination did not remove the confirmed root volume"
  fi
fi
phase_complete "volume-policy-complete" || record_phase "volume-policy-complete"

if ! phase_complete "network-and-aws-key-removed"; then
for attempt in $(seq 1 18); do
  ENI_COUNT="$(aws ec2 describe-network-interfaces --region "${AWS_REGION}" \
    --filters "Name=group-id,Values=${SG_ID}" --query 'length(NetworkInterfaces)' --output text)"
  [[ "${ENI_COUNT}" == "0" ]] && break
  [[ "${attempt}" -lt 18 ]] || die "Managed ENIs remain attached; security-group deletion blocked"
  sleep 10
done
if aws ec2 describe-security-groups --region "${AWS_REGION}" --group-ids "${SG_ID}" >/dev/null 2>&1; then
  aws ec2 delete-security-group --region "${AWS_REGION}" --group-id "${SG_ID}"
else
  info "Security group is already absent"
fi
if aws ec2 describe-key-pairs --region "${AWS_REGION}" --key-names "${KEY_NAME}" >/dev/null 2>&1; then
  aws ec2 delete-key-pair --region "${AWS_REGION}" --key-name "${KEY_NAME}"
else
  info "AWS key pair is already absent"
fi
record_phase "network-and-aws-key-removed"
fi

INSTANCE_ROLE="$(state_value "${IAM_PLAN_PATH}" instance_role_name)"
INSTANCE_PROFILE="$(state_value "${IAM_PLAN_PATH}" instance_profile_name)"
DEPLOYER_ROLE="$(state_value "${IAM_PLAN_PATH}" deployer_role_name)"
POLICY_ARN="$(state_value "${IAM_PLAN_PATH}" deployer_policy_arn)"
if ! phase_complete "owned-iam-removed"; then
ENTITIES="${STATE_ROOT}/policy-entities.json"
if aws iam get-policy --policy-arn "${POLICY_ARN}" >/dev/null 2>&1; then
  aws iam list-entities-for-policy --policy-arn "${POLICY_ARN}" --output json >"${ENTITIES}"
else
  printf '%s\n' '{"PolicyGroups":[],"PolicyUsers":[],"PolicyRoles":[]}' >"${ENTITIES}"
fi
python3 - "${ENTITIES}" "${DEPLOYER_ROLE}" <<'PY'
import json, sys
e = json.load(open(sys.argv[1]))
roles = [r["RoleName"] for r in e.get("PolicyRoles", [])]
assert roles in ([sys.argv[2]], []), f"policy is shared with unexpected roles: {roles}"
assert not e.get("PolicyUsers") and not e.get("PolicyGroups")
PY
if aws iam get-instance-profile --instance-profile-name "${INSTANCE_PROFILE}" >/dev/null 2>&1; then
  PROFILE_ROLE_COUNT="$(aws iam get-instance-profile --instance-profile-name "${INSTANCE_PROFILE}" \
    --query "length(InstanceProfile.Roles[?RoleName=='${INSTANCE_ROLE}'])" --output text)"
  if [[ "${PROFILE_ROLE_COUNT}" != "0" ]]; then
    aws iam remove-role-from-instance-profile --instance-profile-name "${INSTANCE_PROFILE}" --role-name "${INSTANCE_ROLE}"
  fi
  aws iam delete-instance-profile --instance-profile-name "${INSTANCE_PROFILE}"
fi
if aws iam get-role --role-name "${INSTANCE_ROLE}" >/dev/null 2>&1; then
  aws iam delete-role --role-name "${INSTANCE_ROLE}"
fi
if aws iam get-role --role-name "${DEPLOYER_ROLE}" >/dev/null 2>&1 && \
    aws iam get-policy --policy-arn "${POLICY_ARN}" >/dev/null 2>&1; then
  aws iam detach-role-policy --role-name "${DEPLOYER_ROLE}" --policy-arn "${POLICY_ARN}"
fi
# JMESPath uses literal backticks around false.
# shellcheck disable=SC2016
if aws iam get-policy --policy-arn "${POLICY_ARN}" >/dev/null 2>&1; then
  mapfile -t POLICY_VERSIONS < <(aws iam list-policy-versions --policy-arn "${POLICY_ARN}" \
    --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text | tr '\t' '\n')
  for version in "${POLICY_VERSIONS[@]}"; do
    [[ -n "${version}" ]] && aws iam delete-policy-version --policy-arn "${POLICY_ARN}" --version-id "${version}"
  done
  aws iam delete-policy --policy-arn "${POLICY_ARN}"
fi
# Record the credential handoff before deleting the role that issued this session.
# A rerun after this point uses the original CloudShell identity and exact state.
record_phase "deployer-self-removal-started"
if aws iam get-role --role-name "${DEPLOYER_ROLE}" >/dev/null 2>&1; then
  aws iam delete-role --role-name "${DEPLOYER_ROLE}"
fi
record_phase "owned-iam-removed"
fi

if [[ "${DELETE_LOCAL_KEY}" == "true" ]]; then
  chmod 600 "${LOCAL_KEY}" 2>/dev/null || true
  rm -f "${LOCAL_KEY}"
  record_phase "local-key-removed"
fi
record_snapshot_id "${SNAPSHOT_ID}"
if [[ "${DEPLOYER_SESSION_ACTIVE}" == "true" ]]; then
  clear_deployer_session
  trap - EXIT
fi
if [[ "${DELETE_BUDGET}" == "true" ]] && ! phase_complete "optional-budget-removed"; then
  ACCOUNT_ID="$(state_value "${STATE_PATH}" account_id)"
  aws budgets delete-budget --account-id "${ACCOUNT_ID}" --budget-name "${BUDGET_NAME}"
  record_phase "optional-budget-removed"
fi
"${SCRIPT_DIR}/13-decommission-verify.sh" --config "${CONFIG_PATH}"
info "Decommission phases completed; review the independent final report and Billing console"
