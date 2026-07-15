#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR="${ROOT_DIR}/verification/fixtures/prepared/x86-minimal-bids"
MANIFEST="${ROOT_DIR}/verification/fixtures/fixture-manifest.json"
REMOTE_HOST=""
REMOTE_DIR='neuroforge-fixture'
REMOTE_REPO='neuroforge'
IDENTITY_FILE=""
SSH_PORT=22
DRY_RUN=0
TRANSFER_TIMEOUT_SECONDS="${FIXTURE_TRANSFER_TIMEOUT_SECONDS:-1800}"
PYTHON_BIN="${VERIFY_PYTHON:-}"
if [[ -z "${PYTHON_BIN}" && -x "${ROOT_DIR}/backend/.venv/bin/python" ]]; then
  PYTHON_BIN="${ROOT_DIR}/backend/.venv/bin/python"
fi
if [[ -z "${PYTHON_BIN}" ]]; then PYTHON_BIN=python3; fi

usage() {
  cat <<'EOF'
Usage: transfer-fixture.sh --host USER@HOST [options]
  --host USER@HOST       SSH destination (required)
  --source PATH          Prepared fixture root
  --manifest PATH        Fixture manifest
  --destination PATH     VM fixture destination relative to home (default: neuroforge-fixture)
  --repo-dir PATH        VM checkout relative to home (default: neuroforge)
  --identity-file PATH   SSH private key
  --port NUMBER          SSH port (default: 22)
  --dry-run              Validate locally and print commands without connecting
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) REMOTE_HOST="${2:?--host requires a value}"; shift ;;
    --source) SOURCE_DIR="${2:?--source requires a value}"; shift ;;
    --manifest) MANIFEST="${2:?--manifest requires a value}"; shift ;;
    --destination) REMOTE_DIR="${2:?--destination requires a value}"; shift ;;
    --repo-dir) REMOTE_REPO="${2:?--repo-dir requires a value}"; shift ;;
    --identity-file) IDENTITY_FILE="${2:?--identity-file requires a value}"; shift ;;
    --port) SSH_PORT="${2:?--port requires a value}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[[ -n "${REMOTE_HOST}" ]] || { usage >&2; exit 2; }
[[ -d "${SOURCE_DIR}" ]] || { echo "Fixture source not found: ${SOURCE_DIR}" >&2; exit 3; }
[[ -f "${MANIFEST}" ]] || { echo "Fixture manifest not found: ${MANIFEST}" >&2; exit 3; }
[[ "${SSH_PORT}" =~ ^[0-9]+$ ]] || { echo "SSH port must be numeric" >&2; exit 2; }
[[ "${REMOTE_DIR}" != *$'\n'* && "${REMOTE_REPO}" != *$'\n'* ]] || {
  echo "Remote paths must not contain newlines" >&2; exit 2;
}
command -v "${PYTHON_BIN}" >/dev/null || { echo "A verification Python interpreter is required" >&2; exit 3; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 3; }

"${PYTHON_BIN}" "${ROOT_DIR}/verification/fixtures/prepare_fixture.py" \
  --source "${SOURCE_DIR}" --manifest "${MANIFEST}" --validate-only >/dev/null

FILE_COUNT="$(jq -er '.transfer.file_count' "${MANIFEST}")"
TOTAL_BYTES="$(jq -er '.transfer.total_bytes' "${MANIFEST}")"
LIST_FILE="$(mktemp "${TMPDIR:-/tmp}/neuroforge-fixture-files.XXXXXX")"
trap 'rm -f "${LIST_FILE}"' EXIT
jq -er '.files[].path' "${MANIFEST}" >"${LIST_FILE}"
[[ "$(wc -l <"${LIST_FILE}" | tr -d ' ')" == "${FILE_COUNT}" ]] || {
  echo "Manifest file count is inconsistent" >&2; exit 3;
}

ssh_args=(-p "${SSH_PORT}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
rsync_ssh="ssh -p ${SSH_PORT} -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
if [[ -n "${IDENTITY_FILE}" ]]; then
  [[ -r "${IDENTITY_FILE}" ]] || { echo "Identity file is unreadable: ${IDENTITY_FILE}" >&2; exit 3; }
  ssh_args+=(-i "${IDENTITY_FILE}")
  rsync_ssh+=" -i $(printf '%q' "${IDENTITY_FILE}")"
fi

remote_mkdir="mkdir -p $(printf '%q' "${REMOTE_DIR}")"
remote_validate="test -x $(printf '%q' "${REMOTE_REPO}/.x86-verification-venv/bin/python") && $(printf '%q' "${REMOTE_REPO}/.x86-verification-venv/bin/python") $(printf '%q' "${REMOTE_REPO}/verification/fixtures/prepare_fixture.py") --source $(printf '%q' "${REMOTE_DIR}") --manifest $(printf '%q' "${REMOTE_REPO}/verification/fixtures/fixture-manifest.json") --validate-only"
rsync_args=(--archive --partial --append-verify --human-readable --stats
  --files-from="${LIST_FILE}" -e "${rsync_ssh}" "${SOURCE_DIR}/" "${REMOTE_HOST}:${REMOTE_DIR}/")

printf 'Prepared fixture: %s files, %s bytes\n' "${FILE_COUNT}" "${TOTAL_BYTES}"
if [[ "${DRY_RUN}" == 1 ]]; then
  printf 'DRY-RUN:'; printf ' %q' ssh "${ssh_args[@]}" "${REMOTE_HOST}" "${remote_mkdir}"; printf '\n'
  printf 'DRY-RUN:'; printf ' %q' timeout --signal=TERM --kill-after=30s "${TRANSFER_TIMEOUT_SECONDS}" rsync "${rsync_args[@]}"; printf '\n'
  printf 'DRY-RUN:'; printf ' %q' ssh "${ssh_args[@]}" "${REMOTE_HOST}" "${remote_validate}"; printf '\n'
  exit 0
fi

command -v rsync >/dev/null || { echo "rsync is required" >&2; exit 3; }
command -v ssh >/dev/null || { echo "ssh is required" >&2; exit 3; }
command -v timeout >/dev/null || { echo "GNU timeout is required" >&2; exit 3; }
ssh "${ssh_args[@]}" "${REMOTE_HOST}" "${remote_mkdir}"
timeout --signal=TERM --kill-after=30s "${TRANSFER_TIMEOUT_SECONDS}" rsync "${rsync_args[@]}"
ssh "${ssh_args[@]}" "${REMOTE_HOST}" "${remote_validate}"
printf 'Validated fixture on VM: %s files, %s bytes\n' "${FILE_COUNT}" "${TOTAL_BYTES}"
