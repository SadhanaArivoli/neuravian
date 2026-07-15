#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
cmd=("${VERIFY_PYTHON}" "${X86_DIR}/collect_evidence.py" --evidence-dir "${EVIDENCE_DIR}"
  --output "${X86_DIR}/neuroforge-x86-evidence.zip")
run_cmd "${cmd[@]}"
