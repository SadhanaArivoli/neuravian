# Viewer Guide

NeuroForge chooses viewers from the artifact's declared type and the files that
are actually available.

## NeuroForge Viewer

Use **Open in NeuroForge Viewer** for compatible NIfTI volumes and cached cloud
artifacts. Axial, coronal, sagittal, multiplanar, and supported 3D views share
the same source artifact. Viewer controls change display only; they do not
modify scientific output files.

## Reports, matrices, and tables

- HTML quality-control reports open in the report viewer.
- Connectivity matrices open in the matrix viewer with labels and metadata.
- ROI, graph, and statistics outputs open as searchable tables.
- Artifact Browser shows files, types, producing runs, sizes, and downstream
  actions.

## External viewers

FreeView and MRIcroGL appear only when installed and compatible with the
selected artifact. If a viewer is missing, use the locate action or install it,
then retry. Cloud-only artifacts must be synchronized before a local external
viewer can open them.

Always verify orientation, voxel geometry, underlay/overlay compatibility, and
the source run before interpreting an image. NeuroForge viewer output is for
research review, not clinical diagnosis.
