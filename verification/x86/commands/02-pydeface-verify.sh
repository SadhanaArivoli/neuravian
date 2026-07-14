#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
MAX_SECONDS="${PYDEFACE_TIMEOUT_SECONDS:-3600}"
T1="${FIXTURE_DIR}/sub-01/anat/sub-01_T1w.nii.gz"

verify_common_environment
params="$(jq -nc --arg t1 "${T1}" '{"nifti-file":$t1,"outfile":"/out/defaced.nii.gz","force":true,"cost":"mutualinfo","verbose":true}')"
if [[ "${DRY_RUN}" == 1 ]]; then
  log "Would preflight and submit pydeface with a ${MAX_SECONDS}s watchdog"
  jq . <<<"${params}"
  exit 0
fi
dataset_id="$(ensure_dataset)"
check_preflight pydeface "${dataset_id}" "${params}"
run_id="$(submit_run pydeface "${dataset_id}" "${params}")"
printf '%s\n' "${run_id}" >"${RUN_STATE_DIR}/pydeface.run-id"
wait_for_run "${run_id}" "${MAX_SECONDS}" || die "pydeface run ${run_id} failed or timed out"
log "pydeface run ${run_id} completed; output validation is still required"
