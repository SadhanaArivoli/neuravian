#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

require_command curl
require_command jq
if [[ "${DRY_RUN}" == 1 ]]; then
  print_command curl --fail --max-time 30 "${API_URL}/health"
  print_command curl --fail --max-time 30 "${API_URL}/pipelines"
  exit 0
fi
api GET '/health' | jq . | tee -a "${LOG_FILE}"
api GET '/pipelines' | jq '[.[] | select(.id == "pydeface" or .id == "fmriprep" or .id == "fastsurfer") | {id,compute_profile}]' | tee -a "${LOG_FILE}"
log "Neuravian API health checks passed"
