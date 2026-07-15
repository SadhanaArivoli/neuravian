#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: 02-bootstrap-iam.sh --config PATH [--apply] [--confirmation PHRASE]

CLOUDSHELL: default mode renders and validates the exact IAM plan without
mutation. Live apply additionally requires the reserved future approval gate
and the typed confirmation CREATE NEUROFORGE IAM.

IAM removal is intentionally not available here. Permanent removal flows only
through scripts 11, 12, and 13.
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
    --destroy-owned-iam)
      die "IAM teardown is available only through 11-decommission-plan.sh and 12-decommission.sh"
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
    read -r -p 'Type CREATE NEUROFORGE IAM: ' CONFIRMATION
  fi
  [[ "${CONFIRMATION}" == "CREATE NEUROFORGE IAM" ]] || die "Exact IAM confirmation was not provided"
fi

require_command aws
require_command python3
load_config "${CONFIG_PATH}"
validate_config
ensure_state_dirs
resolve_deployment_id

PREFLIGHT_PATH="${PLAN_ROOT}/preflight-${RESOLVED_DEPLOYMENT_ID}.json"
RESOURCE_PLAN_PATH="${PLAN_ROOT}/resource-plan-${RESOLVED_DEPLOYMENT_ID}.json"
IAM_OUTPUT_DIR="${PLAN_ROOT}/iam-${RESOLVED_DEPLOYMENT_ID}"
IAM_PLAN_PATH="${PLAN_ROOT}/iam-plan-${RESOLVED_DEPLOYMENT_ID}.json"
"${SCRIPT_DIR}/01-plan.sh" --config "${CONFIG_PATH}" --output "${RESOURCE_PLAN_PATH}" >/dev/null

BOOTSTRAP_PRINCIPAL="$(python3 - "${PREFLIGHT_PATH}" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print(p["iam_capability_check"]["simulated_principal_arn"])
PY
)"

python3 "${SCRIPT_DIR}/lib/render_iam.py" \
  --preflight "${PREFLIGHT_PATH}" \
  --bootstrap-principal-arn "${BOOTSTRAP_PRINCIPAL}" \
  --deployer-policy-template "${AWS_INFRA_ROOT}/policies/neuroforge-deployer-policy.json" \
  --deployer-trust-template "${AWS_INFRA_ROOT}/iam/neuroforge-deployer-trust-policy.json" \
  --instance-trust-template "${AWS_INFRA_ROOT}/iam/neuroforge-instance-trust-policy.json" \
  --instance-policy-template "${AWS_INFRA_ROOT}/iam/neuroforge-instance-role-policy.json" \
  --output-dir "${IAM_OUTPUT_DIR}" \
  --plan-output "${IAM_PLAN_PATH}" >/dev/null

DEPLOYER_POLICY="${IAM_OUTPUT_DIR}/deployer-policy.json"
ANALYZER_OUTPUT="${IAM_OUTPUT_DIR}/access-analyzer.json"
aws accessanalyzer validate-policy --policy-document "file://${DEPLOYER_POLICY}" \
  --policy-type IDENTITY_POLICY --output json >"${ANALYZER_OUTPUT}"
chmod 600 "${ANALYZER_OUTPUT}"
python3 - "${ANALYZER_OUTPUT}" <<'PY'
import json, sys
findings = json.load(open(sys.argv[1])).get("findings", [])
blocking = [f for f in findings if f.get("findingType") in {"ERROR", "SECURITY_WARNING"}]
if blocking:
    for finding in blocking:
        print(f"IAM policy finding: {finding}", file=sys.stderr)
    raise SystemExit("IAM Access Analyzer returned blocking findings")
PY

if [[ "${APPLY}" != "true" ]]; then
  python3 - "${IAM_PLAN_PATH}" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print("NeuroForge IAM bootstrap plan: GO")
print(f"  Deployer role: {p['deployer_role_name']}")
print(f"  Instance role: {p['instance_role_name']} (0 AWS API actions)")
print(f"  Deployer actions: {len(p['deployer_actions'])}")
print(f"  Plan: {sys.argv[1]}")
print("  AWS mutations: none")
PY
  exit 0
fi

ACCOUNT_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["identity"]["account_id"])' "${PREFLIGHT_PATH}")"
DEPLOYER_ROLE="NeuroForgeDeployer-${RESOLVED_DEPLOYMENT_ID}"
INSTANCE_ROLE="NeuroForgeInstance-${RESOLVED_DEPLOYMENT_ID}"
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${DEPLOYER_ROLE}"

if aws iam get-policy --policy-arn "${POLICY_ARN}" >/dev/null 2>&1; then
  CURRENT_DOCUMENT="${IAM_OUTPUT_DIR}/current-policy.json"
  DEFAULT_VERSION="$(aws iam get-policy --policy-arn "${POLICY_ARN}" --query Policy.DefaultVersionId --output text)"
  aws iam get-policy-version --policy-arn "${POLICY_ARN}" --version-id "${DEFAULT_VERSION}" \
    --query PolicyVersion.Document --output json >"${CURRENT_DOCUMENT}"
  if ! python3 - "${CURRENT_DOCUMENT}" "${DEPLOYER_POLICY}" <<'PY'
import json, sys
raise SystemExit(0 if json.load(open(sys.argv[1])) == json.load(open(sys.argv[2])) else 1)
PY
  then
    # JMESPath requires literal backticks around false.
    # shellcheck disable=SC2016
    mapfile -t NONDEFAULT_VERSIONS < <(aws iam list-policy-versions --policy-arn "${POLICY_ARN}" \
      --query 'Versions[?IsDefaultVersion==`false`]|sort_by(@,&CreateDate)[].VersionId' --output text | tr '\t' '\n')
    while [[ ${#NONDEFAULT_VERSIONS[@]} -ge 4 ]]; do
      aws iam delete-policy-version --policy-arn "${POLICY_ARN}" --version-id "${NONDEFAULT_VERSIONS[0]}"
      NONDEFAULT_VERSIONS=("${NONDEFAULT_VERSIONS[@]:1}")
    done
    aws iam create-policy-version --policy-arn "${POLICY_ARN}" \
      --policy-document "file://${DEPLOYER_POLICY}" --set-as-default >/dev/null
  fi
else
  aws iam create-policy --policy-name "${DEPLOYER_ROLE}" \
    --policy-document "file://${DEPLOYER_POLICY}" \
    --tags Key=Project,Value=NeuroForge Key=Purpose,Value=x86-verification \
      Key=ManagedBy,Value=NeuroForgeProvisioner Key=DeploymentId,Value="${RESOLVED_DEPLOYMENT_ID}" >/dev/null
fi

ensure_role() {
  local role_name="$1"
  local trust_file="$2"
  if aws iam get-role --role-name "${role_name}" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "${role_name}" --policy-document "file://${trust_file}"
  else
    aws iam create-role --role-name "${role_name}" --assume-role-policy-document "file://${trust_file}" \
      --tags Key=Project,Value=NeuroForge Key=Purpose,Value=x86-verification \
        Key=ManagedBy,Value=NeuroForgeProvisioner Key=DeploymentId,Value="${RESOLVED_DEPLOYMENT_ID}" >/dev/null
  fi
}

ensure_role "${DEPLOYER_ROLE}" "${IAM_OUTPUT_DIR}/deployer-trust.json"
ensure_role "${INSTANCE_ROLE}" "${IAM_OUTPUT_DIR}/instance-trust.json"
aws iam attach-role-policy --role-name "${DEPLOYER_ROLE}" --policy-arn "${POLICY_ARN}"

ATTACHED_COUNT="$(aws iam list-attached-role-policies --role-name "${INSTANCE_ROLE}" --query 'length(AttachedPolicies)' --output text)"
INLINE_COUNT="$(aws iam list-role-policies --role-name "${INSTANCE_ROLE}" --query 'length(PolicyNames)' --output text)"
[[ "${ATTACHED_COUNT}" == "0" && "${INLINE_COUNT}" == "0" ]] || die "Instance role unexpectedly has AWS API permissions"

if ! aws iam get-instance-profile --instance-profile-name "${INSTANCE_ROLE}" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "${INSTANCE_ROLE}" \
    --tags Key=Project,Value=NeuroForge Key=Purpose,Value=x86-verification \
      Key=ManagedBy,Value=NeuroForgeProvisioner Key=DeploymentId,Value="${RESOLVED_DEPLOYMENT_ID}" >/dev/null
fi
PROFILE_ROLE_COUNT="$(aws iam get-instance-profile --instance-profile-name "${INSTANCE_ROLE}" \
  --query "length(InstanceProfile.Roles[?RoleName=='${INSTANCE_ROLE}'])" --output text)"
if [[ "${PROFILE_ROLE_COUNT}" == "0" ]]; then
  aws iam add-role-to-instance-profile --instance-profile-name "${INSTANCE_ROLE}" --role-name "${INSTANCE_ROLE}"
fi

IAM_STATE="${STATE_ROOT}/iam-state.json"
python3 - "${IAM_STATE}" "${RESOLVED_DEPLOYMENT_ID}" "${POLICY_ARN}" "${DEPLOYER_ROLE}" "${INSTANCE_ROLE}" <<'PY'
import json, os, sys
path = sys.argv[1]
value = {
    "schema_version": 1,
    "deployment_id": sys.argv[2],
    "deployer_policy_arn": sys.argv[3],
    "deployer_role_name": sys.argv[4],
    "instance_role_name": sys.argv[5],
    "instance_profile_name": sys.argv[5],
}
temporary = path + ".tmp"
with open(temporary, "w") as stream:
    json.dump(value, stream, indent=2, sort_keys=True)
    stream.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY
info "Owned IAM bootstrap completed; no EC2 resource was created"
