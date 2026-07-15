#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: 00-preflight.sh --config PATH [--output PATH] [--dry-run]

CLOUDSHELL: performs read-only identity, quota, AMI, network, conflict, and
pricing checks. It creates only local ignored plan files; it never mutates AWS.
EOF
}

CONFIG_PATH=""
OUTPUT_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || die "--config requires a path"
      CONFIG_PATH="$2"
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || die "--output requires a path"
      OUTPUT_PATH="$2"
      shift 2
      ;;
    --dry-run)
      info "Dry-run requested; preflight is already read-only"
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
require_command aws
require_command curl
require_command python3
load_config "${CONFIG_PATH}"
validate_config
ensure_state_dirs
resolve_deployment_id
assert_aws_cli_v2
assert_repo_commits
OUTPUT_PATH="${OUTPUT_PATH:-${PLAN_ROOT}/preflight-${RESOLVED_DEPLOYMENT_ID}.json}"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/neuroforge-aws-preflight.XXXXXX")"
trap 'rm -rf "${TEMP_DIR}"' EXIT

info "Running read-only AWS preflight in ${AWS_REGION}; no resource will be created"
CURRENT_IP="$(curl -fsS --connect-timeout 10 --max-time 30 https://checkip.amazonaws.com | tr -d '[:space:]')"

aws sts get-caller-identity --region "${AWS_REGION}" --output json >"${TEMP_DIR}/identity.json"

read -r CALLER_ARN CALLER_TYPE ROLE_NAME < <(python3 - "${TEMP_DIR}/identity.json" <<'PY'
import json, sys
identity = json.load(open(sys.argv[1]))
arn = identity.get("Arn", "")
if arn.endswith(":root"):
    raise SystemExit("AWS account root identity is forbidden")
if ":user/" in arn:
    print(arn, "user", "-")
elif ":assumed-role/" in arn:
    resource = arn.split(":assumed-role/", 1)[1]
    role_name = resource.split("/", 1)[0]
    print(arn, "assumed-role", role_name)
else:
    raise SystemExit("caller must be an IAM user or assumed role")
PY
)
if [[ "${CALLER_TYPE}" == "assumed-role" ]]; then
  SIMULATION_PRINCIPAL="$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.Arn --output text)"
else
  SIMULATION_PRINCIPAL="${CALLER_ARN}"
fi
[[ "${SIMULATION_PRINCIPAL}" == arn:aws:iam::*:user/* || "${SIMULATION_PRINCIPAL}" == arn:aws:iam::*:role/* ]] || die "Unable to resolve an IAM principal for capability simulation"
BOOTSTRAP_ACTIONS=(
  iam:AddRoleToInstanceProfile iam:AttachRolePolicy iam:CreateInstanceProfile
  iam:CreatePolicy iam:CreatePolicyVersion iam:CreateRole iam:DeletePolicyVersion
  iam:DeleteRole iam:GetInstanceProfile iam:GetPolicy iam:GetPolicyVersion
  iam:GetRole iam:ListAttachedRolePolicies iam:ListPolicyVersions
  iam:ListRolePolicies iam:SetDefaultPolicyVersion iam:TagInstanceProfile
  iam:TagPolicy iam:TagRole iam:UpdateAssumeRolePolicy
)
aws iam simulate-principal-policy --policy-source-arn "${SIMULATION_PRINCIPAL}" \
  --action-names "${BOOTSTRAP_ACTIONS[@]}" --output json >"${TEMP_DIR}/iam-simulation.json"

if [[ "${VPC_ID}" == "auto" ]]; then
  aws ec2 describe-vpcs --region "${AWS_REGION}" \
    --filters Name=is-default,Values=true --output json >"${TEMP_DIR}/vpcs.json"
else
  aws ec2 describe-vpcs --region "${AWS_REGION}" \
    --vpc-ids "${VPC_ID}" --output json >"${TEMP_DIR}/vpcs.json"
fi

RESOLVED_VPC="$(python3 - "${TEMP_DIR}/vpcs.json" "${VPC_ID}" <<'PY'
import json, sys
items = json.load(open(sys.argv[1]))["Vpcs"]
wanted = sys.argv[2]
items = [v for v in items if v.get("State") == "available" and ((wanted == "auto" and v.get("IsDefault")) or v.get("VpcId") == wanted)]
if len(items) != 1:
    raise SystemExit("expected exactly one eligible VPC")
print(items[0]["VpcId"])
PY
)"

if [[ "${SUBNET_ID}" == "auto" ]]; then
  aws ec2 describe-subnets --region "${AWS_REGION}" \
    --filters "Name=vpc-id,Values=${RESOLVED_VPC}" --output json >"${TEMP_DIR}/subnets.json"
else
  aws ec2 describe-subnets --region "${AWS_REGION}" \
    --subnet-ids "${SUBNET_ID}" --output json >"${TEMP_DIR}/subnets.json"
fi

RESOLVED_AZ="$(python3 - "${TEMP_DIR}/subnets.json" "${SUBNET_ID}" <<'PY'
import json, sys
items = json.load(open(sys.argv[1]))["Subnets"]
wanted = sys.argv[2]
items = [s for s in items if s.get("State") == "available" and s.get("MapPublicIpOnLaunch") is True and (wanted == "auto" or s.get("SubnetId") == wanted)]
if not items:
    raise SystemExit("no eligible public subnet")
items.sort(key=lambda s: (s["AvailabilityZone"], s["SubnetId"]))
print(items[0]["AvailabilityZone"])
PY
)"

aws ec2 describe-instance-type-offerings --region "${AWS_REGION}" \
  --location-type availability-zone \
  --filters "Name=instance-type,Values=${INSTANCE_TYPE}" "Name=location,Values=${RESOLVED_AZ}" \
  --output json >"${TEMP_DIR}/offerings.json"
aws ec2 describe-instance-types --region "${AWS_REGION}" \
  --instance-types "${INSTANCE_TYPE}" --output json >"${TEMP_DIR}/instance-type.json"
aws service-quotas get-service-quota --region "${AWS_REGION}" \
  --service-code ec2 --quota-code L-1216C47A --query Quota --output json >"${TEMP_DIR}/quota.json"
aws ec2 describe-instances --region "${AWS_REGION}" \
  --filters Name=instance-state-name,Values=pending,running --output json >"${TEMP_DIR}/quota-instances.json"

AMI_ID="$(aws ssm get-parameter --region "${AWS_REGION}" \
  --name "${UBUNTU_AMI_PARAMETER}" --query Parameter.Value --output text)"
[[ "${AMI_ID}" =~ ^ami-[0-9a-f]+$ ]] || die "Canonical SSM parameter returned an invalid AMI ID"
aws ec2 describe-images --region "${AWS_REGION}" --image-ids "${AMI_ID}" \
  --output json >"${TEMP_DIR}/image.json"

OWNERSHIP_FILTERS=(
  "Name=tag:Project,Values=${PROJECT_TAG}"
  "Name=tag:Purpose,Values=${PURPOSE_TAG}"
  "Name=tag:ManagedBy,Values=${MANAGED_BY_TAG}"
  "Name=tag:DeploymentId,Values=${RESOLVED_DEPLOYMENT_ID}"
)
aws ec2 describe-instances --region "${AWS_REGION}" \
  --filters "${OWNERSHIP_FILTERS[@]}" --output json >"${TEMP_DIR}/instances.json"
aws ec2 describe-security-groups --region "${AWS_REGION}" \
  --filters "${OWNERSHIP_FILTERS[@]}" --output json >"${TEMP_DIR}/security-groups.json"
aws ec2 describe-volumes --region "${AWS_REGION}" \
  --filters "${OWNERSHIP_FILTERS[@]}" --output json >"${TEMP_DIR}/volumes.json"
aws ec2 describe-key-pairs --region "${AWS_REGION}" \
  --filters "${OWNERSHIP_FILTERS[@]}" --output json >"${TEMP_DIR}/key-pairs.json"

aws pricing get-products --region us-east-1 --service-code AmazonEC2 \
  --filters \
    Type=TERM_MATCH,Field=instanceType,Value="${INSTANCE_TYPE}" \
    Type=TERM_MATCH,Field=location,Value="US East (N. Virginia)" \
    Type=TERM_MATCH,Field=operatingSystem,Value=Linux \
    Type=TERM_MATCH,Field=tenancy,Value=Shared \
    Type=TERM_MATCH,Field=preInstalledSw,Value=NA \
    Type=TERM_MATCH,Field=capacitystatus,Value=Used \
  --max-results 10 --output json >"${TEMP_DIR}/compute-price.json"
aws pricing get-products --region us-east-1 --service-code AmazonEC2 \
  --filters \
    Type=TERM_MATCH,Field=productFamily,Value="Storage" \
    Type=TERM_MATCH,Field=volumeApiName,Value=gp3 \
    Type=TERM_MATCH,Field=location,Value="US East (N. Virginia)" \
  --max-results 10 --output json >"${TEMP_DIR}/storage-price.json"
aws pricing get-products --region us-east-1 --service-code AmazonEC2 \
  --filters \
    Type=TERM_MATCH,Field=productFamily,Value="Storage Snapshot" \
    Type=TERM_MATCH,Field=usagetype,Value="EBS:SnapshotUsage" \
    Type=TERM_MATCH,Field=location,Value="US East (N. Virginia)" \
  --max-results 10 --output json >"${TEMP_DIR}/snapshot-price.json"

python3 "${SCRIPT_DIR}/lib/render_plan.py" preflight \
  --identity "${TEMP_DIR}/identity.json" \
  --vpcs "${TEMP_DIR}/vpcs.json" \
  --subnets "${TEMP_DIR}/subnets.json" \
  --offerings "${TEMP_DIR}/offerings.json" \
  --image "${TEMP_DIR}/image.json" \
  --instance-type "${TEMP_DIR}/instance-type.json" \
  --quota "${TEMP_DIR}/quota.json" \
  --quota-instances "${TEMP_DIR}/quota-instances.json" \
  --instances "${TEMP_DIR}/instances.json" \
  --security-groups "${TEMP_DIR}/security-groups.json" \
  --volumes "${TEMP_DIR}/volumes.json" \
  --key-pairs "${TEMP_DIR}/key-pairs.json" \
  --compute-price "${TEMP_DIR}/compute-price.json" \
  --storage-price "${TEMP_DIR}/storage-price.json" \
  --snapshot-price "${TEMP_DIR}/snapshot-price.json" \
  --iam-simulation "${TEMP_DIR}/iam-simulation.json" \
  --ami-id "${AMI_ID}" \
  --current-ip "${CURRENT_IP}" \
  --simulated-principal-arn "${SIMULATION_PRINCIPAL}" \
  --output "${OUTPUT_PATH}" >"${TEMP_DIR}/rendered.json"

python3 - "${OUTPUT_PATH}" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print("NeuroForge AWS preflight: GO")
print(f"  Execution: {p['execution_location']} (read-only)")
print(f"  Account fingerprint: {p['identity']['account_sha256'][:16]}")
print(f"  Caller type: {p['identity']['caller_type']}")
print(f"  Region/AZ: {p['region']} / {p['network']['availability_zone']}")
print(f"  AMI: {p['ami']['ami_id']} ({p['ami']['architecture']}, owner verified)")
print(f"  Instance: {p['compute']['instance_type']} ({p['compute']['vcpus']} vCPU, {p['compute']['memory_mib']} MiB)")
print(f"  SSH ingress: TCP 22 from {p['network']['ssh_allowed_cidr']}")
print(f"  Compute hourly: ${p['cost']['compute_hourly']:.4f}")
print(f"  gp3 200 GiB monthly: ${p['cost']['gp3_200_gib_month']:.2f}")
print(f"  Session A estimate: ${p['cost']['session_a_estimate']:.2f}")
print(f"  Machine plan: {sys.argv[1]}")
print("  AWS mutations: none")
PY
