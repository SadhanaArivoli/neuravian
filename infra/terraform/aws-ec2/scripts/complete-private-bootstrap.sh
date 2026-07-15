#!/usr/bin/env bash

set -euo pipefail

exec > >(tee -a /var/log/neuroforge-private-bootstrap.log) 2>&1

readonly REPOSITORY_URL="https://github.com/SadhanaArivoli/neuroforge.git"
readonly REPOSITORY_DIR="/opt/neuroforge"
readonly MARKER_DIR="/var/lib/neuroforge"

fail() {
  printf '[REMOTE VM] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "Run this script as root"
[[ $# -eq 2 ]] || fail "Usage: complete-private-bootstrap.sh BUNDLE_PATH GIT_COMMIT"

readonly BUNDLE_PATH="$1"
readonly GIT_COMMIT="$2"

[[ -s "${BUNDLE_PATH}" ]] || fail "Git bundle is missing"
[[ "${GIT_COMMIT}" =~ ^[0-9a-f]{40}$ ]] || fail "Git commit must be an exact SHA"
verify_repository="$(mktemp -d)"
trap 'rm -rf "${verify_repository}"' EXIT
git init --quiet --bare "${verify_repository}"
git -C "${verify_repository}" bundle verify "${BUNDLE_PATH}"
rm -rf "${verify_repository}"
trap - EXIT

if [[ -e "${REPOSITORY_DIR}" ]]; then
  backup="${REPOSITORY_DIR}.failed-$(date -u +%Y%m%dT%H%M%SZ)"
  mv "${REPOSITORY_DIR}" "${backup}"
  printf '[REMOTE VM] Preserved failed checkout at %s\n' "${backup}"
fi

git clone --no-checkout "${BUNDLE_PATH}" "${REPOSITORY_DIR}"
git -C "${REPOSITORY_DIR}" cat-file -e "${GIT_COMMIT}^{commit}"
git -C "${REPOSITORY_DIR}" checkout --detach "${GIT_COMMIT}"
git -C "${REPOSITORY_DIR}" remote set-url origin "${REPOSITORY_URL}"
[[ "$(git -C "${REPOSITORY_DIR}" rev-parse HEAD)" == "${GIT_COMMIT}" ]] || fail "Exact Git commit verification failed"

install -d -o ubuntu -g ubuntu -m 0750 /srv/neuroforge/datasets
install -d -o ubuntu -g ubuntu -m 0700 /srv/neuroforge/secrets
install -d -o ubuntu -g ubuntu -m 0750 "${REPOSITORY_DIR}/data"

cat >"${REPOSITORY_DIR}/compose.aws-loopback.yaml" <<'COMPOSE'
services:
  backend:
    ports: !override
      - "127.0.0.1:8000:8000"
  frontend:
    ports: !override
      - "127.0.0.1:3000:3000"
COMPOSE
chmod 0644 "${REPOSITORY_DIR}/compose.aws-loopback.yaml"

install -d -m 0755 /etc/neuroforge
cat >/etc/neuroforge/environment <<EOF
GIT_COMMIT=${GIT_COMMIT}
HOST_DATASETS_DIR=/srv/neuroforge/datasets
HOST_UID=1000
HOST_GID=1000
EOF
chmod 0644 /etc/neuroforge/environment

cat >/etc/systemd/system/neuroforge.service <<'UNIT'
[Unit]
Description=NeuroForge Docker Compose application
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/neuroforge
EnvironmentFile=/etc/neuroforge/environment
ExecStart=/usr/bin/docker compose -f docker-compose.yml -f compose.aws-loopback.yaml up -d --build --remove-orphans
ExecStop=/usr/bin/docker compose -f docker-compose.yml -f compose.aws-loopback.yaml down
TimeoutStartSec=0
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now neuroforge.service

backend_ready=false
frontend_ready=false
for _attempt in $(seq 1 120); do
  curl -fsS --connect-timeout 2 http://127.0.0.1:8000/api/health >/dev/null && backend_ready=true || true
  curl -fsS --connect-timeout 2 http://127.0.0.1:3000/ >/dev/null && frontend_ready=true || true
  [[ "${backend_ready}" == "true" && "${frontend_ready}" == "true" ]] && break
  sleep 5
done
[[ "${backend_ready}" == "true" ]] || fail "Backend health check did not become ready"
[[ "${frontend_ready}" == "true" ]] || fail "Frontend health check did not become ready"

ss -lnt | grep -q '127.0.0.1:3000' || fail "Frontend is not bound to loopback"
ss -lnt | grep -q '127.0.0.1:8000' || fail "Backend is not bound to loopback"
! ss -lnt | grep -Eq '0\.0\.0\.0:(3000|8000)|\[::\]:(3000|8000)' || fail "Application port is publicly bound"

install -d -m 0755 "${MARKER_DIR}"
python3 - "${MARKER_DIR}/terraform-bootstrap-complete.json" "${GIT_COMMIT}" <<'PY'
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone

path, commit = sys.argv[1:]
value = {
    "schema_version": 1,
    "status": "complete",
    "completed_at": datetime.now(timezone.utc).isoformat(),
    "architecture": platform.machine(),
    "os": "ubuntu-24.04",
    "git_commit": commit,
    "docker": subprocess.run(
        ["docker", "--version"], check=True, capture_output=True, text=True
    ).stdout.strip(),
    "compose": subprocess.run(
        ["docker", "compose", "version"], check=True, capture_output=True, text=True
    ).stdout.strip(),
    "application_deployed": True,
    "scientific_pipelines_run": False,
    "source_transfer": "authenticated-local-git-bundle",
}
temporary = path + ".tmp"
with open(temporary, "w", encoding="utf-8") as stream:
    json.dump(value, stream, indent=2, sort_keys=True)
    stream.write("\n")
os.chmod(temporary, 0o644)
os.replace(temporary, path)
PY

printf '[REMOTE VM] NeuroForge private-repository deployment complete\n'
