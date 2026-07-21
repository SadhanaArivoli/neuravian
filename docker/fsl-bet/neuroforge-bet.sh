#!/bin/bash
# NeuroForge wrapper for FSL BET.
#
# BET's CLI is: bet <input> <output_prefix> [options]
# NeuroForge's executor passes flag-based arguments, so this wrapper
# extracts --input and --output-base then calls BET with the correct
# positional convention. All other arguments pass through unchanged.
#
# Usage inside the container:
#   neuroforge-bet --input <path.nii.gz> --output-base <prefix> [-m] [-f 0.5] ...

set -e

INPUT=""
OUTPUT_BASE=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --input)       INPUT="$2";       shift 2 ;;
        --output-base) OUTPUT_BASE="$2"; shift 2 ;;
        *)             EXTRA_ARGS+=("$1"); shift ;;
    esac
done

if [[ -z "$INPUT" ]]; then
    echo "neuroforge-bet: error: --input is required" >&2
    exit 1
fi
if [[ -z "$OUTPUT_BASE" ]]; then
    OUTPUT_BASE="/out/brain"
fi

exec bet "$INPUT" "$OUTPUT_BASE" "${EXTRA_ARGS[@]}"
