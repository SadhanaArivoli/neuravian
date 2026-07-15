#!/usr/bin/env bash

set -euo pipefail

readonly EXECUTION_LOCATION="CLOUDSHELL or LOCAL MAC"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/aws/scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: 05-deploy-neuroforge.sh --config PATH [--identity-file PATH] [--apply]
       [--confirmation PHRASE] [--dry-run]

CLOUDSHELL or LOCAL MAC: deploys only the canonical backend/frontend stack to
an already verified VM. Services bind to 127.0.0.1 and are accessed by SSH
forwarding. It stops before fixture/license transfer or scientific execution.
EOF
}

CONFIG_PATH=""
IDENTITY_FILE=""
APPLY=false
CONFIRMATION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --identity-file) IDENTITY_FILE="$2"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    --dry-run) shift ;;
    --confirmation) CONFIRMATION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done
[[ -n "${CONFIG_PATH}" ]] || die "--config is required"
if [[ "${APPLY}" == "true" ]]; then
  [[ "${NEUROFORGE_AWS_LIVE_APPROVAL:-}" == "APPROVE NEUROFORGE AWS AUTOMATION" ]] || die "Live AWS automation approval is absent"
  if [[ -z "${CONFIRMATION}" && -t 0 ]]; then
    read -r -p 'Type DEPLOY LOCAL-ONLY NEUROFORGE: ' CONFIRMATION
  fi
  [[ "${CONFIRMATION}" == "DEPLOY LOCAL-ONLY NEUROFORGE" ]] || die "Exact deployment confirmation was not provided"
fi
load_config "${CONFIG_PATH}"
validate_config
ensure_state_dirs
resolve_deployment_id
STATE_PATH="${STATE_ROOT}/state.json"
if [[ -s "${STATE_PATH}" ]]; then
  read -r PUBLIC_IP STATE_KEY LIFECYCLE < <(python3 - "${STATE_PATH}" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
print(s.get("public_ip", ""), s.get("cloudshell_key_path", ""), s.get("lifecycle", ""))
PY
  )
else
  PUBLIC_IP="<instance-public-ip>"
  STATE_KEY="<downloaded-pem>"
  LIFECYCLE="planned"
fi
IDENTITY_FILE="${IDENTITY_FILE:-${STATE_KEY}}"

if [[ "${APPLY}" != "true" ]]; then
  cat <<EOF
[${EXECUTION_LOCATION}] DRY-RUN: copy compose.aws-loopback.yaml to ubuntu@${PUBLIC_IP}
[REMOTE VM] DRY-RUN: verify checkout ${NEUROFORGE_VM_COMMIT}
[REMOTE VM] DRY-RUN: render Compose config and require only 127.0.0.1:3000/8000
[REMOTE VM] DRY-RUN: start backend and frontend only
[REMOTE VM] DRY-RUN: verify /api/health, frontend, pipeline registry, and x86 preflight endpoints
[REMOTE VM] DRY-RUN: confirm no scientific pipeline container or run exists
[LOCAL MAC] Tunnel: ssh -i <downloaded-pem> -L 3000:127.0.0.1:3000 -L 8000:127.0.0.1:8000 ubuntu@${PUBLIC_IP}
AWS infrastructure mutations: none
Fixture/license transfer: not performed
Scientific pipelines: not run
EOF
  exit 0
fi

[[ "${LIFECYCLE}" == "verified" || "${LIFECYCLE}" == "deployed" ]] || die "Infrastructure verification must pass before deployment"
[[ -s "${IDENTITY_FILE}" ]] || die "SSH identity file is missing"
KEY_MODE="$(stat -f '%Lp' "${IDENTITY_FILE}" 2>/dev/null || stat -c '%a' "${IDENTITY_FILE}")"
[[ "${KEY_MODE}" == "400" ]] || die "SSH identity file must have mode 400"
KNOWN_HOSTS="${STATE_ROOT}/known_hosts"
touch "${KNOWN_HOSTS}"
chmod 600 "${KNOWN_HOSTS}"
SSH_OPTIONS=(
  -i "${IDENTITY_FILE}" -o BatchMode=yes -o ConnectTimeout=20
  -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=${KNOWN_HOSTS}"
)
scp "${SSH_OPTIONS[@]}" "${AWS_INFRA_ROOT}/templates/compose.aws-loopback.yaml" \
  "ubuntu@${PUBLIC_IP}:/tmp/neuroforge-compose.aws-loopback.yaml"
ssh "${SSH_OPTIONS[@]}" "ubuntu@${PUBLIC_IP}" 'bash -s' <<'REMOTE'
set -euo pipefail
readonly REPO=/home/ubuntu/neuroforge
readonly OVERRIDE=${REPO}/compose.aws-loopback.yaml
[[ "$(git -C "${REPO}" rev-parse HEAD)" == "8b9614c328463c9dfcb5337303cadde447985299" ]]
install -o ubuntu -g ubuntu -m 0644 /tmp/neuroforge-compose.aws-loopback.yaml "${OVERRIDE}"
rm -f /tmp/neuroforge-compose.aws-loopback.yaml
CONFIG_JSON="$(mktemp)"
HOST_DATASETS_DIR=/home/ubuntu HOST_UID="$(id -u ubuntu)" HOST_GID="$(id -g ubuntu)" \
  docker compose -f "${REPO}/docker-compose.yml" -f "${OVERRIDE}" config --format json >"${CONFIG_JSON}"
python3 - "${CONFIG_JSON}" <<'PY'
import json, sys
config = json.load(open(sys.argv[1]))
for service, expected in (("backend", "8000"), ("frontend", "3000")):
    ports = config["services"][service].get("ports", [])
    assert len(ports) == 1, (service, ports)
    port = ports[0]
    assert str(port.get("published")) == expected, (service, port)
    assert str(port.get("target")) == expected, (service, port)
    assert port.get("host_ip") == "127.0.0.1", (service, port)
PY
rm -f "${CONFIG_JSON}"
cd "${REPO}"
HOST_DATASETS_DIR=/home/ubuntu HOST_UID="$(id -u ubuntu)" HOST_GID="$(id -g ubuntu)" \
  GIT_COMMIT="$(git rev-parse HEAD)" \
  docker compose -f docker-compose.yml -f "${OVERRIDE}" up -d --build backend frontend
for attempt in $(seq 1 60); do
  if curl -fsS --max-time 10 http://127.0.0.1:8000/api/health >/dev/null && \
     curl -fsS --max-time 10 http://127.0.0.1:3000/ >/dev/null; then
    break
  fi
  [[ "${attempt}" -lt 60 ]] || { docker compose logs --tail 100; exit 1; }
  sleep 5
done
curl -fsS --max-time 20 http://127.0.0.1:8000/api/pipelines >/tmp/neuroforge-pipelines.json
for pipeline in pydeface fmriprep fastsurfer; do
  curl -fsS --max-time 20 "http://127.0.0.1:8000/api/pipelines/${pipeline}/preflight" >/tmp/neuroforge-${pipeline}-preflight.json
done
if ss -ltn | grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\[::\]):(3000|8000)([[:space:]]|$)'; then
  echo "Public application listener detected" >&2
  exit 1
fi
python3 - <<'PY'
import json
marker = json.load(open("/var/lib/neuroforge/bootstrap-complete.json"))
assert marker["scientific_pipelines_run"] is False
for pipeline in ("pydeface", "fmriprep", "fastsurfer"):
    json.load(open(f"/tmp/neuroforge-{pipeline}-preflight.json"))
PY
docker ps --format '{{.Names}}' | grep -Eq 'backend|frontend'
REMOTE

python3 - "${STATE_PATH}" <<'PY'
import json, os, sys
path = sys.argv[1]
state = json.load(open(path))
state["lifecycle"] = "deployed"
temporary = path + ".tmp"
with open(temporary, "w") as stream:
    json.dump(state, stream, indent=2, sort_keys=True)
    stream.write("\n")
os.chmod(temporary, 0o600)
os.replace(temporary, path)
PY
info "NeuroForge backend/frontend deployed on VM loopback only"
info "LOCAL MAC tunnel: ssh -i <downloaded-pem> -L 3000:127.0.0.1:3000 -L 8000:127.0.0.1:8000 ubuntu@${PUBLIC_IP}"
info "Stopped before fixture/license transfer; no scientific pipeline was executed"
