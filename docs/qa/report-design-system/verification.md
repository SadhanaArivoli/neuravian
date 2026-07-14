# Report design system verification

Verified against the rebuilt canonical Docker deployment on 2026-07-13 (America/Los_Angeles). These are newly generated artifacts; no pre-migration report was used as evidence.

The previous verification was not sufficient: it treated the shared-theme marker, a body-level color check, and successful report loading as proof. Those checks did not establish semantic-element contrast, curated metadata, or opaque plot backgrounds. This pass checks the actual embedded and standalone documents.

## Per-report result

| Report | Fresh run ID | Heading readable | Table readable | Internal paths absent | Figure background correct | Screenshot |
|---|---:|---|---|---|---|---|
| Statistical Map Explorer | 79 | Pass (16.47:1) | Pass (th 13.19:1; td 14.49:1) | Pass | Pass | [Screenshot](statistical-map-explorer-run-79-embedded.jpg) |
| NIfTI Inspector | 80 | Pass (16.47:1) | Pass (th 13.19:1; td 14.49:1) | Pass | Pass | [Screenshot](nifti-inspector-run-80-embedded.jpg) |
| Connectome Graph | 81 | Pass (16.47:1) | Pass (th 13.19:1; td 14.49:1) | Pass | Pass | [Screenshot](connectome-graph-run-81-embedded.jpg) |
| ReHo | 82 | Pass (16.47:1) | Pass (th 13.19:1; td 14.49:1) | Pass | Pass | [Screenshot](reho-run-82-embedded.jpg) |
| ALFF / fALFF | 83 | Pass (16.47:1) | Pass (th 13.19:1; td 14.49:1) | Pass | Pass | [Screenshot](alff-falff-run-83-embedded.jpg) |
| Group Functional Connectivity | 85 | Pass (16.47:1) | Pass (th 13.19:1; td 14.49:1) | Pass | Pass | [Screenshot](group-functional-connectivity-run-85-embedded.jpg) |
| Atlas ROI Extraction | 86 | Pass (16.47:1) | Pass (th 13.19:1; td 14.49:1) | Pass | Pass (no report PNG) | [Screenshot](atlas-roi-extraction-run-86-embedded.jpg) |
| Functional Connectivity | 87 | Pass (16.47:1) | Pass (th 13.19:1; td 14.49:1) | Pass | Pass | [Screenshot](functional-connectivity-run-87-embedded.jpg) |
| Seed Connectivity | 89 | Pass (16.47:1) | Pass (th 13.19:1; td 14.49:1) | Pass | Pass | [Screenshot](seed-connectivity-run-89-embedded.jpg) |

## Assertions performed

- Embedded and standalone documents use `rgb(9, 13, 24)` as the body background.
- Every present `h1`, `h2`, `h3`, `p`, `th`, `td`, `code`, `pre`, `a`, `caption`, `table`, `figure`, and `figcaption` was inspected using computed styles. Elements absent from a specific report were covered by the shared-shell browser regression test.
- All nine embedded reports had no visible `/app/data/`, `/Users/`, `/root/`, or `/private/` value, no raw implementation metadata key, and no horizontal overflow.
- All nine standalone reports retained the shared-system marker, intentional dark body background, light semantic text, no internal path, and no horizontal overflow.
- Every generated PNG from runs 79, 80, 81, 82, 83, 85, 87, and 89 had 0.000% white border pixels. All Matplotlib images had four `#090d18` corners; the Nilearn seed image had four black corners. Atlas ROI Extraction generates no PNG.
- The Functional Connectivity heatmap uses a dark figure and axes canvas. Its pale matrix cells are intentional data colors from the diverging correlation colormap, not a white figure background.

## Automated gates

- Backend: 558 passed, 1 skipped.
- Frontend: 279 passed.
- TypeScript and production Vite build: passed.
- Docker backend and frontend rebuild: passed; backend healthy.
- Browser QA: all nine embedded and standalone reports passed.
- Browser console: 0 errors; six existing NiiVue `textHeight` deprecation warnings were observed outside the report documents.
- `git diff --check`: passed before commit.
