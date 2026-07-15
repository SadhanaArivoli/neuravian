#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
cmd=(timeout --signal=TERM --kill-after=30s "${VALIDATION_TIMEOUT_SECONDS:-1800}"
  "${VERIFY_PYTHON}" "${X86_DIR}/validate_outputs.py" --fixture "${FIXTURE_DIR}"
  --run-state "${RUN_STATE_DIR}" --output "${EVIDENCE_DIR}/validation-results.json")
run_cmd "${cmd[@]}"
