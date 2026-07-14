# NeuroForge Visualization Controls v1 — verification

## Architecture

- `NeuroImageViewer.tsx` is the only component that initializes NiiVue, loads volumes, applies visualization state, computes histograms, or exports volume renders.
- `NiivuePanel.tsx` and `NiivueViewer.tsx` are thin inline and modal shells around that shared component.
- Run Results, Artifact Explorer, Dataset Metadata, and Comparison Studio keep their existing shell imports, so their stored NIfTI URLs now resolve through the shared controls automatically.
- The only second `new Niivue()` call is inside the same shared component's export path. It creates a separate off-screen 2×/4× WebGL render target; it does not copy or screenshot the visible canvas.

## Why historical runs required no regeneration

Run records and reports were not modified. Historical pages already pass stored `/api/runs/{id}/files/{path}` NIfTI URLs to the frontend viewer. Replacing the viewer implementation changes how those unchanged URLs are rendered when the page opens. No report HTML, NIfTI, matrix, analysis result, or database record was regenerated.

## Browser QA

| Run | Age | Result |
| --- | --- | --- |
| ALFF/fALFF #59 | historical | Two inline viewers expose the shared panel. Verified Viridis, 55% opacity, robust 2–98% window, live histogram, nearest-neighbor toggle, reset, and 4× PNG completion. |
| ReHo #62 | historical | Inline ReHo viewer exposes the shared panel. |
| Seed connectivity #71 | historical | Generic volume `View` opens the shared modal; signed filename inference selects Blue-red by default. |
| Statistical map #78 | historical | Thresholded NIfTI opens the shared modal with Blue-red signed-map default. |
| Functional connectivity #45 | historical | Audited: this run contains matrix/report artifacts and no NIfTI volume artifact, so no NIfTI viewer is present. |
| Group FC #67 | historical | Audited: this run contains group matrix/report artifacts and no NIfTI volume artifact, so no NIfTI viewer is present. |
| NIfTI Inspector #50 | historical | Audited: inspector outputs are JSON, PNG histogram, and HTML report; the inspected source volume is not copied into the run outputs, so there is no result NIfTI viewer to wrap. |
| ALFF/fALFF #83 | recent | Both newly generated inline volume viewers expose the same shared panel. |
| Seed connectivity #89 | recent | Newly generated NIfTI opens the same shared modal. |
| NIfTI Inspector #80 | recent | Confirmed the same report-only output contract as historical inspector runs. |

No analyses or reports were rerun for this QA. Browser console errors: 0.

## Automated gates

- Backend: 558 passed, 1 skipped.
- Frontend: 280 passed.
- Shared viewer tests: 8 passed, including semantic defaults, live controls, shortcuts, label interpolation, and 4× off-screen export with no visible-canvas `toDataURL` call.
- TypeScript + production build: passed through `npm run build`.
- Production Docker frontend build and health startup: passed.

## Screenshots

- `before-alff-run-59.jpg` — historical ALFF run before the shared controls.
- `after-alff-run-59-controls.jpg` — the same historical run after deployment, with robust windowing, Viridis, and 55% opacity active.
