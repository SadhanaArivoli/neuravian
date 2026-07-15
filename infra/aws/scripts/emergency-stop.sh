#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH=""
APPLY=false
CONFIRMATION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    --confirmation) CONFIRMATION="$2"; shift 2 ;;
    --dry-run) shift ;;
    -h|--help) echo "Usage: emergency-stop.sh --config PATH [--apply --confirmation 'EMERGENCY STOP i-...']"; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
load_config "${CONFIG_PATH}"; validate_config; ensure_state_dirs; resolve_deployment_id
STATE_PATH="${STATE_ROOT}/state.json"
IAM_PLAN_PATH="${PLAN_ROOT}/iam-plan-${RESOLVED_DEPLOYMENT_ID}.json"
INSTANCE_ID="<state-instance-id>"
[[ -s "${STATE_PATH}" ]] && INSTANCE_ID="$(state_value "${STATE_PATH}" instance_id)"
if [[ "${APPLY}" != "true" ]]; then
  echo "[CLOUDSHELL] DRY-RUN: EMERGENCY STOP ${INSTANCE_ID}; wait stopped; never terminate or delete"
  echo "EBS and snapshots continue charging"
  exit 0
fi
require_live_approval
[[ -s "${STATE_PATH}" ]] || die "Deployment state is missing"
[[ "${CONFIRMATION}" == "EMERGENCY STOP ${INSTANCE_ID}" ]] || die "Exact emergency confirmation is required"
verify_current_account_matches_state "${STATE_PATH}"
assume_deployer_session "${STATE_PATH}" "${IAM_PLAN_PATH}" "emergency-${RESOLVED_DEPLOYMENT_ID}"
trap clear_deployer_session EXIT
OWNERSHIP_JSON="${STATE_ROOT}/emergency-instance.json"
verify_owned_instance "${STATE_PATH}" "${OWNERSHIP_JSON}"
aws ec2 stop-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" >/dev/null
aws ec2 wait instance-stopped --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}"
LOG="${STATE_ROOT}/emergency-stop.log"
printf '%s instance=%s action=stopped ebs_continues=true snapshots_continue=true\n' "$(date -u +%FT%TZ)" "${INSTANCE_ID}" >>"${LOG}"
chmod 600 "${LOG}"
info "Emergency stop complete; instance was not terminated and EBS/snapshots continue charging"
