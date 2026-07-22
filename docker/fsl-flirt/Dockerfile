# Neuravian FSL FLIRT wrapper image.
#
# Derives from brainlife/fsl (FSL 6.0.7, Ubuntu 22.04) and adds a thin
# /usr/local/bin/neuravian-flirt wrapper script that exposes FLIRT through
# a flag-based CLI (--input, --ref-preset, --ref-file, --output-base)
# compatible with Neuravian's generic Docker executor.
#
# Built-in MNI templates are available at:
#   /usr/local/fsl/data/standard/MNI152_T1_1mm.nii.gz
#   /usr/local/fsl/data/standard/MNI152_T1_2mm.nii.gz
# No template files need to be mounted; the wrapper resolves preset names
# to these container-internal paths automatically.
#
# Build locally (needed once before submitting a FLIRT run):
#   docker build --platform linux/amd64 \
#     -t neuravian/fsl-flirt:6.0.7 \
#     docker/fsl-flirt/
#
# Image is x86_64-only. On Apple Silicon, Docker Desktop runs it via
# Rosetta 2 emulation. FLIRT to MNI152 2mm takes ~1-3 min natively and
# ~5-20 min under emulation.
#
# Base image: brainlife/fsl:latest (FSL 6.0.7.22, Ubuntu 22.04)
# Digest (2026-07-19): sha256:e17b13fe4af7ec79643595bb2de16584193234b99cb2fafbd7c786a1dc8b8d43

FROM brainlife/fsl@sha256:e17b13fe4af7ec79643595bb2de16584193234b99cb2fafbd7c786a1dc8b8d43

COPY neuravian-flirt.sh /usr/local/bin/neuravian-flirt
RUN chmod +x /usr/local/bin/neuravian-flirt

ENTRYPOINT ["neuravian-flirt"]
CMD []
