#!/usr/bin/env bash
set -euo pipefail

APPLICATION_BASELINE_COMMIT="aec1aea247659f43a92a8f2fc39208d15a68914a"
COMMIT=""
FIXTURE_DIR="${FIXTURE_DIR:-${HOME}/neuravian-fixture}"
REPO_DIR="${NEURAVIAN_DIR:-${HOME}/neuravian}"
REPO_URL="${NEURAVIAN_REPO_URL:-https://github.com/SadhanaArivoli/neuravian.git}"
FS_LICENSE="${FS_LICENSE:-}"
PREPULL=0
DRY_RUN=0
LOG_FILE="${NEURAVIAN_BOOTSTRAP_LOG:-${HOME}/neuravian-bootstrap.log}"
APT_TIMEOUT_SECONDS="${APT_TIMEOUT_SECONDS:-1800}"
DOWNLOAD_TIMEOUT_SECONDS="${DOWNLOAD_TIMEOUT_SECONDS:-900}"
BUILD_TIMEOUT_SECONDS="${BUILD_TIMEOUT_SECONDS:-3600}"

usage() {
  cat <<'EOF'
Usage: bootstrap-x86-ubuntu.sh --commit SHA [options]
  --commit SHA          Exact Neuravian commit to check out (required)
  --fixture-dir PATH    Transferred fixture root
  --license-file PATH   FreeSurfer license path (contents are never printed)
  --prepull             Pull all digest-pinned verification images once
  --repo-dir PATH       Checkout destination (default: ~/neuravian)
  --dry-run             Print mutating commands without executing them
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) COMMIT="${2:?--commit requires a value}"; shift ;;
    --fixture-dir) FIXTURE_DIR="${2:?--fixture-dir requires a value}"; shift ;;
    --license-file) FS_LICENSE="${2:?--license-file requires a value}"; shift ;;
    --repo-dir) REPO_DIR="${2:?--repo-dir requires a value}"; shift ;;
    --prepull) PREPULL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[[ -n "${COMMIT}" ]] || { usage >&2; exit 2; }
[[ "${COMMIT}" =~ ^[0-9a-f]{40}$ ]] || {
  echo "--commit must be an exact 40-character lowercase Git SHA" >&2
  exit 2
}
if [[ "${DRY_RUN}" != 1 ]]; then
  exec > >(tee -a "${LOG_FILE}") 2>&1
else
  echo "DRY-RUN: live bootstrap would log to ${LOG_FILE}"
fi
printf '[%s] Neuravian x86 bootstrap start\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

run() {
  if [[ "${DRY_RUN}" == 1 ]]; then
    printf 'DRY-RUN:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

[[ "$(uname -m)" == "x86_64" ]] || {
  [[ "${DRY_RUN}" == 1 ]] || { echo "Native x86_64 is required" >&2; exit 3; }
  echo "DRY-RUN: would require uname -m = x86_64"
}
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || {
    [[ "${DRY_RUN}" == 1 ]] || { echo "Ubuntu 24.04 is required" >&2; exit 3; }
    echo "DRY-RUN: would require Ubuntu 24.04"
  }
elif [[ "${DRY_RUN}" != 1 ]]; then
  echo "Cannot identify operating system" >&2
  exit 3
fi

export DEBIAN_FRONTEND=noninteractive
run timeout --signal=TERM --kill-after=60s "${APT_TIMEOUT_SECONDS}" sudo apt-get update
run timeout --signal=TERM --kill-after=60s "${APT_TIMEOUT_SECONDS}" \
  sudo apt-get install -y ca-certificates curl git jq python3 python3-pip \
  python3-venv coreutils zip unzip gnupg

if ! command -v docker >/dev/null; then
  run sudo install -m 0755 -d /etc/apt/keyrings
  run timeout --signal=TERM --kill-after=30s "${DOWNLOAD_TIMEOUT_SECONDS}" \
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  run sudo chmod a+r /etc/apt/keyrings/docker.asc
  if [[ "${DRY_RUN}" == 1 ]]; then
    echo "DRY-RUN: write Docker official apt repository configuration"
  else
    arch="$(dpkg --print-architecture)"
    codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
    echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  fi
  run timeout --signal=TERM --kill-after=60s "${APT_TIMEOUT_SECONDS}" sudo apt-get update
  run timeout --signal=TERM --kill-after=60s "${APT_TIMEOUT_SECONDS}" \
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
fi
run timeout --signal=TERM --kill-after=30s 300 sudo systemctl enable --now docker
run sudo usermod -aG docker "${USER}"

docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then docker_cmd=(sudo docker); fi
run timeout --signal=TERM --kill-after=30s 120 "${docker_cmd[@]}" version
run timeout --signal=TERM --kill-after=30s 120 "${docker_cmd[@]}" compose version

if [[ -d "${REPO_DIR}/.git" ]]; then
  run timeout --signal=TERM --kill-after=30s "${DOWNLOAD_TIMEOUT_SECONDS}" \
    git -C "${REPO_DIR}" fetch --prune origin
else
  run timeout --signal=TERM --kill-after=30s "${DOWNLOAD_TIMEOUT_SECONDS}" \
    git clone "${REPO_URL}" "${REPO_DIR}"
fi
run git -C "${REPO_DIR}" checkout --detach "${COMMIT}"
if [[ "${DRY_RUN}" != 1 ]]; then
  actual_commit="$(git -C "${REPO_DIR}" rev-parse HEAD)"
  expected_commit="$(git -C "${REPO_DIR}" rev-parse "${COMMIT}^{commit}")"
  [[ "${actual_commit}" == "${expected_commit}" ]] || {
    echo "Checkout does not match requested commit" >&2; exit 4;
  }
  git -C "${REPO_DIR}" merge-base --is-ancestor \
    "${APPLICATION_BASELINE_COMMIT}" "${actual_commit}" || {
    echo "Preparation commit does not contain the application baseline" >&2
    exit 4
  }
  for required in \
    verification/x86/transfer-fixture.sh \
    verification/x86/prepull-images.sh \
    verification/x86/image-lock.json \
    docs/cloud/aws-launch-checklist.md; do
    [[ -f "${REPO_DIR}/${required}" ]] || {
      echo "Preparation commit is missing required file: ${required}" >&2
      exit 4
    }
  done
fi

run mkdir -p "${REPO_DIR}/data" "${REPO_DIR}/verification/x86/work" \
  "${REPO_DIR}/verification/x86/evidence" "$(dirname "${FIXTURE_DIR}")"
VENV="${REPO_DIR}/.x86-verification-venv"
if [[ ! -x "${VENV}/bin/python" ]]; then
  run python3 -m venv "${VENV}"
fi
run timeout --signal=TERM --kill-after=30s "${DOWNLOAD_TIMEOUT_SECONDS}" \
  "${VENV}/bin/python" -m pip install --disable-pip-version-check \
  'nibabel==5.4.2' 'numpy==2.5.0' 'jsonschema==4.26.0'

if [[ -d "${FIXTURE_DIR}" ]]; then
  run "${VENV}/bin/python" "${REPO_DIR}/verification/fixtures/prepare_fixture.py" \
    --source "${FIXTURE_DIR}" --validate-only
else
  echo "Fixture not present yet at ${FIXTURE_DIR}; transfer it, then rerun this script."
fi
if [[ -n "${FS_LICENSE}" ]]; then
  [[ -r "${FS_LICENSE}" && -s "${FS_LICENSE}" ]] || {
    [[ "${DRY_RUN}" == 1 ]] || { echo "FreeSurfer license is unreadable or empty" >&2; exit 5; }
  }
  echo "FreeSurfer license path is readable and non-empty (contents not printed)."
else
  echo "FS_LICENSE not set; licensed pipeline preflight will remain blocking."
fi

if [[ "${PREPULL}" == 1 ]]; then
  if [[ "${docker_cmd[0]}" == sudo ]]; then
    run sudo "${REPO_DIR}/verification/x86/prepull-images.sh"
  else
    run "${REPO_DIR}/verification/x86/prepull-images.sh"
  fi
fi

if [[ "${DRY_RUN}" != 1 ]]; then
  export HOST_DATASETS_DIR="$(dirname "${FIXTURE_DIR}")"
  export HOST_UID="$(id -u)"
  export HOST_GID="$(id -g)"
fi
compose_cmd=("${docker_cmd[@]}" compose)
if [[ "${docker_cmd[0]}" == sudo ]]; then
  compose_cmd=(sudo env "HOST_DATASETS_DIR=$(dirname "${FIXTURE_DIR}")" \
    "HOST_UID=$(id -u)" "HOST_GID=$(id -g)" docker compose)
fi
run timeout --signal=TERM --kill-after=60s "${BUILD_TIMEOUT_SECONDS}" \
  "${compose_cmd[@]}" -f "${REPO_DIR}/docker-compose.yml" up -d --build
if [[ "${DRY_RUN}" != 1 ]]; then
  healthy=0
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 5 http://127.0.0.1:8000/api/health >/dev/null; then
      healthy=1
      break
    fi
    sleep 2
  done
  [[ "${healthy}" == 1 ]] || { echo "Neuravian health check timed out" >&2; exit 6; }
  curl -fsS --max-time 5 http://127.0.0.1:8000/api/health | jq .
fi
printf '[%s] Bootstrap complete. Log: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOG_FILE}"
echo "If Docker required sudo, reconnect once so docker-group membership takes effect."
echo "No scientific pipeline was executed."
