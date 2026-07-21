# NeuroForge FSL FNIRT wrapper image.
#
# Derives from brainlife/fsl (FSL 6.0.7, Ubuntu 22.04) and adds a thin
# /usr/local/bin/neuroforge-fnirt wrapper script that exposes FNIRT through
# a flag-based CLI (--input, --ref-preset, --aff-mat, --config-preset, etc.)
# compatible with NeuroForge's generic Docker executor.
#
# Built-in MNI templates are available at:
#   /usr/local/fsl/data/standard/MNI152_T1_1mm.nii.gz
#   /usr/local/fsl/data/standard/MNI152_T1_2mm.nii.gz
#   /usr/local/fsl/data/standard/MNI152_T1_1mm_brain_mask.nii.gz
#   /usr/local/fsl/data/standard/MNI152_T1_2mm_brain_mask.nii.gz
#
# Built-in FNIRT config files are available at:
#   /usr/local/fsl/etc/flirtsch/T1_2_MNI152_2mm.cnf
#   /usr/local/fsl/etc/flirtsch/T1_2_MNI152_1mm.cnf
#
# No template or config files need to be mounted; the wrapper resolves
# preset names to these container-internal paths automatically.
#
# Build locally (needed once before submitting a FNIRT run):
#   docker build --platform linux/amd64 \
#     -t ghcr.io/neuroforge/fsl-fnirt:6.0.7 \
#     docker/fsl-fnirt/
#
# Image is x86_64-only. On Apple Silicon, Docker Desktop runs it via
# Rosetta 2 emulation. FNIRT to MNI152 2mm takes 3-15 min natively and
# 30-90 min under emulation; 1mm takes significantly longer.
#
# Base image: brainlife/fsl:latest (FSL 6.0.7.22, Ubuntu 22.04)
# Digest (2026-07-19): sha256:e17b13fe4af7ec79643595bb2de16584193234b99cb2fafbd7c786a1dc8b8d43

FROM brainlife/fsl@sha256:e17b13fe4af7ec79643595bb2de16584193234b99cb2fafbd7c786a1dc8b8d43

COPY neuroforge-fnirt.sh /usr/local/bin/neuroforge-fnirt
RUN chmod +x /usr/local/bin/neuroforge-fnirt

ENTRYPOINT ["neuroforge-fnirt"]
CMD []
