#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
STOP_SERVICES=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --stop-services) STOP_SERVICES=1 ;;
    *) echo "Unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

run_cmd docker ps --filter label=neuroforge.run_id --format '{{.ID}} {{.Names}} {{.Status}}'
if [[ "${STOP_SERVICES}" == 1 ]]; then
  run_cmd docker compose -f "${NF_ROOT}/docker-compose.yml" stop
else
  log "NeuroForge services left running; pass --stop-services to stop without deleting them"
fi
log "No images, volumes, containers, cloud instances, or other resources were deleted"
log "After the evidence ZIP is downloaded and verified, stop the VM through the cloud console"
