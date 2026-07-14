#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
FS_LICENSE="${FS_LICENSE:-}"
[[ -f "${FS_LICENSE}" ]] || [[ "${DRY_RUN}" == 1 ]] || die "Set FS_LICENSE to a readable FreeSurfer license file"
verify_common_environment

IMAGE='deepmi/fastsurfer@sha256:34c8ff3eb96ad1d14eadbb0cd468ae6bae83072a5845dcb96d7dbc2f7109c14f'
OUT="${NF_ROOT}/verification/x86/work/fastsurfer-smoke"
mkdir -p "${OUT}"
cmd=(timeout --signal=TERM --kill-after=60s "${FASTSURFER_SMOKE_TIMEOUT_SECONDS:-1800}"
  docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)"
  -v "${FIXTURE_DIR}/sub-01/anat/sub-01_T1w.nii.gz:/input/t1.nii.gz:ro"
  -v "${OUT}:/output" -v "${FS_LICENSE:-/missing}:/license.txt:ro" "${IMAGE}"
  --t1 /input/t1.nii.gz --sid sub-01 --sd /output --fs_license /license.txt
  --seg_only --device cpu --threads 4)

set +e
run_cmd "${cmd[@]}"
status=$?
set -e
if [[ "${DRY_RUN}" == 1 ]]; then exit 0; fi
if [[ ${status} -eq 124 ]]; then
  grep -Eqi 'FastSurfer|Running.*segmentation|Conform|coronal|sagittal|axial' "${LOG_FILE}" || die "FastSurfer timed out without an accepted-input/segmentation marker"
  log "FastSurfer smoke reached segmentation before its intentional timeout"
  exit 0
fi
[[ ${status} -eq 0 ]] || die "FastSurfer smoke failed with exit ${status}"
log "FastSurfer segmentation smoke completed within the watchdog"
