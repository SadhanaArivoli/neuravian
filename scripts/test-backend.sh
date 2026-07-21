#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${REPOSITORY_ROOT}/backend"

fail() {
  printf 'Backend verification error: %s\n' "$*" >&2
  exit 1
}

command -v uv >/dev/null 2>&1 || fail "uv is required (https://docs.astral.sh/uv/)."
command -v git >/dev/null 2>&1 || fail "git is required by repository verification tests."
command -v jq >/dev/null 2>&1 || fail "jq is required by x86 fixture verification tests."
[[ -f "${BACKEND_DIR}/uv.lock" ]] || fail "backend/uv.lock is missing."

# The root .env belongs to Docker Compose and contains host UID/dataset keys
# that are not backend Settings fields. Run from backend/ so Pydantic does not
# ingest that file, and remove production namespace variables so unit tests can
# create isolated temporary datasets without inheriting a developer machine's
# configuration.
unset HOST_DATASETS_MOUNT
unset BACKEND_DATASETS_MOUNT
unset HOST_DATASETS_DIR
unset HOST_UID
unset HOST_GID
unset DATABASE_URL
unset DATA_DIR

export PYTHONPATH="${REPOSITORY_ROOT}:${BACKEND_DIR}${PYTHONPATH:+:${PYTHONPATH}}"

cd "${BACKEND_DIR}"
exec uv run --locked pytest -q -p no:cacheprovider "$@"
