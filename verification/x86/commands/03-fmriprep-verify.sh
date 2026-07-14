#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
MODE=smoke
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --mode) MODE="${2:?--mode requires smoke or full}"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
FS_LICENSE="${FS_LICENSE:-}"
[[ -f "${FS_LICENSE}" ]] || [[ "${DRY_RUN}" == 1 ]] || die "Set FS_LICENSE to a readable FreeSurfer license file"
verify_common_environment

IMAGE='nipreps/fmriprep@sha256:15cbf8dcd17440d26ff5e80e9f7313f1cb3c54f13673f1ec4aed4465e8e12d77'
OUT="${NF_ROOT}/verification/x86/work/fmriprep-output"
WORK="${NF_ROOT}/verification/x86/work/fmriprep-work"
TEMPLATEFLOW="${NF_ROOT}/verification/x86/work/templateflow"

if [[ "${MODE}" == smoke ]]; then
  mkdir -p "${OUT}" "${WORK}" "${TEMPLATEFLOW}"
  smoke=(timeout --signal=TERM --kill-after=60s 1800 docker run --rm --platform linux/amd64
    -v "${FIXTURE_DIR}:/data:ro" -v "${OUT}:/out" -v "${WORK}:/work"
    -v "${TEMPLATEFLOW}:/templateflow" -v "${FS_LICENSE:-/missing}:/license.txt:ro"
    -e TEMPLATEFLOW_HOME=/templateflow "${IMAGE}" /data /out participant
    --participant-label 01 --fs-license-file /license.txt --fs-no-reconall
    --boilerplate-only --work-dir /work --nprocs 4 --omp-nthreads 2
    --mem-mb 28000 --output-spaces MNI152NLin2009cAsym)
  run_cmd "${smoke[@]}"
  if [[ "${DRY_RUN}" == 1 ]]; then
    log "Dry-run only: fMRIPrep smoke was not executed"
    exit 0
  fi
  log "fMRIPrep smoke completed; this proves startup/workflow construction only"
  exit 0
fi
[[ "${MODE}" == full ]] || die "--mode must be smoke or full"
params="$(jq -nc --arg license "${FS_LICENSE}" --arg work "${WORK}" '{"fs-license-file":$license,"analysis_level":"participant","participant-label":"01","fs-no-reconall":true,"output-spaces":["MNI152NLin2009cAsym"],"nprocs":4,"omp-nthreads":2,"mem":28000,"work-dir":$work}')"
if [[ "${DRY_RUN}" == 1 ]]; then
  log "Would preflight and submit complete minimal fMRIPrep with an 86400s watchdog"
  jq . <<<"${params}"
  exit 0
fi
dataset_id="$(ensure_dataset)"
check_preflight fmriprep "${dataset_id}" "${params}"
run_id="$(submit_run fmriprep "${dataset_id}" "${params}")"
printf '%s\n' "${run_id}" >"${RUN_STATE_DIR}/fmriprep.run-id"
wait_for_run "${run_id}" "${FMRIPREP_TIMEOUT_SECONDS:-86400}" || die "fMRIPrep run ${run_id} failed or timed out"
log "fMRIPrep run ${run_id} completed; derivative validation is still required"
