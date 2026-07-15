#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCK_FILE="${ROOT_DIR}/verification/x86/image-lock.json"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
PULL_TIMEOUT_SECONDS="${IMAGE_PULL_TIMEOUT_SECONDS:-7200}"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
if [[ "${DRY_RUN}" != 1 ]]; then
  command -v docker >/dev/null || { echo "Docker CLI is required" >&2; exit 2; }
fi

while IFS= read -r image; do
  if [[ "${DRY_RUN}" == 1 ]]; then
    printf 'timeout --signal=TERM --kill-after=60s %q docker pull --platform linux/amd64 %q\n' \
      "${PULL_TIMEOUT_SECONDS}" "${image}"
    continue
  fi
  timeout --signal=TERM --kill-after=60s "${PULL_TIMEOUT_SECONDS}" \
    docker pull --platform linux/amd64 "${image}"
  actual_arch="$(docker image inspect "${image}" --format '{{.Os}}/{{.Architecture}}')"
  [[ "${actual_arch}" == "linux/amd64" ]] || {
    echo "Unexpected platform for ${image}: ${actual_arch}" >&2
    exit 3
  }
done < <(jq -r '.images[].pull_reference' "${LOCK_FILE}")
