# Unified neuroimaging viewer

## Scope and scientific contract

The Neuravian viewer is a run-scoped, artifact-aware inspection workspace. It extends the existing NiiVue volume viewer; it does not alter derivatives, register images, resample overlays, or replace an official pipeline QC report. A file is offered a **View** action only when its format and scientific role have a safe renderer. Transforms, annotations without a surface, and unknown files remain available through metadata and download actions.

The architecture separates ten concerns:

1. `neuroArtifactView.ts` classifies artifacts and normalizes BIDS/FreeSurfer entities.
2. `volumeCompatibility.ts` validates dimensions, voxel size, affine, orientation, and declared space.
3. volume loaders fetch run-scoped bytes, enforce size limits, and adapt supported formats in memory.
4. surface loaders use NiiVue's bounded mesh parser and never interpret arbitrary remote URLs.
5. display profiles select scientific defaults for intensity, mask, label, probability, statistics, and surfaces.
6. the layer manager owns order, visibility, opacity, threshold, colormap, interpolation, and presets.
7. probes and measurement tools report values with coordinates and units.
8. time-series controls own frame state and bounded 4D access.
9. artifact cards expose normalized metadata without host paths.
10. publication export rerenders a clean view with explicit provenance options.

The internal artifact view model contains a run-scoped artifact ID/path, role, modality/format, BIDS entities, anatomical space, hemisphere, renderability, preferred base semantics, section, and display profile. Geometry that is only available after parsing is kept with the loaded layer—not guessed from filenames.

## Empirical inventory used for the design

The inventory was collected read-only from the completed deployment on 2026-07-15/16. It contains metadata only; no participant images, image bytes, license contents, credentials, or deployment paths are stored here.

### fMRIPrep Run 5

Run 5 completed successfully in 2 h 6 m 31 s. Its derivative inventory contains 55 files:

- native T1w, mask, dseg, and GM/WM/CSF probability images: `160 x 192 x 192`, RAS, `1 x 1.333 x 1.333 mm`; float32 intensity/probability, int16 labels, and uint8 masks;
- MNI T1w, mask, dseg, and probability images: `193 x 173 x 146`, RAS, `1 x 1.333 x 1.333 mm`;
- native/coregistered BOLD references and mask: `64 x 64 x 33`, LAS, `3.125 x 3.125 x 4 mm`;
- MNI BOLD reference and mask: `50 x 62 x 43`, RAS, `3.125 x 3.125 x 4 mm`;
- MNI preprocessed BOLD: `50 x 62 x 43 x 300`, float32, TR 2 s;
- confounds TSV/JSON, HDF5 and text transforms, the official participant HTML report, SVG/HTML reportlets, citations, and run metadata.

All inspected NIfTI images declared intent `none`, finite geometry, and unit scaling (`slope=1`, `intercept=0`). Native and MNI grids differ and therefore must never be silently overlaid.

### FastSurfer Run 7

Run 7 completed successfully with exit code 0 in 35 m 34 s. It contains 28 regular files (about 21.6 MiB) plus its preserved artifact link. The output is a segmentation-only result:

- conformed anatomy: `mri/orig.mgz`, `mri/orig/001.mgz`, and `mri/orig_nu.mgz`;
- volumetric labels/masks: deep aseg/aparc variants, automatic aseg variants, callosal labels, mask, CerebNet NIfTI, HypVINN segmentation NIfTI, and HypVINN mask NIfTI;
- segmentation statistics: aseg/DKT, callosal JSON, CerebNet, and HypVINN;
- transforms: two LTA files;
- execution/build/deep-seg timing logs;
- one callosal surface and one legacy surface scalar.

The run does **not** contain `lh`/`rh` white, pial, inflated, or spherical cortical surfaces, cortical annotations, or hemisphere parcel stats. Live FastSurfer verification is therefore limited to segmentation volumes, the callosal surface, stats, logs, and artifact grouping. Cortical surface and annotation behavior must use generated non-participant fixtures and must be reported as fixture-only.

One file under `stats/` is named `aseg.auto.mgz` but is text statistics, not an MGH volume. Directory context takes precedence over extension so it is never passed to a volume parser.

## Format policy

| Family | Formats | Viewer policy |
|---|---|---|
| Volume | `.nii`, `.nii.gz`, `.mgz`, `.mgh` | NIfTI loads directly; MGH/MGZ is parsed with strict bounds and adapted in browser memory only. |
| Surface | FreeSurfer geometry, `.surf.gii` | Render through the shared NiiVue WebGL context. |
| Surface overlay | `.shape.gii`, `.func.gii`, `.label.gii`, `.w` | Requires compatible surface and vertex count. |
| Annotation | `.annot`, `.label`, `.ctab`, LUT | Requires a surface; metadata/download remains available independently. |
| Statistics/table | `.stats`, `.tsv`, `.csv`, `.json`, `.txt` | Safe text/table parser with size limits; no script execution. |
| Transform | `.lta`, `.xfm`, `.mat`, `.h5` | Metadata/download only. Never presented as an image. |
| Report | `.html`, `.svg`, `.png`, `.jpg` | Existing run-scoped sandbox/report protections remain in force. |

## Pairing and compatibility

Filename entities nominate candidate pairs; parsed geometry decides whether the pair may render. Subject/session and space must match. Functional layers must additionally match task and run. FastSurfer segmentation candidates prefer conformed anatomy from the same subject. Shape, affine, voxel size, orientation, and declared coordinate space are compared after load. A mismatch produces a specific warning, keeps the artifacts independently viewable, and never triggers resampling.

## Profiles

- **Structural intensity:** grayscale, finite nonzero robust percentile window, scaled voxel domain, linear interpolation.
- **Functional intensity/time series:** grayscale and stable global series window; frame state is explicit.
- **Binary mask:** zero transparent, a stable overlay color, nearest interpolation, optional contour.
- **Discrete segmentation:** bundled compatible FreeSurfer LUT, label zero transparent, nearest interpolation, no smoothing.
- **Probability:** sequential map, threshold/opacity, and an expected 0-1 range only when metadata supports it.
- **Statistical:** signed diverging map, optional symmetric range and separate sign thresholds.

## Security and performance boundaries

All requests use existing run-scoped file endpoints. The viewer does not accept arbitrary URLs or expose host paths. Existing traversal, encoded traversal, and symlink escape rejection remains authoritative. Parsers validate magic, dimensions, counts, offsets, multiplication overflow, maximum bytes, and exact payload lengths before allocation. Requests are abortable; decoded artifacts are cached once per run URL; stale requests and WebGL resources are disposed when a viewer closes or a run changes. Large 4D files are subject to frame and byte limits and must fail with a useful explanation rather than exhaust browser memory.

## Deferred capabilities

Segmentation editing/painting, registration, implicit resampling, tractography, diffusion tensors, connectomes, CIFTI dense scalar data, advanced morphometry, and graphics beyond the selected NiiVue surface/volume stack are intentionally deferred. Volume-surface correspondence will remain unavailable unless trustworthy scanner-RAS metadata permits it; the UI must not fake this mapping.
