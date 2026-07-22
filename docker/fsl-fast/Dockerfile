# Neuravian FSL FAST wrapper image.
#
# Derives from brainlife/fsl (FSL 6.0.7, Ubuntu 22.04) and adds a thin
# /usr/local/bin/neuravian-fast wrapper script that exposes FAST through
# a flag-based CLI (--input, --output-base) compatible with Neuravian's
# generic Docker executor.
#
# Build locally (needed once before submitting a FAST run):
#   docker build --platform linux/amd64 \
#     -t neuravian/fsl-fast:6.0.7 \
#     docker/fsl-fast/
#
# Image is x86_64-only. On Apple Silicon, Docker Desktop runs it via
# Rosetta 2 emulation. FAST on a 1mm T1w takes ~3-5 min natively and
# ~15-40 min under emulation.
#
# Base image: brainlife/fsl:latest (FSL 6.0.7.22, Ubuntu 22.04)
# Digest (2026-07-19): sha256:e17b13fe4af7ec79643595bb2de16584193234b99cb2fafbd7c786a1dc8b8d43

FROM brainlife/fsl@sha256:e17b13fe4af7ec79643595bb2de16584193234b99cb2fafbd7c786a1dc8b8d43

COPY neuravian-fast.sh /usr/local/bin/neuravian-fast
RUN chmod +x /usr/local/bin/neuravian-fast

ENTRYPOINT ["neuravian-fast"]
CMD []
