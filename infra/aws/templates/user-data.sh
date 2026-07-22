#!/usr/bin/env bash

set -euo pipefail

exec > >(tee -a /var/log/neuravian-bootstrap.log) 2>&1
export DEBIAN_FRONTEND=noninteractive

readonly EXPECTED_COMMIT="__NEURAVIAN_VM_COMMIT__"
readonly APPLICATION_BASELINE="__APPLICATION_BASELINE_COMMIT__"
readonly REPOSITORY_URL="https://github.com/SadhanaArivoli/neuravian.git"
readonly REPOSITORY_DIR="/home/ubuntu/neuravian"
readonly MARKER_DIR="/var/lib/neuravian"
readonly MARKER_PATH="${MARKER_DIR}/bootstrap-complete.json"
readonly PREPULL_IMAGES="__PREPULL_IMAGES__"

log() {
  printf '[REMOTE VM] %s\n' "$*"
}

[[ "$(uname -m)" == "x86_64" ]] || { log "Expected x86_64"; exit 1; }
# shellcheck source=/dev/null
source /etc/os-release
[[ "${ID}" == "ubuntu" && "${VERSION_ID}" == "24.04" ]] || {
  log "Expected Ubuntu 24.04"; exit 1;
}

install -d -m 0755 "${MARKER_DIR}"
apt-get update
apt-get install -y ca-certificates curl git jq python3 python3-venv rsync unzip zip gnupg
install -m 0755 -d /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

if [[ -d "${REPOSITORY_DIR}/.git" ]]; then
  [[ "$(git -C "${REPOSITORY_DIR}" remote get-url origin)" == "${REPOSITORY_URL}" ]] || {
    log "Existing checkout has an unexpected origin"; exit 1;
  }
else
  [[ ! -e "${REPOSITORY_DIR}" ]] || { log "Repository path exists but is not a Git checkout"; exit 1; }
  git clone --filter=blob:none "${REPOSITORY_URL}" "${REPOSITORY_DIR}"
fi
git -C "${REPOSITORY_DIR}" fetch origin
git -C "${REPOSITORY_DIR}" checkout --detach "${EXPECTED_COMMIT}"
[[ "$(git -C "${REPOSITORY_DIR}" rev-parse HEAD)" == "${EXPECTED_COMMIT}" ]] || {
  log "Exact VM commit verification failed"; exit 1;
}
git -C "${REPOSITORY_DIR}" cat-file -e "${APPLICATION_BASELINE}^{commit}"
git -C "${REPOSITORY_DIR}" merge-base --is-ancestor "${APPLICATION_BASELINE}" "${EXPECTED_COMMIT}"

install -d -o ubuntu -g ubuntu -m 0750 /home/ubuntu/neuravian-fixture
install -d -o ubuntu -g ubuntu -m 0700 /home/ubuntu/.neuravian-secrets
install -d -o ubuntu -g ubuntu -m 0750 "${REPOSITORY_DIR}/verification/x86/work"
install -d -o ubuntu -g ubuntu -m 0750 "${REPOSITORY_DIR}/verification/x86/evidence"
install -d -o ubuntu -g ubuntu -m 0750 "${REPOSITORY_DIR}/data"
chown -R ubuntu:ubuntu "${REPOSITORY_DIR}"

docker version
docker compose version
if [[ "${PREPULL_IMAGES}" == "true" ]]; then
  "${REPOSITORY_DIR}/verification/x86/prepull-images.sh"
fi

python3 - "${MARKER_PATH}" "${EXPECTED_COMMIT}" "${APPLICATION_BASELINE}" <<'PY'
import json, os, platform, subprocess, sys
from datetime import datetime, timezone
path, commit, baseline = sys.argv[1:]
value = {
    "schema_version": 1,
    "status": "complete",
    "completed_at": datetime.now(timezone.utc).isoformat(),
    "architecture": platform.machine(),
    "os": "ubuntu-24.04",
    "git_commit": commit,
    "application_baseline": baseline,
    "docker": subprocess.run(["docker", "--version"], check=True, capture_output=True, text=True).stdout.strip(),
    "compose": subprocess.run(["docker", "compose", "version"], check=True, capture_output=True, text=True).stdout.strip(),
    "scientific_pipelines_run": False,
}
temporary = path + ".tmp"
with open(temporary, "w") as stream:
    json.dump(value, stream, indent=2, sort_keys=True)
    stream.write("\n")
os.chmod(temporary, 0o644)
os.replace(temporary, path)
PY

log "Bootstrap complete; no scientific pipeline was executed"
