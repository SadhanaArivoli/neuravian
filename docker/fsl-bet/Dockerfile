# NeuroForge FSL BET wrapper image.
#
# Derives from brainlife/fsl (FSL 6.0.7, Ubuntu 22.04) and adds a thin
# /usr/local/bin/neuroforge-bet wrapper script that exposes BET through
# a flag-based CLI (--input, --output-base) compatible with NeuroForge's
# generic Docker executor, which cannot emit BET's positional convention.
#
# Build locally (needed once before submitting a BET run):
#   docker build --platform linux/amd64 \
#     -t ghcr.io/neuroforge/fsl-bet:6.0.7 \
#     docker/fsl-bet/
#
# Image is x86_64-only. On Apple Silicon, Docker Desktop runs it via
# Rosetta 2 emulation (~2-8 minutes per T1w). On native x86_64 Linux
# BET completes in <30 seconds for a standard 1mm T1w volume.
#
# Base image: brainlife/fsl:latest (FSL 6.0.7.22, Ubuntu 22.04)
# Digest (2026-07-19): sha256:e17b13fe4af7ec79643595bb2de16584193234b99cb2fafbd7c786a1dc8b8d43

FROM brainlife/fsl@sha256:e17b13fe4af7ec79643595bb2de16584193234b99cb2fafbd7c786a1dc8b8d43

COPY neuroforge-bet.sh /usr/local/bin/neuroforge-bet
RUN chmod +x /usr/local/bin/neuroforge-bet

ENTRYPOINT ["neuroforge-bet"]
CMD []
