#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH=""
EMAIL=""
LIMIT_USD="15"
APPLY=false
CONFIRMATION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --limit-usd) LIMIT_USD="$2"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    --confirmation) CONFIRMATION="$2"; shift 2 ;;
    --dry-run) shift ;;
    -h|--help) echo "Usage: 10-cost-controls.sh --config PATH [--email ADDRESS --limit-usd 15 --apply]"; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
load_config "${CONFIG_PATH}"; validate_config; ensure_state_dirs; resolve_deployment_id
python3 -c 'import sys; value=float(sys.argv[1]); assert 1 <= value <= 1000' "${LIMIT_USD}" || die "Budget limit must be between 1 and 1000 USD"
BUDGET_NAME="Neuravian-${RESOLVED_DEPLOYMENT_ID}"
if [[ "${APPLY}" != "true" ]]; then
  cat <<EOF
[CLOUDSHELL] OPTIONAL PLAN: create one monthly AWS Budget named ${BUDGET_NAME}
Threshold: ${LIMIT_USD} USD actual spend (email subscriber required only for apply)
This is separate from EC2 provisioning and needs separately reviewed Budgets permissions.
AWS mutations: none
EOF
  exit 0
fi
require_live_approval
[[ "${CONFIRMATION}" == "CREATE NEURAVIAN BUDGET" ]] || die "Exact budget confirmation was not provided"
[[ "${EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "A valid notification email is required"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUDGET_FILE="${STATE_ROOT}/budget.json"
NOTIFICATION_FILE="${STATE_ROOT}/budget-notification.json"
SUBSCRIBERS_FILE="${STATE_ROOT}/budget-subscribers.json"
python3 - "${BUDGET_FILE}" "${BUDGET_NAME}" "${LIMIT_USD}" "${NOTIFICATION_FILE}" "${SUBSCRIBERS_FILE}" "${EMAIL}" <<'PY'
import json, os, sys
budget_path, name, limit, notification_path, subscribers_path, email = sys.argv[1:]
with open(budget_path, "w") as stream:
    json.dump({"BudgetName": name, "BudgetLimit": {"Amount": limit, "Unit": "USD"}, "TimeUnit": "MONTHLY", "BudgetType": "COST"}, stream)
with open(notification_path, "w") as stream:
    json.dump({"NotificationType": "ACTUAL", "ComparisonOperator": "GREATER_THAN", "Threshold": 80, "ThresholdType": "PERCENTAGE"}, stream)
with open(subscribers_path, "w") as stream:
    json.dump([{"SubscriptionType": "EMAIL", "Address": email}], stream)
for path in (budget_path, notification_path, subscribers_path): os.chmod(path, 0o600)
PY
aws budgets create-budget --account-id "${ACCOUNT_ID}" --budget "file://${BUDGET_FILE}"
aws budgets create-notification-with-subscribers --account-id "${ACCOUNT_ID}" \
  --budget-name "${BUDGET_NAME}" --notification "file://${NOTIFICATION_FILE}" \
  --subscribers "file://${SUBSCRIBERS_FILE}"
rm -f "${BUDGET_FILE}" "${NOTIFICATION_FILE}" "${SUBSCRIBERS_FILE}"
printf '{"budget_name":"%s","limit_usd":%s,"created":true}\n' "${BUDGET_NAME}" "${LIMIT_USD}" >"${STATE_ROOT}/budget-state.json"
chmod 600 "${STATE_ROOT}/budget-state.json"
info "Optional budget created; no compute resource was created"
