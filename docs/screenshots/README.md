# Screenshot inventory

Last audited: 2026-07-21

The repository contains product screenshots as well as historical qualification
evidence. Historical images should not automatically be reused on the README,
release page, or social preview.

## Current public candidates

| Surface | Recommended image | Notes |
|---|---|---|
| Hero / desktop workspace | `../desktop/screenshots/desktop-native-app.png` | Best existing overview of the packaged desktop shell. Replace with a clean 1600×900 capture before publishing release assets if the current database content is not suitable for public presentation. |
| Workspace | `unified-multi-workspace/all-workspaces.png` | Use only when explaining local/cloud workspace parity. |
| MRIQC | `../qa/mriqc-execution-qualification/screenshots/participant-run-124-fixed.png` | Current qualified local participant evidence. |
| Viewer | `../qa/scientific-viewer-v2/seed-run-71-1440x900.png` | Current shared scientific viewer controls. |
| Reports | `../qa/report-design-system/functional-connectivity-run-87-embedded.jpg` | Current embedded report design system. |
| Artifacts | `../qa/workstation-polish/before-artifact-explorer.png` | Existing artifact view; replace because the filename and capture predate the final polish terminology. |
| Provenance / methods | `../qa/mriqc-execution-qualification/screenshots/methods-run-131.png` | Current methods evidence based on recorded provenance. |
| Pipelines | `visual-consistency/after-pipelines.jpg` | Current catalog styling; avoid presenting every manifest as qualified. |
| Settings | `../qa/early-access-polish/after-settings.png` | Current Early Access settings language. |

## Replace before a polished public launch

1. Capture one uncluttered 1600×900 hero image from the packaged desktop app.
2. Capture Artifact Explorer after final terminology changes.
3. Capture a dedicated provenance panel; the current methods image demonstrates
   the outcome but not the full input record.
4. Capture the MRIQC report at a viewport where both Neuravian controls and the
   report content are legible.
5. Create a 1280×640 social preview derived from the hero image and project name.

## Historical evidence

Directories named `before-*`, `phase1-*`, `phase2-*`, `restored-shell`, and older
cloud qualification folders document development history. Keep them for audit
traceability, but do not use them as the project's first visual impression.

Screenshots may contain dataset names, run identifiers, paths, hostnames, or
workspace names. Review each image for sensitive information before publishing.
