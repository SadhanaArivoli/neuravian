#!/bin/bash
# Neuravian wrapper for FSL FNIRT.
#
# FNIRT's native CLI uses key=value syntax:
#   fnirt --in=input.nii.gz --ref=ref.nii.gz --aff=affine.mat \
#         --config=T1_2_MNI152_2mm.cnf --cout=warpcoef --iout=result
#
# This wrapper translates Neuravian flag-based arguments (--input, --ref-preset,
# --aff-mat, etc.) into FNIRT's native convention, resolves reference image
# presets and config files from the FSL container bundle, and writes outputs
# to /out/ with predictable filenames for artifact classification.
#
# Usage inside the container:
#   neuravian-fnirt --input <brain.nii.gz> \
#                    [--aff-mat <affine.mat>] \
#                    [--ref-preset mni152_2mm|mni152_1mm|custom] \
#                    [--ref-file <custom_ref.nii.gz>] \
#                    [--config-preset T1_2_MNI152_2mm|T1_2_MNI152_1mm|none|custom] \
#                    [--config-file <path.cnf>] \
#                    [--output-base /out/fnirt] \
#                    [--output-field [true|false]] \
#                    [--output-jacobian [true|false]]
#
# Always produced:
#   /out/fnirt_warpcoef.nii.gz  — B-spline coefficient field (needed for applywarp)
#   /out/fnirt_result.nii.gz    — input image resampled into reference space
#
# Optionally produced:
#   /out/fnirt_field.nii.gz     — full displacement field in mm (--output-field true)
#   /out/fnirt_jac.nii.gz       — Jacobian determinant map (--output-jacobian true)

set -e

INPUT=""
AFF_MAT=""
REF_PRESET="mni152_2mm"
REF_FILE=""
CONFIG_PRESET="T1_2_MNI152_2mm"
CONFIG_FILE=""
OUTPUT_BASE="/out/fnirt"
OUTPUT_FIELD="false"
OUTPUT_JACOBIAN="false"
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --input)           INPUT="$2";           shift 2 ;;
        --aff-mat)         AFF_MAT="$2";         shift 2 ;;
        --ref-preset)      REF_PRESET="$2";      shift 2 ;;
        --ref-file)        REF_FILE="$2";        shift 2 ;;
        --config-preset)   CONFIG_PRESET="$2";   shift 2 ;;
        --config-file)     CONFIG_FILE="$2";     shift 2 ;;
        --output-base)     OUTPUT_BASE="$2";     shift 2 ;;
        --output-field)
            # Accept both standalone flag (executor boolean) and --output-field true/false
            if [[ "${2:-}" == "true" || "${2:-}" == "false" ]]; then
                OUTPUT_FIELD="$2"; shift 2
            else
                OUTPUT_FIELD="true"; shift 1
            fi ;;
        --output-jacobian)
            if [[ "${2:-}" == "true" || "${2:-}" == "false" ]]; then
                OUTPUT_JACOBIAN="$2"; shift 2
            else
                OUTPUT_JACOBIAN="true"; shift 1
            fi ;;
        *)                 EXTRA_ARGS+=("$1");    shift ;;
    esac
done

if [[ -z "$INPUT" ]]; then
    echo "neuravian-fnirt: error: --input is required" >&2
    exit 1
fi

# ── Resolve reference image and its brain mask ────────────────────────────────
case "$REF_PRESET" in
    mni152_1mm)
        REF="/usr/local/fsl/data/standard/MNI152_T1_1mm.nii.gz"
        REF_MASK="/usr/local/fsl/data/standard/MNI152_T1_1mm_brain_mask.nii.gz"
        ;;
    mni152_2mm)
        REF="/usr/local/fsl/data/standard/MNI152_T1_2mm.nii.gz"
        REF_MASK="/usr/local/fsl/data/standard/MNI152_T1_2mm_brain_mask.nii.gz"
        ;;
    custom)
        if [[ -z "$REF_FILE" ]]; then
            echo "neuravian-fnirt: error: --ref-file is required when --ref-preset=custom" >&2
            exit 1
        fi
        REF="$REF_FILE"
        REF_MASK=""
        ;;
    *)
        echo "neuravian-fnirt: error: unknown --ref-preset '$REF_PRESET'; use mni152_1mm, mni152_2mm, or custom" >&2
        exit 1
        ;;
esac

# ── Resolve FNIRT configuration file ─────────────────────────────────────────
case "$CONFIG_PRESET" in
    T1_2_MNI152_2mm)
        CONFIG="/usr/local/fsl/etc/flirtsch/T1_2_MNI152_2mm.cnf"
        ;;
    T1_2_MNI152_1mm)
        CONFIG="/usr/local/fsl/etc/flirtsch/T1_2_MNI152_1mm.cnf"
        ;;
    none)
        CONFIG=""
        ;;
    custom)
        if [[ -z "$CONFIG_FILE" ]]; then
            echo "neuravian-fnirt: error: --config-file is required when --config-preset=custom" >&2
            exit 1
        fi
        CONFIG="$CONFIG_FILE"
        ;;
    *)
        echo "neuravian-fnirt: error: unknown --config-preset '$CONFIG_PRESET'; use T1_2_MNI152_2mm, T1_2_MNI152_1mm, none, or custom" >&2
        exit 1
        ;;
esac

# ── Assemble FNIRT arguments ──────────────────────────────────────────────────
FNIRT_ARGS=(
    "--in=$INPUT"
    "--ref=$REF"
    "--cout=${OUTPUT_BASE}_warpcoef"
    "--iout=${OUTPUT_BASE}_result"
)

[[ -n "$AFF_MAT" ]]   && FNIRT_ARGS+=("--aff=$AFF_MAT")
[[ -n "$REF_MASK" ]]  && FNIRT_ARGS+=("--refmask=$REF_MASK")
[[ -n "$CONFIG" ]]    && FNIRT_ARGS+=("--config=$CONFIG")

[[ "$OUTPUT_FIELD" == "true" ]]    && FNIRT_ARGS+=("--fout=${OUTPUT_BASE}_field")
[[ "$OUTPUT_JACOBIAN" == "true" ]] && FNIRT_ARGS+=("--jout=${OUTPUT_BASE}_jac")

FNIRT_ARGS+=("${EXTRA_ARGS[@]}")

exec fnirt "${FNIRT_ARGS[@]}"
