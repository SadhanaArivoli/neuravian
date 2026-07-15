#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH=""
VOLUME_MODE="delete-root-volume"
EVIDENCE_OVERRIDE=""
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --volume-mode) VOLUME_MODE="$2"; shift 2 ;;
    --evidence-override) EVIDENCE_OVERRIDE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      echo "Usage: 11-decommission-plan.sh --config PATH [--volume-mode MODE] [--evidence-override PHRASE] [--dry-run]"
      exit 0
      ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
case "${VOLUME_MODE}" in
  delete-root-volume|retain-root-volume|snapshot-then-delete-volume|retain-selected-volumes) ;;
  *) die "Unsupported volume mode: ${VOLUME_MODE}" ;;
esac
if [[ -n "${EVIDENCE_OVERRIDE}" && "${EVIDENCE_OVERRIDE}" != "I ACCEPT LOSS OF UNCOLLECTED EVIDENCE" ]]; then
  die "Evidence override phrase is not exact"
fi
load_config "${CONFIG_PATH}"; validate_config; ensure_state_dirs; resolve_deployment_id
if [[ "${DRY_RUN}" == "true" ]]; then
  cat <<EOF
[CLOUDSHELL] DRY-RUN: decommission plan only; no mutation
Volume mode: ${VOLUME_MODE}
Gate: exact state + region/account + DeploymentId tags + inactive pipeline + verified local evidence
Order: evidence -> services/stop -> volume policy -> termination -> ENIs -> SG -> AWS key -> optional local key -> IAM -> residual verification
Default delete-root-volume requires separate exact instance, volume, and IAM confirmations
Retain modes report continuing EBS/snapshot cost
EOF
  exit 0
fi

STATE_PATH="${STATE_ROOT}/state.json"
PREFLIGHT_PATH="${PLAN_ROOT}/preflight-${RESOLVED_DEPLOYMENT_ID}.json"
IAM_PLAN_PATH="${PLAN_ROOT}/iam-plan-${RESOLVED_DEPLOYMENT_ID}.json"
RECEIPT_PATH="${STATE_ROOT}/evidence-receipt.json"
DECOMMISSION_STATE="${STATE_ROOT}/decommission-state.json"
[[ -s "${STATE_PATH}" && -s "${PREFLIGHT_PATH}" && -s "${IAM_PLAN_PATH}" ]] || die "Deployment state/plans are missing"
INSTANCE_ID="$(state_value "${STATE_PATH}" instance_id)"
SG_ID="$(state_value "${STATE_PATH}" security_group_id)"
KEY_NAME="$(state_value "${STATE_PATH}" key_pair_name)"
VOLUME_ID="$(state_value "${STATE_PATH}" root_volume_id)"
verify_current_account_matches_state "${STATE_PATH}"
IAM_REMOVED="false"
if [[ -s "${DECOMMISSION_STATE}" ]]; then
  IAM_REMOVED="$(python3 - "${DECOMMISSION_STATE}" <<'PY'
import json, sys
phases = json.load(open(sys.argv[1])).get("phases", [])
print(str("owned-iam-removed" in phases or "deployer-self-removal-started" in phases).lower())
PY
)"
fi
if [[ "${IAM_REMOVED}" != "true" ]]; then
  assume_deployer_session "${STATE_PATH}" "${IAM_PLAN_PATH}" "decommission-plan-${RESOLVED_DEPLOYMENT_ID}"
  trap clear_deployer_session EXIT
fi
PLAN_INPUTS="${STATE_ROOT}/decommission-inputs"
install -d -m 0700 "${PLAN_INPUTS}"
aws ec2 describe-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" --output json \
  >"${PLAN_INPUTS}/instances.json" 2>/dev/null || printf '%s\n' '{"Reservations":[]}' >"${PLAN_INPUTS}/instances.json"
aws ec2 describe-volumes --region "${AWS_REGION}" --volume-ids "${VOLUME_ID}" --output json \
  >"${PLAN_INPUTS}/volumes.json" 2>/dev/null || printf '%s\n' '{"Volumes":[]}' >"${PLAN_INPUTS}/volumes.json"
aws ec2 describe-security-groups --region "${AWS_REGION}" --group-ids "${SG_ID}" --output json \
  >"${PLAN_INPUTS}/security-group.json" 2>/dev/null || printf '%s\n' '{"SecurityGroups":[]}' >"${PLAN_INPUTS}/security-group.json"
aws ec2 describe-key-pairs --region "${AWS_REGION}" --key-names "${KEY_NAME}" --output json \
  >"${PLAN_INPUTS}/key-pairs.json" 2>/dev/null || printf '%s\n' '{"KeyPairs":[]}' >"${PLAN_INPUTS}/key-pairs.json"
read -r INSTANCE_STATE PUBLIC_IP < <(python3 - "${PLAN_INPUTS}/instances.json" <<'PY'
import json, sys
items = [i for r in json.load(open(sys.argv[1])).get("Reservations", []) for i in r.get("Instances", [])]
print(items[0].get("State", {}).get("Name", "unknown") if items else "absent",
      items[0].get("PublicIpAddress", "") if items else "")
PY
)
if [[ "${IAM_REMOVED}" != "true" ]]; then
  clear_deployer_session
  trap - EXIT
fi

REMOTE_STATUS="${PLAN_INPUTS}/remote-status.json"
if [[ "${INSTANCE_STATE}" == "stopped" || "${INSTANCE_STATE}" == "stopping" || "${INSTANCE_STATE}" == "shutting-down" || "${INSTANCE_STATE}" == "terminated" || "${INSTANCE_STATE}" == "absent" ]]; then
  printf '%s\n' '{"services_running":false,"scientific_pipeline_active":false,"source":"instance-stopped"}' >"${REMOTE_STATUS}"
else
  KEY_PATH="$(state_value "${STATE_PATH}" cloudshell_key_path)"
  [[ -s "${KEY_PATH}" && -n "${PUBLIC_IP}" ]] || die "Running-instance pipeline status cannot be verified without SSH access"
  KNOWN_HOSTS="${STATE_ROOT}/known_hosts"; touch "${KNOWN_HOSTS}"; chmod 600 "${KNOWN_HOSTS}"
  ssh -i "${KEY_PATH}" -o BatchMode=yes -o ConnectTimeout=20 \
    -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=${KNOWN_HOSTS}" \
    "ubuntu@${PUBLIC_IP}" 'python3 -' >"${REMOTE_STATUS}" <<'PY'
import json, subprocess
def output(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()
scientific = output("docker", "ps", "-q", "--filter", "label=neuroforge.run_id")
services = output("docker", "ps", "-q", "--filter", "name=neuroforge")
print(json.dumps({
    "services_running": bool(services),
    "scientific_pipeline_active": bool(scientific),
    "source": "remote-docker",
}, sort_keys=True))
PY
fi
chmod 600 "${REMOTE_STATUS}"

ARGS=(
  --state "${STATE_PATH}" --preflight "${PREFLIGHT_PATH}"
  --instances "${PLAN_INPUTS}/instances.json" --volumes "${PLAN_INPUTS}/volumes.json"
  --security-group "${PLAN_INPUTS}/security-group.json" --key-pairs "${PLAN_INPUTS}/key-pairs.json"
  --remote-status "${REMOTE_STATUS}" --volume-mode "${VOLUME_MODE}"
  --output "${STATE_ROOT}/decommission-plan.json"
)
if [[ -s "${RECEIPT_PATH}" ]]; then ARGS+=(--evidence-receipt "${RECEIPT_PATH}"); fi
if [[ -s "${DECOMMISSION_STATE}" ]]; then ARGS+=(--decommission-state "${DECOMMISSION_STATE}"); fi
if [[ -n "${EVIDENCE_OVERRIDE}" ]]; then ARGS+=(--evidence-override "${EVIDENCE_OVERRIDE}"); fi
python3 "${SCRIPT_DIR}/lib/decommission_plan.py" "${ARGS[@]}" >/dev/null
python3 - "${STATE_ROOT}/decommission-plan.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print("NeuroForge decommission plan: GO")
print(f"  Instance: {p['instance_id']} ({p['instance_state']})")
print(f"  Volume mode: {p['volume_mode']}")
print(f"  Evidence verified: {p['evidence']['verified']}")
print(f"  Continuing monthly estimate: ${p['continuing_monthly_estimate']:.2f}")
for index, step in enumerate(p["dependency_order"], 1):
    print(f"  {index}. {step}")
print("  AWS mutations: none")
PY
