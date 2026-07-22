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
    -h|--help) echo "Usage: 08-start.sh --config PATH [--apply --confirmation 'START i-...']"; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
load_config "${CONFIG_PATH}"
validate_config
ensure_state_dirs
resolve_deployment_id
STATE_PATH="${STATE_ROOT}/state.json"
IAM_PLAN_PATH="${PLAN_ROOT}/iam-plan-${RESOLVED_DEPLOYMENT_ID}.json"
if [[ ! -s "${STATE_PATH}" ]]; then
  [[ "${APPLY}" == "false" ]] || die "Deployment state is missing"
  echo "[CLOUDSHELL] DRY-RUN: resolve current IPv4 /32, start exact instance, verify new public IP, and reconcile only the owned SSH rule"
  exit 0
fi
INSTANCE_ID="$(state_value "${STATE_PATH}" instance_id)"
if [[ "${APPLY}" != "true" ]]; then
  echo "[CLOUDSHELL] DRY-RUN: START ${INSTANCE_ID}; current IPv4 /32 and post-start public IP must be revalidated"
  exit 0
fi
require_live_approval
[[ "${CONFIRMATION}" == "START ${INSTANCE_ID}" ]] || die "Exact start confirmation must be START ${INSTANCE_ID}"
CURRENT_IP="$(curl -fsS --connect-timeout 10 --max-time 30 https://checkip.amazonaws.com | tr -d '[:space:]')"
python3 -c 'import ipaddress,sys; assert ipaddress.ip_address(sys.argv[1]).version == 4' "${CURRENT_IP}" || die "Current public IPv4 could not be resolved"
CURRENT_CIDR="${CURRENT_IP}/32"
verify_current_account_matches_state "${STATE_PATH}"
assume_deployer_session "${STATE_PATH}" "${IAM_PLAN_PATH}" "start-${RESOLVED_DEPLOYMENT_ID}"
trap clear_deployer_session EXIT
OWNERSHIP_JSON="${STATE_ROOT}/start-instance.json"
verify_owned_instance "${STATE_PATH}" "${OWNERSHIP_JSON}"
SG_ID="$(state_value "${STATE_PATH}" security_group_id)"
aws ec2 start-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" >/dev/null
aws ec2 wait instance-status-ok --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}"
SG_JSON="$(mktemp "${TMPDIR:-/tmp}/neuravian-sg.XXXXXX")"
aws ec2 describe-security-groups --region "${AWS_REGION}" --group-ids "${SG_ID}" --output json >"${SG_JSON}"
OLD_CIDR="$(python3 - "${SG_JSON}" "${RESOLVED_DEPLOYMENT_ID}" <<'PY'
import json, sys
group = json.load(open(sys.argv[1]))["SecurityGroups"][0]
tags = {item["Key"]: item["Value"] for item in group.get("Tags", [])}
assert tags.get("Project") == "Neuravian" and tags.get("Purpose") == "x86-verification" and tags.get("ManagedBy") == "NeuravianProvisioner" and tags.get("DeploymentId") == sys.argv[2]
permissions = group["IpPermissions"]
assert len(permissions) == 1 and permissions[0]["FromPort"] == permissions[0]["ToPort"] == 22
ranges = permissions[0].get("IpRanges", [])
assert len(ranges) == 1
print(ranges[0]["CidrIp"])
PY
)"
rm -f "${SG_JSON}"
if [[ "${OLD_CIDR}" != "${CURRENT_CIDR}" ]]; then
  aws ec2 revoke-security-group-ingress --region "${AWS_REGION}" --group-id "${SG_ID}" \
    --protocol tcp --port 22 --cidr "${OLD_CIDR}"
  aws ec2 authorize-security-group-ingress --region "${AWS_REGION}" --group-id "${SG_ID}" \
    --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${CURRENT_CIDR},Description=Neuravian-x86-operator}]" >/dev/null
fi
NEW_IP="$(aws ec2 describe-instances --region "${AWS_REGION}" --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
info "Instance started; new public IPv4 is ${NEW_IP}; rerun 04-wait-and-verify.sh"
