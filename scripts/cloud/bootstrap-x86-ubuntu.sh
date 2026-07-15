#!/usr/bin/env bash
set -euo pipefail

COMMIT=""
FIXTURE_DIR="${FIXTURE_DIR:-${HOME}/neuroforge-fixture}"
REPO_DIR="${NEUROFORGE_DIR:-${HOME}/neuroforge}"
REPO_URL="${NEUROFORGE_REPO_URL:-https://github.com/SadhanaArivoli/neuroforge.git}"
FS_LICENSE="${FS_LICENSE:-}"
PREPULL=0
DRY_RUN=0
LOG_FILE="${NEUROFORGE_BOOTSTRAP_LOG:-${HOME}/neuroforge-bootstrap.log}"

usage() {
  cat <<'EOF'
Usage: bootstrap-x86-ubuntu.sh --commit SHA [options]
  --commit SHA          Exact NeuroForge commit to check out (required)
  --fixture-dir PATH    Transferred fixture root
  --license-file PATH   FreeSurfer license path (contents are never printed)
  --prepull             Pull all digest-pinned verification images once
  --repo-dir PATH       Checkout destination (default: ~/neuroforge)
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
if [[ "${DRY_RUN}" != 1 ]]; then
  exec > >(tee -a "${LOG_FILE}") 2>&1
else
  echo "DRY-RUN: live bootstrap would log to ${LOG_FILE}"
fi
printf '[%s] NeuroForge x86 bootstrap start\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

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
run sudo apt-get update
run sudo apt-get install -y ca-certificates curl git jq python3 python3-pip \
  python3-venv coreutils zip unzip gnupg

if ! command -v docker >/dev/null; then
  run sudo install -m 0755 -d /etc/apt/keyrings
  run sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
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
  run sudo apt-get update
  run sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
fi
run sudo systemctl enable --now docker
run sudo usermod -aG docker "${USER}"

docker_cmd=(docker)
if ! docker info >/dev/null 2>&1; then docker_cmd=(sudo docker); fi
run "${docker_cmd[@]}" version
run "${docker_cmd[@]}" compose version

if [[ -d "${REPO_DIR}/.git" ]]; then
  run git -C "${REPO_DIR}" fetch --prune origin
else
  run git clone "${REPO_URL}" "${REPO_DIR}"
fi
run git -C "${REPO_DIR}" checkout --detach "${COMMIT}"
if [[ "${DRY_RUN}" != 1 ]]; then
  actual_commit="$(git -C "${REPO_DIR}" rev-parse HEAD)"
  expected_commit="$(git -C "${REPO_DIR}" rev-parse "${COMMIT}^{commit}")"
  [[ "${actual_commit}" == "${expected_commit}" ]] || {
    echo "Checkout does not match requested commit" >&2; exit 4;
  }
fi

run mkdir -p "${REPO_DIR}/data" "${REPO_DIR}/verification/x86/work" \
  "${REPO_DIR}/verification/x86/evidence" "$(dirname "${FIXTURE_DIR}")"
VENV="${REPO_DIR}/.x86-verification-venv"
if [[ ! -x "${VENV}/bin/python" ]]; then
  run python3 -m venv "${VENV}"
fi
run "${VENV}/bin/python" -m pip install --disable-pip-version-check \
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
run "${compose_cmd[@]}" -f "${REPO_DIR}/docker-compose.yml" up -d --build
if [[ "${DRY_RUN}" != 1 ]]; then
  for _ in $(seq 1 60); do
    curl -fsS --max-time 5 http://127.0.0.1:8000/api/health >/dev/null && break
    sleep 2
  done
  curl -fsS --max-time 5 http://127.0.0.1:8000/api/health | jq .
fi
printf '[%s] Bootstrap complete. Log: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LOG_FILE}"
echo "If Docker required sudo, reconnect once so docker-group membership takes effect."
echo "No scientific pipeline was executed."
