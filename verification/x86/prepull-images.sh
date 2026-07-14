#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCK_FILE="${ROOT_DIR}/verification/x86/image-lock.json"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
command -v docker >/dev/null || { echo "Docker CLI is required" >&2; exit 2; }

while IFS= read -r image; do
  if [[ "${DRY_RUN}" == 1 ]]; then
    printf 'docker pull --platform linux/amd64 %q\n' "${image}"
    continue
  fi
  docker pull --platform linux/amd64 "${image}"
  actual_arch="$(docker image inspect "${image}" --format '{{.Os}}/{{.Architecture}}')"
  [[ "${actual_arch}" == "linux/amd64" ]] || {
    echo "Unexpected platform for ${image}: ${actual_arch}" >&2
    exit 3
  }
done < <(jq -r '.images[].pull_reference' "${LOCK_FILE}")
