#!/bin/bash
# Neuravian wrapper for FSL FAST.
#
# FAST's CLI is: fast [options] <input.nii.gz>
# Neuravian's executor passes flag-based arguments, so this wrapper
# extracts --input and --output-base then calls FAST with the correct
# convention. All other arguments pass through unchanged.
#
# Usage inside the container:
#   neuravian-fast --input <path.nii.gz> --output-base <prefix> [-n 3] [-t 1] ...

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
    echo "neuravian-fast: error: --input is required" >&2
    exit 1
fi
if [[ -z "$OUTPUT_BASE" ]]; then
    OUTPUT_BASE="/out/result"
fi

exec fast -o "$OUTPUT_BASE" "${EXTRA_ARGS[@]}" "$INPUT"
