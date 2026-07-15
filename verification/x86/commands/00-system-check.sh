#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

if [[ "${DRY_RUN}" == 1 ]]; then
  print_command test "$(uname -m)" = x86_64
  print_command test "$(uname -s)" = Linux
  run_cmd docker version
  run_cmd docker compose version
  run_cmd "${VERIFY_PYTHON}" "${NF_ROOT}/verification/fixtures/prepare_fixture.py" \
    --source "${FIXTURE_DIR}" --validate-only
  run_cmd df -h "${NF_ROOT}"
  run_cmd free -h
  run_cmd nproc
  exit 0
fi
require_command jq
require_command docker
require_command "${VERIFY_PYTHON}"
arch="$(uname -m)"
[[ "${arch}" == "x86_64" ]] || die "Native x86_64 is required; found ${arch}"
[[ "$(uname -s)" == "Linux" ]] || die "Linux is required"

run_cmd docker version
run_cmd docker compose version
run_cmd "${VERIFY_PYTHON}" "${NF_ROOT}/verification/fixtures/prepare_fixture.py" \
  --source "${FIXTURE_DIR}" --validate-only
run_cmd df -h "${NF_ROOT}"
run_cmd free -h
run_cmd nproc
log "System preflight passed; x86-sensitive pipelines remain empirically pending"
