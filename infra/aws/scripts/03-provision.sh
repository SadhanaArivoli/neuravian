#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: 03-provision.sh --config PATH [--apply] [--confirmation PHRASE]

CLOUDSHELL: default mode regenerates all read-only plans and the exact proposed
run-instances request. Live apply requires the reserved future approval plus:
LAUNCH ONE M7I.2XLARGE

This script never launches more than one instance and never terminates one.
EOF
}

CONFIG_PATH=""
APPLY=false
CONFIRMATION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || die "--config requires a path"
      CONFIG_PATH="$2"
      shift 2
      ;;
    --apply)
      APPLY=true
      shift
      ;;
    --confirmation)
      [[ $# -ge 2 ]] || die "--confirmation requires a value"
      CONFIRMATION="$2"
      shift 2
      ;;
    --dry-run)
      info "Dry-run is the default provisioning mode"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "Unknown argument: $1"
      ;;
  esac
done

[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
if [[ "${APPLY}" == "true" ]]; then
  [[ "${NEUROFORGE_AWS_LIVE_APPROVAL:-}" == "APPROVE NEUROFORGE AWS AUTOMATION" ]] || die "Live AWS automation approval is absent"
  if [[ -z "${CONFIRMATION}" && -t 0 ]]; then
    read -r -p 'Type LAUNCH ONE M7I.2XLARGE: ' CONFIRMATION
  fi
  [[ "${CONFIRMATION}" == "LAUNCH ONE M7I.2XLARGE" ]] || die "Exact launch confirmation was not provided"
fi

require_command aws
require_command python3
load_config "${CONFIG_PATH}"
validate_config
ensure_state_dirs
resolve_deployment_id

PREFLIGHT_PATH="${PLAN_ROOT}/preflight-${RESOLVED_DEPLOYMENT_ID}.json"
IAM_PLAN_PATH="${PLAN_ROOT}/iam-plan-${RESOLVED_DEPLOYMENT_ID}.json"
PROVISION_DIR="${PLAN_ROOT}/provision-${RESOLVED_DEPLOYMENT_ID}"
PLANNED_REQUEST="${PROVISION_DIR}/run-instances.json"
RENDERED_USER_DATA="${PROVISION_DIR}/user-data.sh"
"${SCRIPT_DIR}/02-bootstrap-iam.sh" --config "${CONFIG_PATH}" >/dev/null

python3 "${SCRIPT_DIR}/lib/render_provision.py" \
  --preflight "${PREFLIGHT_PATH}" \
  --iam-plan "${IAM_PLAN_PATH}" \
  --user-data-template "${AWS_INFRA_ROOT}/templates/user-data.sh" \
  --security-group-id sg-planned00000000 \
  --prepull-images "${PREPULL_IMAGES}" \
  --output-request "${PLANNED_REQUEST}" \
  --output-user-data "${RENDERED_USER_DATA}" >/dev/null
bash -n "${RENDERED_USER_DATA}"

if [[ "${APPLY}" != "true" ]]; then
  python3 - "${PLANNED_REQUEST}" "${PREFLIGHT_PATH}" <<'PY'
import base64, json, sys
request = json.load(open(sys.argv[1]))
preflight = json.load(open(sys.argv[2]))
request["UserData"] = f"<base64 user-data: {len(base64.b64decode(request['UserData']))} bytes>"
print("NeuroForge EC2 provisioning plan: GO")
print(json.dumps(request, indent=2, sort_keys=True))
print(f"Compute hourly: ${preflight['cost']['compute_hourly']:.4f}")
print(f"200 GiB gp3 monthly: ${preflight['cost']['gp3_200_gib_month']:.2f}")
print("Create order: security group -> SSH /32 rule -> key pair -> exactly one instance")
print("Rollback before successful launch: delete the new key-pair record, then the new security group")
print("After an instance ID exists: never auto-terminate; emergency-stop or decommission explicitly")
print("AWS mutations: none")
PY
  exit 0
fi

[[ -s "${STATE_ROOT}/iam-state.json" ]] || die "Owned IAM state is missing; complete the approved IAM bootstrap first"
[[ ! -e "${STATE_ROOT}/state.json" ]] || die "Deployment state already exists; refusing to launch another instance"

read -r DEPLOYER_ROLE_ARN ACCOUNT_ID < <(python3 - "${IAM_PLAN_PATH}" "${PREFLIGHT_PATH}" <<'PY'
import json, sys
iam = json.load(open(sys.argv[1]))
preflight = json.load(open(sys.argv[2]))
account = preflight["identity"]["account_id"]
print(f"arn:aws:iam::{account}:role/{iam['deployer_role_name']}", account)
PY
)

CREDENTIALS_FILE="$(mktemp "${TMPDIR:-/tmp}/neuroforge-sts.XXXXXX")"
chmod 600 "${CREDENTIALS_FILE}"
aws sts assume-role --role-arn "${DEPLOYER_ROLE_ARN}" \
  --role-session-name "neuroforge-${RESOLVED_DEPLOYMENT_ID}" \
  --duration-seconds 3600 --output json >"${CREDENTIALS_FILE}"
read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN < <(python3 - "${CREDENTIALS_FILE}" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))["Credentials"]
print(c["AccessKeyId"], c["SecretAccessKey"], c["SessionToken"])
PY
)
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
rm -f "${CREDENTIALS_FILE}"

KEY_NAME="neuroforge-${RESOLVED_DEPLOYMENT_ID}"
SG_NAME="neuroforge-${RESOLVED_DEPLOYMENT_ID}"
KEY_DIR="${STATE_ROOT}/keys"
KEY_PATH="${KEY_DIR}/${KEY_NAME}.pem"
install -d -m 0700 "${KEY_DIR}"
umask 077
CREATED_KEY=false
CREATED_SG=false
SG_ID=""
INSTANCE_ID=""

rollback_partial_create() {
  local exit_code=$?
  if [[ ${exit_code} -ne 0 && -z "${INSTANCE_ID}" ]]; then
    info "Provisioning failed before an instance was created; rolling back only newly owned access resources"
    if [[ "${CREATED_KEY}" == "true" ]]; then
      aws ec2 delete-key-pair --region "${AWS_REGION}" --key-name "${KEY_NAME}" || true
    fi
    if [[ "${CREATED_SG}" == "true" && -n "${SG_ID}" ]]; then
      aws ec2 delete-security-group --region "${AWS_REGION}" --group-id "${SG_ID}" || true
    fi
    if [[ -s "${KEY_PATH}" ]]; then
      info "The now-unusable PEM remains at ${KEY_PATH}; review and remove it manually"
    fi
  fi
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  return "${exit_code}"
}
trap rollback_partial_create EXIT

VPC_ID_RESOLVED="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["network"]["vpc_id"])' "${PREFLIGHT_PATH}")"
SSH_CIDR="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["network"]["ssh_allowed_cidr"])' "${PREFLIGHT_PATH}")"
TAG_SPEC="ResourceType=security-group,Tags=[{Key=Name,Value=${SG_NAME}},{Key=Project,Value=NeuroForge},{Key=Purpose,Value=x86-verification},{Key=ManagedBy,Value=NeuroForgeProvisioner},{Key=DeploymentId,Value=${RESOLVED_DEPLOYMENT_ID}}]"
SG_ID="$(aws ec2 create-security-group --region "${AWS_REGION}" --vpc-id "${VPC_ID_RESOLVED}" \
  --group-name "${SG_NAME}" --description "NeuroForge x86 SSH from one IPv4" \
  --tag-specifications "${TAG_SPEC}" --query GroupId --output text)"
[[ "${SG_ID}" =~ ^sg-[0-9a-f]+$ ]] || die "AWS returned an invalid security-group ID"
CREATED_SG=true
aws ec2 authorize-security-group-ingress --region "${AWS_REGION}" --group-id "${SG_ID}" \
  --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${SSH_CIDR},Description=NeuroForge-x86-operator}]" >/dev/null

KEY_TAG_SPEC="ResourceType=key-pair,Tags=[{Key=Name,Value=${KEY_NAME}},{Key=Project,Value=NeuroForge},{Key=Purpose,Value=x86-verification},{Key=ManagedBy,Value=NeuroForgeProvisioner},{Key=DeploymentId,Value=${RESOLVED_DEPLOYMENT_ID}}]"
aws ec2 create-key-pair --region "${AWS_REGION}" --key-name "${KEY_NAME}" \
  --key-type ed25519 --tag-specifications "${KEY_TAG_SPEC}" \
  --query KeyMaterial --output text >"${KEY_PATH}"
chmod 400 "${KEY_PATH}"
[[ -s "${KEY_PATH}" ]] || die "EC2 key material was not written"
CREATED_KEY=true

python3 "${SCRIPT_DIR}/lib/render_provision.py" \
  --preflight "${PREFLIGHT_PATH}" --iam-plan "${IAM_PLAN_PATH}" \
  --user-data-template "${AWS_INFRA_ROOT}/templates/user-data.sh" \
  --security-group-id "${SG_ID}" --prepull-images "${PREPULL_IMAGES}" \
  --output-request "${PLANNED_REQUEST}" \
  --output-user-data "${RENDERED_USER_DATA}" >/dev/null
RUN_OUTPUT="${PROVISION_DIR}/run-instances-output.json"
aws ec2 run-instances --region "${AWS_REGION}" --cli-input-json "file://${PLANNED_REQUEST}" \
  --output json >"${RUN_OUTPUT}"
chmod 600 "${RUN_OUTPUT}"
INSTANCE_ID="$(python3 - "${RUN_OUTPUT}" <<'PY'
import json, sys
instances = json.load(open(sys.argv[1])).get("Instances", [])
if len(instances) != 1:
    raise SystemExit("run-instances did not return exactly one instance")
print(instances[0]["InstanceId"])
PY
)"
[[ "${INSTANCE_ID}" =~ ^i-[0-9a-f]+$ ]] || die "AWS returned an invalid instance ID"

STATE_PATH="${STATE_ROOT}/state.json"
python3 - "${STATE_PATH}" "${RESOLVED_DEPLOYMENT_ID}" "${AWS_REGION}" "${ACCOUNT_ID}" "${INSTANCE_ID}" "${SG_ID}" "${KEY_NAME}" "${KEY_PATH}" "${PLANNED_REQUEST}" <<'PY'
import hashlib, json, os, sys
path, deployment, region, account, instance, sg, key_name, key_path, request = sys.argv[1:]
value = {
    "schema_version": 1,
    "deployment_id": deployment,
    "region": region,
    "account_id": account,
    "instance_id": instance,
    "security_group_id": sg,
    "key_pair_name": key_name,
    "cloudshell_key_path": key_path,
    "request_sha256": hashlib.sha256(open(request, "rb").read()).hexdigest(),
    "lifecycle": "provisioned",
}
temporary = path + ".tmp"
with open(temporary, "w") as stream:
    json.dump(value, stream, indent=2, sort_keys=True)
    stream.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY

unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
trap - EXIT
info "Created exactly one instance: ${INSTANCE_ID}"
info "CloudShell PEM: ${KEY_PATH} (mode 400; never print it)"
info "Download the PEM securely to the LOCAL MAC and confirm receipt before deleting the CloudShell copy"
info "No scientific pipeline was executed and no resource was terminated"
