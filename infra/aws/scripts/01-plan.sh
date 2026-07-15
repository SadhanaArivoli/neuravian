#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: 01-plan.sh --config PATH [--output PATH] [--dry-run]

CLOUDSHELL: reruns read-only preflight, then writes the exact proposed resource
shape. It never calls an AWS mutation API.
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
      info "Dry-run requested; planning is already non-mutating"
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
load_config "${CONFIG_PATH}"
validate_config
ensure_state_dirs
resolve_deployment_id
OUTPUT_PATH="${OUTPUT_PATH:-${PLAN_ROOT}/resource-plan-${RESOLVED_DEPLOYMENT_ID}.json}"
PREFLIGHT_PATH="${PLAN_ROOT}/preflight-${RESOLVED_DEPLOYMENT_ID}.json"

"${SCRIPT_DIR}/00-preflight.sh" --config "${CONFIG_PATH}" --output "${PREFLIGHT_PATH}" >/dev/null
python3 "${SCRIPT_DIR}/lib/render_plan.py" plan \
  --preflight "${PREFLIGHT_PATH}" --output "${OUTPUT_PATH}" >/dev/null

python3 - "${OUTPUT_PATH}" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
print("NeuroForge AWS resource plan: GO")
print(f"  DeploymentId: {p['deployment_id']}")
for resource in p["resources"]:
    print(f"  {resource['count']} x {resource['type']}")
print("  Ingress: TCP 22 from one current IPv4 /32; no 3000/8000 ingress")
print("  Root: 200 GiB encrypted gp3, DeleteOnTermination=true")
print("  IMDS: tokens required, hop limit 1")
print(f"  Plan: {sys.argv[1]}")
print("  AWS mutations: none")
PY
