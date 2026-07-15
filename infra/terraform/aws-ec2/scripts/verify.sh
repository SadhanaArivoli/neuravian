#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="LOCAL MAC"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

IDENTITY_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity-file)
      [[ $# -ge 2 ]] || { echo "--identity-file requires a path" >&2; exit 2; }
      IDENTITY_FILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: scripts/verify.sh --identity-file /path/to/private-key.pem"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

[[ -s "${IDENTITY_FILE}" ]] || { echo "[${EXECUTION_LOCATION}] Identity file is missing" >&2; exit 1; }
[[ "$(stat -f '%Lp' "${IDENTITY_FILE}" 2>/dev/null || stat -c '%a' "${IDENTITY_FILE}")" == "400" ]] || {
  echo "[${EXECUTION_LOCATION}] Identity file must have mode 400" >&2
  exit 1
}

command -v terraform >/dev/null 2>&1 || { echo "terraform is required" >&2; exit 1; }
command -v ssh >/dev/null 2>&1 || { echo "ssh is required" >&2; exit 1; }

PUBLIC_IP="$(terraform -chdir="${TF_DIR}" output -raw public_ip)"
KNOWN_HOSTS="${TF_DIR}/.known_hosts"
touch "${KNOWN_HOSTS}"
chmod 600 "${KNOWN_HOSTS}"

SSH_OPTIONS=(
  -i "${IDENTITY_FILE}"
  -o BatchMode=yes
  -o ConnectTimeout=20
  -o StrictHostKeyChecking=accept-new
  -o "UserKnownHostsFile=${KNOWN_HOSTS}"
)

ssh "${SSH_OPTIONS[@]}" "ubuntu@${PUBLIC_IP}" 'set -euo pipefail
  test -s /var/lib/neuroforge/terraform-bootstrap-complete.json
  test "$(jq -r .status /var/lib/neuroforge/terraform-bootstrap-complete.json)" = complete
  test "$(jq -r .scientific_pipelines_run /var/lib/neuroforge/terraform-bootstrap-complete.json)" = false
  systemctl is-active --quiet neuroforge.service
  curl -fsS http://127.0.0.1:8000/api/health >/dev/null
  curl -fsS http://127.0.0.1:3000/ >/dev/null
  ss -lnt | grep -q "127.0.0.1:3000"
  ss -lnt | grep -q "127.0.0.1:8000"
  ! ss -lnt | grep -Eq "0\.0\.0\.0:(3000|8000)|\[::\]:(3000|8000)"
  docker compose -f /opt/neuroforge/docker-compose.yml -f /opt/neuroforge/compose.aws-loopback.yaml ps'

printf '[%s] Verification passed for %s\n' "${EXECUTION_LOCATION}" "${PUBLIC_IP}"
printf '[%s] Tunnel: ssh -i %q -L 3000:127.0.0.1:3000 -L 8000:127.0.0.1:8000 ubuntu@%s\n' \
  "${EXECUTION_LOCATION}" "${IDENTITY_FILE}" "${PUBLIC_IP}"
