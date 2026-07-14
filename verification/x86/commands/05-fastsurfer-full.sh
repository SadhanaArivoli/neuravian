#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
FS_LICENSE="${FS_LICENSE:-}"
[[ -f "${FS_LICENSE}" ]] || [[ "${DRY_RUN}" == 1 ]] || die "Set FS_LICENSE to a readable FreeSurfer license file"
verify_common_environment
T1="${FIXTURE_DIR}/sub-01/anat/sub-01_T1w.nii.gz"
params="$(jq -nc --arg license "${FS_LICENSE}" --arg t1 "${T1}" '{fs_license:$license,t1:$t1,sid:"sub-01",sd:"/out",seg_only:false,parallel:true,threads:8,device:"cpu"}')"
if [[ "${DRY_RUN}" == 1 ]]; then
  log "Would preflight and submit full FastSurfer with a 144000s watchdog"
  jq . <<<"${params}"
  exit 0
fi
dataset_id="$(ensure_dataset)"
check_preflight fastsurfer "${dataset_id}" "${params}"
run_id="$(submit_run fastsurfer "${dataset_id}" "${params}")"
printf '%s\n' "${run_id}" >"${RUN_STATE_DIR}/fastsurfer.run-id"
wait_for_run "${run_id}" "${FASTSURFER_TIMEOUT_SECONDS:-144000}" || die "FastSurfer run ${run_id} failed or timed out"
log "FastSurfer run ${run_id} completed; subject-directory validation is still required"
