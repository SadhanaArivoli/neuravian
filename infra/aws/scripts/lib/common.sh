#!/usr/bin/env bash

set -euo pipefail

# AWS CLI standard retry mode handles throttling and transient service failures.
# Keep the retry budget bounded so lifecycle commands never wait indefinitely.
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-standard}"
export AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-5}"

AWS_INFRA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "${AWS_INFRA_ROOT}/../.." && pwd)"
STATE_ROOT="${REPO_ROOT}/.neuravian-aws"
PLAN_ROOT="${STATE_ROOT}/plans"

readonly EXPECTED_REGION="us-east-1"
readonly EXPECTED_INSTANCE_TYPE="m7i.2xlarge"
readonly EXPECTED_VM_COMMIT="8b9614c328463c9dfcb5337303cadde447985299"
readonly EXPECTED_BASELINE_COMMIT="aec1aea247659f43a92a8f2fc39208d15a68914a"
# Consumed by scripts that source this library.
# shellcheck disable=SC2034
readonly UBUNTU_AMI_PARAMETER="/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"

info() {
  printf '[%s] %s\n' "${EXECUTION_LOCATION:-CLOUDSHELL}" "$*" >&2
}

die() {
  printf '[%s] ERROR: %s\n' "${EXECUTION_LOCATION:-CLOUDSHELL}" "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

ensure_state_dirs() {
  umask 077
  mkdir -p "${STATE_ROOT}" "${PLAN_ROOT}"
  chmod 700 "${STATE_ROOT}" "${PLAN_ROOT}"
}

allowed_config_key() {
  case "$1" in
    AWS_REGION|INSTANCE_TYPE|ROOT_VOLUME_GIB|ROOT_VOLUME_TYPE|ROOT_VOLUME_IOPS|ROOT_VOLUME_THROUGHPUT|ROOT_VOLUME_ENCRYPTED|ROOT_DELETE_ON_TERMINATION|IMDS_HTTP_TOKENS|IMDS_HOP_LIMIT|NEURAVIAN_VM_COMMIT|APPLICATION_BASELINE_COMMIT|PROJECT_TAG|PURPOSE_TAG|MANAGED_BY_TAG|DEPLOYMENT_ID|SSH_ALLOWED_CIDR|ROOT_MFA_CONFIRMED|SESSION_A_MAX_HOURS|KEY_STRATEGY|VPC_ID|SUBNET_ID|PREPULL_IMAGES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

load_config() {
  local config_path="$1"
  local raw key value
  local command_substitution
  local backtick
  command_substitution="$(printf '\044\050')"
  backtick="$(printf '\140')"
  [[ -f "${config_path}" ]] || die "Configuration not found: ${config_path}"
  while IFS= read -r raw || [[ -n "${raw}" ]]; do
    raw="${raw%$'\r'}"
    [[ -z "${raw}" || "${raw}" == \#* ]] && continue
    [[ "${raw}" == *=* ]] || die "Invalid configuration line (expected KEY=VALUE)"
    key="${raw%%=*}"
    value="${raw#*=}"
    [[ "${key}" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "Invalid configuration key: ${key}"
    allowed_config_key "${key}" || die "Unsupported configuration key: ${key}"
    [[ "${value}" != *"${command_substitution}"* && "${value}" != *"${backtick}"* ]] || die "Executable syntax is forbidden in configuration"
    export "${key}=${value}"
  done <"${config_path}"
}

require_config_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "Missing required configuration: ${name}"
}

validate_boolean() {
  local name="$1"
  [[ "${!name:-}" == "true" || "${!name:-}" == "false" ]] || die "${name} must be true or false"
}

validate_config() {
  local required=(
    AWS_REGION INSTANCE_TYPE ROOT_VOLUME_GIB ROOT_VOLUME_TYPE ROOT_VOLUME_IOPS
    ROOT_VOLUME_THROUGHPUT ROOT_VOLUME_ENCRYPTED ROOT_DELETE_ON_TERMINATION
    IMDS_HTTP_TOKENS IMDS_HOP_LIMIT NEURAVIAN_VM_COMMIT
    APPLICATION_BASELINE_COMMIT PROJECT_TAG PURPOSE_TAG MANAGED_BY_TAG
    DEPLOYMENT_ID SSH_ALLOWED_CIDR ROOT_MFA_CONFIRMED SESSION_A_MAX_HOURS
    KEY_STRATEGY VPC_ID SUBNET_ID PREPULL_IMAGES
  )
  local name
  for name in "${required[@]}"; do require_config_value "${name}"; done

  [[ "${AWS_REGION}" == "${EXPECTED_REGION}" ]] || die "AWS_REGION must be ${EXPECTED_REGION}"
  [[ "${INSTANCE_TYPE}" == "${EXPECTED_INSTANCE_TYPE}" ]] || die "INSTANCE_TYPE must be ${EXPECTED_INSTANCE_TYPE}"
  [[ "${ROOT_VOLUME_GIB}" == "200" ]] || die "ROOT_VOLUME_GIB must be 200"
  [[ "${ROOT_VOLUME_TYPE}" == "gp3" ]] || die "ROOT_VOLUME_TYPE must be gp3"
  [[ "${ROOT_VOLUME_IOPS}" == "3000" ]] || die "ROOT_VOLUME_IOPS must be 3000"
  [[ "${ROOT_VOLUME_THROUGHPUT}" == "125" ]] || die "ROOT_VOLUME_THROUGHPUT must be 125"
  validate_boolean ROOT_VOLUME_ENCRYPTED
  [[ "${ROOT_VOLUME_ENCRYPTED}" == "true" ]] || die "Root-volume encryption is required"
  validate_boolean ROOT_DELETE_ON_TERMINATION
  [[ "${ROOT_DELETE_ON_TERMINATION}" == "true" ]] || die "DeleteOnTermination must default to true"
  [[ "${IMDS_HTTP_TOKENS}" == "required" ]] || die "IMDS_HTTP_TOKENS must be required"
  [[ "${IMDS_HOP_LIMIT}" == "1" ]] || die "IMDS_HOP_LIMIT must be 1"
  [[ "${NEURAVIAN_VM_COMMIT}" =~ ^[0-9a-f]{40}$ && "${NEURAVIAN_VM_COMMIT}" == "${EXPECTED_VM_COMMIT}" ]] || die "Unexpected VM commit"
  [[ "${APPLICATION_BASELINE_COMMIT}" =~ ^[0-9a-f]{40}$ && "${APPLICATION_BASELINE_COMMIT}" == "${EXPECTED_BASELINE_COMMIT}" ]] || die "Unexpected application baseline"
  [[ "${PROJECT_TAG}" == "Neuravian" ]] || die "PROJECT_TAG must be Neuravian"
  [[ "${PURPOSE_TAG}" == "x86-verification" ]] || die "PURPOSE_TAG must be x86-verification"
  [[ "${MANAGED_BY_TAG}" == "NeuravianProvisioner" ]] || die "MANAGED_BY_TAG must be NeuravianProvisioner"
  # Populated dynamically by the validated configuration parser.
  # shellcheck disable=SC2153
  [[ "${DEPLOYMENT_ID}" == "auto" || "${DEPLOYMENT_ID}" =~ ^nf-x86-[a-z0-9-]{8,32}$ ]] || die "Invalid DEPLOYMENT_ID"
  [[ "${SSH_ALLOWED_CIDR}" == "auto" || "${SSH_ALLOWED_CIDR}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]] || die "SSH_ALLOWED_CIDR must be auto or one IPv4 /32"
  validate_boolean ROOT_MFA_CONFIRMED
  [[ "${ROOT_MFA_CONFIRMED}" == "true" ]] || die "Confirm root-user MFA manually, then set ROOT_MFA_CONFIRMED=true"
  [[ "${SESSION_A_MAX_HOURS}" =~ ^[1-9][0-9]*$ && "${SESSION_A_MAX_HOURS}" -le 24 ]] || die "SESSION_A_MAX_HOURS must be 1-24"
  [[ "${KEY_STRATEGY}" == "ec2-key-pair" ]] || die "KEY_STRATEGY must be ec2-key-pair"
  [[ "${VPC_ID}" == "auto" || "${VPC_ID}" =~ ^vpc-[0-9a-f]+$ ]] || die "VPC_ID must be auto or a VPC ID"
  [[ "${SUBNET_ID}" == "auto" || "${SUBNET_ID}" =~ ^subnet-[0-9a-f]+$ ]] || die "SUBNET_ID must be auto or a subnet ID"
  validate_boolean PREPULL_IMAGES
}

resolve_deployment_id() {
  local id_file="${STATE_ROOT}/deployment-id"
  if [[ "${DEPLOYMENT_ID}" != "auto" ]]; then
    RESOLVED_DEPLOYMENT_ID="${DEPLOYMENT_ID}"
  elif [[ -s "${id_file}" ]]; then
    RESOLVED_DEPLOYMENT_ID="$(<"${id_file}")"
  else
    require_command python3
    RESOLVED_DEPLOYMENT_ID="$(python3 - <<'PY'
import secrets
from datetime import datetime, timezone
print(f"nf-x86-{datetime.now(timezone.utc):%Y%m%d}-{secrets.token_hex(4)}")
PY
)"
    printf '%s\n' "${RESOLVED_DEPLOYMENT_ID}" >"${id_file}"
    chmod 600 "${id_file}"
  fi
  [[ "${RESOLVED_DEPLOYMENT_ID}" =~ ^nf-x86-[a-z0-9-]{8,32}$ ]] || die "Invalid resolved DeploymentId"
  export RESOLVED_DEPLOYMENT_ID
}

redact_account_id() {
  sed -E 's/[0-9]{12}/<redacted-account>/g'
}

assert_aws_cli_v2() {
  local version
  version="$(aws --version 2>&1)"
  [[ "${version}" =~ aws-cli/2\. ]] || die "AWS CLI v2 is required (found: ${version})"
}

assert_repo_commits() {
  require_command git
  git -C "${REPO_ROOT}" cat-file -e "${NEURAVIAN_VM_COMMIT}^{commit}" 2>/dev/null || die "VM commit is not present in this checkout"
  git -C "${REPO_ROOT}" merge-base --is-ancestor "${APPLICATION_BASELINE_COMMIT}" "${NEURAVIAN_VM_COMMIT}" || die "Application baseline is not an ancestor of VM commit"
}

require_live_approval() {
  [[ "${NEURAVIAN_AWS_LIVE_APPROVAL:-}" == "APPROVE NEURAVIAN AWS AUTOMATION" ]] || die "Live AWS automation approval is absent"
}

state_value() {
  local state_path="$1"
  local key="$2"
  python3 - "${state_path}" "${key}" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for component in sys.argv[2].split("."):
    value = value[component]
print(value)
PY
}

assume_deployer_session() {
  local state_path="$1"
  local iam_plan_path="$2"
  local session_name="$3"
  local credentials_file role_arn
  role_arn="$(python3 - "${state_path}" "${iam_plan_path}" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
iam = json.load(open(sys.argv[2]))
print(f"arn:aws:iam::{state['account_id']}:role/{iam['deployer_role_name']}")
PY
)"
  credentials_file="$(mktemp "${TMPDIR:-/tmp}/neuravian-sts.XXXXXX")"
  chmod 600 "${credentials_file}"
  aws sts assume-role --role-arn "${role_arn}" --role-session-name "${session_name}" \
    --duration-seconds 3600 --output json >"${credentials_file}"
  read -r AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN < <(python3 - "${credentials_file}" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))["Credentials"]
print(c["AccessKeyId"], c["SecretAccessKey"], c["SessionToken"])
PY
)
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  rm -f "${credentials_file}"
}

clear_deployer_session() {
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
}

sha256_file() {
  local path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${path}" | awk '{print $1}'
  else
    sha256sum "${path}" | awk '{print $1}'
  fi
}

verify_current_account_matches_state() {
  local state_path="$1"
  local expected actual
  expected="$(state_value "${state_path}" account_id)"
  actual="$(aws sts get-caller-identity --query Account --output text)"
  [[ "${actual}" == "${expected}" ]] || die "Current AWS account differs from deployment state"
}

verify_owned_instance() {
  local state_path="$1"
  local output_path="$2"
  local instance_id deployment_id
  instance_id="$(state_value "${state_path}" instance_id)"
  deployment_id="$(state_value "${state_path}" deployment_id)"
  aws ec2 describe-instances --region "${AWS_REGION}" --instance-ids "${instance_id}" --output json >"${output_path}"
  python3 - "${output_path}" "${instance_id}" "${deployment_id}" <<'PY'
import json, sys
document, instance_id, deployment = sys.argv[1:]
instances = [i for r in json.load(open(document)).get("Reservations", []) for i in r.get("Instances", [])]
assert len(instances) == 1 and instances[0].get("InstanceId") == instance_id
tags = {item["Key"]: item["Value"] for item in instances[0].get("Tags", [])}
required = {"Project": "Neuravian", "Purpose": "x86-verification", "ManagedBy": "NeuravianProvisioner", "DeploymentId": deployment}
assert all(tags.get(key) == value for key, value in required.items()), "instance ownership tags mismatch"
PY
}
