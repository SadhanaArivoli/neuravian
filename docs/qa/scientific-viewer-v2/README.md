# Scientific Viewer v2 QA evidence

Verified against the production Docker frontend on 2026-07-14. No analysis was rerun and no report was regenerated.

## Architecture and historical compatibility

Every NIfTI surface renders through `NeuroImageViewer`; `NiivueViewer` and `NiivuePanel` are modal and inline shells only. `RunResults` supplies artifact and pipeline metadata to that shared component at display time. Consequently, historical artifacts acquire the registry defaults and controls when their existing run page is opened.

Signed maps previously passed through a positive-only continuous-map path. Negative voxels were therefore clipped or mapped without a distinct negative tail. The shared profile now configures paired positive/negative NiiVue LUTs, symmetric robust calibration, signed colorbar limits, and transparent exact zero.

## Historical and recent runs

| Run | Surface | Result |
| --- | --- | --- |
| 59 | ALFF/fALFF | Two historical inline volumes and the modal viewer use the shared controls; inline canvases are 470 x 398 px each. |
| 62 | ReHo | Historical raw ReHo loads with the non-negative continuous profile. |
| 71 | Seed connectivity | Historical Fisher-z map defaults to symmetric blue-red; live controls and export verified. |
| 78 | Statistical Map Explorer | Positive statistical volume defaults to inferno; 3D is disabled without anatomy. |
| 50 | NIfTI Inspector | This historical run contains report metadata but no NIfTI artifact, so there is no viewer to wrap. No artifact was fabricated. |
| 70 | Functional Connectivity | Matrix-only run; no NIfTI artifact or NIfTI viewer. |
| 76 | Group Functional Connectivity | Matrix-only run; no NIfTI artifact or NIfTI viewer. |
| 34 | BrainChop | Structural and binary-mask layers use the shared layer panel. The mask is withheld because its dimensions differ; no resampling occurs. |
| 82 | Recent ReHo | Raw and z-normalized maps both use the same shared viewer; signed z profile verified. |
| 86 | Recent atlas extraction | Label map uses discrete colors and nearest-neighbor interpolation; continuous colormap editing and 3D are disabled. |

Comparison Studio run 59 versus run 83 verifies a legacy client-generated NIfTI difference blob. The shared viewer supplies its missing NIfTI filename hint and renders it with the signed difference profile. These two maps are numerically identical, so the zero difference is correctly transparent.

## Compatibility gate

The layer gate compares dimensions, voxel sizes, affine/orientation, and declared or affine-inferred space. It never guesses an anatomical file and never resamples. Run 34 demonstrates the rejection path: `brain_mask.nii.gz` is withheld because its dimensions differ from `stripped.nii.gz`. No compatible historical statistical-map/anatomy pair exists in the local fixture set, so a statistical overlay was not fabricated for a screenshot.

## Measured layouts and export

| Environment | Visible canvas | Notes |
| --- | --- | --- |
| 1366 x 768, DPR 1 | 790 x 644 | Modal controls remain in the side panel. |
| 1440 x 900, DPR 1 | 790 x 766 | Modal viewer is 1150 x 766; inline dual viewers are 470 x 398 each. |
| 1920 x 1080, DPR 1 | 790 x 931 | Height expands without stretching controls over the image. |
| 2x export | 2880 x 1800 PNG | Separate offscreen WebGL rerender; not a visible-canvas screenshot. |

The 2x output dimensions were reported by the viewer after export. The same rerender path supports 4x and transparent backgrounds.

## Browser checks

- Before/after reference: [`../visualization-controls/before-alff-run-59.jpg`](../visualization-controls/before-alff-run-59.jpg) compared with [`alff-run-59-1440x900.png`](alff-run-59-1440x900.png).
- Colormap selection, robust window, opacity, interpolation, histogram, reset, and keyboard shortcuts were exercised on run 71.
- 2x PNG export completed at 2880 x 1800 px.
- A fresh production-browser session opened run 71 and its viewer with 0 console errors and 0 console warnings.
- Screenshots in this directory cover seed connectivity, ALFF, raw ReHo, ReHo z, difference, structural/mask layering, mask profile, atlas labels, and a statistical map.

## Automated gates

- Frontend Vitest: 16 files, 304 tests passed.
- TypeScript and Vite production build: passed. Existing bundle-size and mixed static/dynamic-import advisories remain warnings.
- Backend pytest: 546 passed and 10 skipped in the sandbox; the three browser-process tests blocked by sandbox IPC were rerun outside the sandbox and all 3 passed (effective 549 passed, 10 skipped).
