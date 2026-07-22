#!/usr/bin/env bash

X86_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NF_ROOT="${NF_ROOT:-$(cd "${X86_DIR}/../.." && pwd)}"
API_URL="${NEURAVIAN_API_URL:-http://127.0.0.1:8000/api}"
FIXTURE_DIR="${FIXTURE_DIR:-${NF_ROOT}/verification/fixtures/prepared/x86-minimal-bids}"
EVIDENCE_DIR="${EVIDENCE_DIR:-${NF_ROOT}/verification/x86/evidence}"
RUN_STATE_DIR="${RUN_STATE_DIR:-${EVIDENCE_DIR}/run-state}"
LOG_DIR="${LOG_DIR:-${EVIDENCE_DIR}/logs}"
DRY_RUN="${DRY_RUN:-0}"
VERIFY_PYTHON="${VERIFY_PYTHON:-${NF_ROOT}/.x86-verification-venv/bin/python}"
if [[ ! -x "${VERIFY_PYTHON}" ]]; then VERIFY_PYTHON=python3; fi

mkdir -p "${LOG_DIR}" "${RUN_STATE_DIR}"
SCRIPT_NAME="$(basename "${0}" .sh)"
LOG_FILE="${LOG_DIR}/${SCRIPT_NAME}-$(date -u +%Y%m%dT%H%M%SZ).log"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG_FILE}" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

print_command() {
  printf 'DRY-RUN:' | tee -a "${LOG_FILE}" >&2
  printf ' %q' "$@" | tee -a "${LOG_FILE}" >&2
  printf '\n' | tee -a "${LOG_FILE}" >&2
}

run_cmd() {
  if [[ "${DRY_RUN}" == 1 ]]; then
    print_command "$@"
    return 0
  fi
  log "Running: $(printf '%q ' "$@")"
  "$@" 2>&1 | tee -a "${LOG_FILE}"
}

require_command() {
  command -v "$1" >/dev/null || die "Required command not found: $1"
}

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "${body}" ]]; then
    curl --fail --silent --show-error --connect-timeout 10 --max-time 120 \
      -X "${method}" -H 'Content-Type: application/json' \
      --data "${body}" "${API_URL}${path}"
  else
    curl --fail --silent --show-error --connect-timeout 10 --max-time 120 \
      -X "${method}" "${API_URL}${path}"
  fi
}

ensure_dataset() {
  local existing response
  existing="$(api GET '/datasets' | jq -r --arg path "${FIXTURE_DIR}" \
    '.[] | select(.path == $path) | .id' | head -n 1)"
  if [[ -n "${existing}" ]]; then
    printf '%s\n' "${existing}"
    return 0
  fi
  response="$(api POST '/datasets' "$(jq -nc --arg path "${FIXTURE_DIR}" '{path:$path}')")"
  jq -er '.id' <<<"${response}"
}

check_preflight() {
  local pipeline="$1"
  local dataset_id="$2"
  local params="$3"
  local response
  response="$(api POST "/pipelines/${pipeline}/preflight" \
    "$(jq -nc --argjson dataset_id "${dataset_id}" --argjson params "${params}" \
      '{dataset_id:$dataset_id,params:$params}')")"
  jq . <<<"${response}" | tee -a "${LOG_FILE}" >&2
  if jq -e '[.checks[] | select(.blocking == true and .status == "fail")] | length > 0' \
    >/dev/null <<<"${response}"; then
    die "Blocking preflight failure for ${pipeline}"
  fi
}

submit_run() {
  local pipeline="$1"
  local dataset_id="$2"
  local params="$3"
  local response run_id
  response="$(api POST '/runs' \
    "$(jq -nc --arg pipeline_id "${pipeline}" \
      --argjson dataset_id "${dataset_id}" --argjson params "${params}" \
      '{pipeline_id:$pipeline_id,dataset_id:$dataset_id,params:$params}')")"
  run_id="$(jq -er '.id' <<<"${response}")"
  printf '%s\n' "${response}" >"${RUN_STATE_DIR}/${pipeline}-${run_id}.created.json"
  printf '%s\n' "${run_id}"
}

wait_for_run() {
  local run_id="$1"
  local timeout_seconds="$2"
  local started now status response
  started="$(date +%s)"
  while true; do
    response="$(api GET "/runs/${run_id}")"
    status="$(jq -r '.status' <<<"${response}")"
    printf '%s\n' "${response}" >"${RUN_STATE_DIR}/run-${run_id}-latest.json"
    log "Run ${run_id}: ${status}"
    case "${status}" in
      completed) return 0 ;;
      failed|cancelled|interrupted) return 1 ;;
    esac
    now="$(date +%s)"
    if (( now - started >= timeout_seconds )); then
      log "Run ${run_id} exceeded ${timeout_seconds}s; requesting cancellation"
      if ! api POST "/runs/${run_id}/cancel" '{}' >>"${LOG_FILE}"; then
        log "ERROR: cancellation request failed for timed-out run ${run_id}"
        return 125
      fi
      return 124
    fi
    sleep 30
  done
}

verify_common_environment() {
  require_command curl
  require_command jq
  if [[ "${DRY_RUN}" == 1 ]]; then
    return 0
  fi
  require_command docker
  [[ -d "${FIXTURE_DIR}" ]] || die "Fixture directory not found: ${FIXTURE_DIR}"
}
