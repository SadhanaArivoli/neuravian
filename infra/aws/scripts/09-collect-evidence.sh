#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="LOCAL MAC"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

CONFIG_PATH=""
IDENTITY_FILE=""
OUTPUT_DIR=""
APPLY=false
CONFIRMATION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --identity-file) IDENTITY_FILE="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    --confirmation) CONFIRMATION="$2"; shift 2 ;;
    --dry-run) shift ;;
    -h|--help) echo "Usage: 09-collect-evidence.sh --config PATH --identity-file PEM --output-dir DIR [--apply]"; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
load_config "${CONFIG_PATH}"
validate_config
ensure_state_dirs
resolve_deployment_id
STATE_PATH="${STATE_ROOT}/state.json"
PUBLIC_IP="<instance-public-ip>"
[[ -s "${STATE_PATH}" ]] && PUBLIC_IP="$(state_value "${STATE_PATH}" public_ip)"
if [[ "${APPLY}" != "true" ]]; then
  cat <<EOF
[LOCAL MAC] DRY-RUN: SSH to ubuntu@${PUBLIC_IP}; run the committed sanitized evidence collector
[LOCAL MAC] DRY-RUN: copy only neuravian-x86-evidence.zip; verify ZIP, manifest, and SHA-256; open successfully
[LOCAL MAC] DRY-RUN: write ignored evidence-receipt.json; never print license/key contents
AWS mutations: none
EOF
  exit 0
fi
require_live_approval
[[ "${CONFIRMATION}" == "COLLECT NEURAVIAN EVIDENCE" ]] || die "Exact evidence confirmation was not provided"
[[ -s "${STATE_PATH}" ]] || die "Deployment state is missing"
[[ -s "${IDENTITY_FILE}" ]] || die "LOCAL MAC identity file is missing"
[[ -n "${OUTPUT_DIR}" ]] || die "--output-dir is required"
install -d -m 0700 "${OUTPUT_DIR}"
KNOWN_HOSTS="${STATE_ROOT}/known_hosts"
touch "${KNOWN_HOSTS}"; chmod 600 "${KNOWN_HOSTS}"
SSH_OPTIONS=(-i "${IDENTITY_FILE}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=${KNOWN_HOSTS}")
ssh "${SSH_OPTIONS[@]}" "ubuntu@${PUBLIC_IP}" \
  'cd "$HOME/neuravian" && verification/x86/commands/07-collect-evidence.sh'
REMOTE_ZIP="/home/ubuntu/neuravian/verification/x86/neuravian-x86-evidence.zip"
LOCAL_ZIP="${OUTPUT_DIR}/${RESOLVED_DEPLOYMENT_ID}-neuravian-x86-evidence.zip"
scp "${SSH_OPTIONS[@]}" "ubuntu@${PUBLIC_IP}:${REMOTE_ZIP}" "${LOCAL_ZIP}"
unzip -t "${LOCAL_ZIP}" >/dev/null
unzip -p "${LOCAL_ZIP}" evidence-manifest.json | python3 -m json.tool >/dev/null
HASH="$(sha256_file "${LOCAL_ZIP}")"
RECEIPT="${STATE_ROOT}/evidence-receipt.json"
python3 - "${RECEIPT}" "${LOCAL_ZIP}" "${HASH}" <<'PY'
import json, os, sys, zipfile
path, archive, digest = sys.argv[1:]
with zipfile.ZipFile(archive) as handle:
    assert handle.testzip() is None
    json.loads(handle.read("evidence-manifest.json"))
value = {"schema_version": 1, "archive_path": os.path.abspath(archive), "sha256": digest, "opened_successfully": True, "manifest_valid_json": True}
temporary = path + ".tmp"
with open(temporary, "w") as stream:
    json.dump(value, stream, indent=2, sort_keys=True); stream.write("\n")
os.chmod(temporary, 0o600); os.replace(temporary, path)
PY
info "Evidence downloaded, checksum-recorded, and opened successfully: ${LOCAL_ZIP}"
