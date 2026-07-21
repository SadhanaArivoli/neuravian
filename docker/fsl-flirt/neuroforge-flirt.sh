#!/bin/bash
# NeuroForge wrapper for FSL FLIRT.
#
# FLIRT's CLI is: flirt -in <input> -ref <ref> -out <output> -omat <matrix> [options]
# This wrapper translates NeuroForge flag-based arguments to FLIRT's convention
# and resolves the reference image from built-in MNI templates or a custom path.
#
# Usage inside the container:
#   neuroforge-flirt --input <path.nii.gz> [--ref-preset mni152_2mm] [--ref-file <path>]
#                    [--output-base /out/registered] [--searchrx "-90 90"] [-dof 12] ...

set -e

INPUT=""
REF_PRESET="mni152_2mm"
REF_FILE=""
OUTPUT_BASE="/out/registered"
SEARCH_RX=""
SEARCH_RY=""
SEARCH_RZ=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --input)       INPUT="$2";       shift 2 ;;
        --ref-preset)  REF_PRESET="$2";  shift 2 ;;
        --ref-file)    REF_FILE="$2";    shift 2 ;;
        --output-base) OUTPUT_BASE="$2"; shift 2 ;;
        --searchrx)    SEARCH_RX="$2";   shift 2 ;;
        --searchry)    SEARCH_RY="$2";   shift 2 ;;
        --searchrz)    SEARCH_RZ="$2";   shift 2 ;;
        *)             EXTRA_ARGS+=("$1"); shift ;;
    esac
done

if [[ -z "$INPUT" ]]; then
    echo "neuroforge-flirt: error: --input is required" >&2
    exit 1
fi

# Resolve reference image
case "$REF_PRESET" in
    mni152_1mm)
        REF="/usr/local/fsl/data/standard/MNI152_T1_1mm.nii.gz"
        ;;
    mni152_2mm)
        REF="/usr/local/fsl/data/standard/MNI152_T1_2mm.nii.gz"
        ;;
    custom)
        if [[ -z "$REF_FILE" ]]; then
            echo "neuroforge-flirt: error: --ref-file is required when --ref-preset=custom" >&2
            exit 1
        fi
        REF="$REF_FILE"
        ;;
    *)
        echo "neuroforge-flirt: error: unknown --ref-preset '$REF_PRESET'; use mni152_1mm, mni152_2mm, or custom" >&2
        exit 1
        ;;
esac

# Add search angle ranges — each value is "MIN MAX" which bash word-splits into two args
# shellcheck disable=SC2086
[[ -n "$SEARCH_RX" ]] && EXTRA_ARGS+=("-searchrx" $SEARCH_RX)
# shellcheck disable=SC2086
[[ -n "$SEARCH_RY" ]] && EXTRA_ARGS+=("-searchry" $SEARCH_RY)
# shellcheck disable=SC2086
[[ -n "$SEARCH_RZ" ]] && EXTRA_ARGS+=("-searchrz" $SEARCH_RZ)

exec flirt \
    -in "$INPUT" \
    -ref "$REF" \
    -out "${OUTPUT_BASE}.nii.gz" \
    -omat "${OUTPUT_BASE}.mat" \
    "${EXTRA_ARGS[@]}"
