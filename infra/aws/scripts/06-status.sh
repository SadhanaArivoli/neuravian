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
    -h|--help) echo "Usage: 06-status.sh --config PATH [--dry-run]"; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
load_config "${CONFIG_PATH}"
validate_config
ensure_state_dirs
resolve_deployment_id
if [[ "${DRY_RUN}" == "true" ]]; then
  cat <<'EOF'
[CLOUDSHELL] DRY-RUN: describe exact state-recorded instance, volume, SG, key pair, and tagged residuals
[CLOUDSHELL] DRY-RUN: report running/stopped compute, EBS/snapshot retention, public IPv4, and estimated continuing cost
AWS mutations: none
EOF
  exit 0
fi
STATE_PATH="${STATE_ROOT}/state.json"
IAM_PLAN_PATH="${PLAN_ROOT}/iam-plan-${RESOLVED_DEPLOYMENT_ID}.json"
PREFLIGHT_PATH="${PLAN_ROOT}/preflight-${RESOLVED_DEPLOYMENT_ID}.json"
[[ -s "${STATE_PATH}" && -s "${IAM_PLAN_PATH}" && -s "${PREFLIGHT_PATH}" ]] || die "Deployment state/plans are missing"
verify_current_account_matches_state "${STATE_PATH}"
assume_deployer_session "${STATE_PATH}" "${IAM_PLAN_PATH}" "status-${RESOLVED_DEPLOYMENT_ID}"
trap clear_deployer_session EXIT
verify_owned_instance "${STATE_PATH}" "${STATE_ROOT}/status-instances.json"
aws resourcegroupstaggingapi get-resources --region "${AWS_REGION}" \
  --tag-filters Key=Project,Values=NeuroForge Key=Purpose,Values=x86-verification \
    Key=ManagedBy,Values=NeuroForgeProvisioner Key=DeploymentId,Values="${RESOLVED_DEPLOYMENT_ID}" \
  --output json >"${STATE_ROOT}/status-tagged-resources.json"
python3 - "${STATE_ROOT}/status-instances.json" "${PREFLIGHT_PATH}" <<'PY'
import json, sys
i = json.load(open(sys.argv[1]))["Reservations"][0]["Instances"][0]
p = json.load(open(sys.argv[2]))
state = i["State"]["Name"]
print("NeuroForge AWS deployment status")
print(f"  Instance: {i['InstanceId']} ({state})")
print(f"  Type: {i['InstanceType']}")
print(f"  Public IPv4 associated: {bool(i.get('PublicIpAddress'))}")
print(f"  Compute hourly while running: ${p['cost']['compute_hourly']:.4f}")
print(f"  Public IPv4 hourly while running: ${p['cost']['public_ipv4_hourly']:.4f}")
print(f"  200 GiB gp3 monthly while allocated: ${p['cost']['gp3_200_gib_month']:.2f}")
print("  Stop does not remove EBS or snapshot charges")
PY
