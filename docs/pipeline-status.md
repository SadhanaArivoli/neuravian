# Canonical pipeline status

Last audited: 2026-07-21

This is the canonical public status table for Neuravian pipeline integrations.
The presence of a manifest or automated test does not by itself establish that a
scientific workflow has completed on every operating system, architecture, or
dataset.

## Status definitions

- **Qualified with limitations** — documented end-to-end execution evidence
  exists for a bounded environment and workflow. Read the limitations before use.
- **Integrated** — execution configuration, parameters, outputs, provenance, and
  application surfaces are implemented. A complete public qualification is not
  claimed.
- **Experimental** — implemented for evaluation, with material environment or
  operational constraints.
- **Planned / not implemented** — no runnable standalone Neuravian pipeline.

No status in this table means clinical approval or scientific validation.

## Registered manifests

| Pipeline | ID | Status | Scope and evidence |
|---|---|---|---|
| MRIQC | `mriqc` | **Qualified with limitations** | Local participant run 124 completed on public BIDS data. Report, IQM JSON, figures, artifacts, provenance, and methods were inspected. Progress parsing was fixed after that run and was not requalified by another full participant execution. |
| MRIQC Group Report | `mriqc-group` | **Qualified with limitations** | Local runs 125 and 131 completed with participant lineage, group outputs, runtime version, methods, and citations. Cloud execution was not qualified. |
| fMRIPrep | `fmriprep` | **Integrated; qualification pending** | Official container and shared BIDS App adapter are integrated. Image metadata, help/version, manifests, preflight, artifact discovery, provenance, cancellation, retry, local/SSH execution contracts, and UI were tested. Scientific execution did not complete on the Apple Silicon qualification host. |
| Import fMRIPrep Derivatives | `import-fmriprep-derivatives` | **Integrated** | Registers existing derivatives for downstream use; no formal public end-to-end qualification package is claimed. |
| BIDS Validator | `bids-validator` | **Integrated** | Container manifest, preflight, reporting, and automated coverage exist. |
| dcm2niix | `dcm2niix` | **Integrated** | Container conversion integration and artifact registration exist. |
| dcm2bids | `dcm2bids` | **Integrated** | Container integration and DICOM Mapping Wizard exist. |
| FSL BET | `fsl-bet` | **Integrated** | Docker-wrapper integration exists; the documented wrapper image must be available. |
| FSL FAST | `fsl-fast` | **Integrated** | Docker-wrapper integration exists; it expects a compatible skull-stripped input. |
| FSL FLIRT | `fsl-flirt` | **Integrated** | Docker-wrapper integration exists; the documented wrapper image must be available. |
| FSL FNIRT | `fsl-fnirt` | **Integrated** | Docker-wrapper integration exists; no broad platform qualification is claimed. |
| FastSurfer | `fastsurfer` | **Integrated** | Execution, license preflight, derivative discovery, surfaces, statistics, reports, and viewer adapters exist; environment-specific execution remains the researcher's responsibility. |
| SynthStrip | `synthstrip` | **Integrated** | Container integration exists; Apple Silicon uses an amd64 image and may be slow. |
| BrainChop | `brainchop` | **Integrated** | Native execution, artifact discovery, and a recorded local benchmark exist; this is not clinical qualification. |
| pydeface | `pydeface` | **Experimental** | Container integration exists but is marked local-unsafe on unsupported architectures. Researchers must verify de-identification before sharing data. |
| NIfTI Inspector | `nifti-inspector` | **Integrated** | Native read-only inspection, report generation, tests, and rendered report evidence exist. |
| Functional Connectivity | `functional-connectivity` | **Integrated** | Native Nilearn integration, artifacts, report, methods, tests, and rendered evidence exist. No inferential claims are made. |
| Seed-Based Connectivity | `seed-based-connectivity` | **Integrated** | Native execution, maps, metadata, report, tests, and viewer evidence exist. |
| ALFF / fALFF Analysis | `alff-falff` | **Integrated** | Native execution, maps, summaries, report, tests, and viewer evidence exist. |
| Regional Homogeneity | `regional-homogeneity` | **Integrated** | Native execution, maps, report, tests, and viewer evidence exist. |
| Group Functional Connectivity | `group-functional-connectivity` | **Integrated** | Descriptive aggregation with compatibility checks, reports, and tests exists; no inferential statistics are performed. |
| Atlas ROI Extraction | `atlas-roi-extraction` | **Integrated** | Native read-only ROI summaries, report, tests, and rendered evidence exist. |
| Connectome Graph Analysis | `connectome-graph-analysis` | **Integrated** | Native graph metrics, reports, and tests exist; interpretation remains the researcher's responsibility. |
| Statistical Map Explorer | `statistical-map-explorer` | **Integrated** | Native thresholding and descriptive cluster labeling are implemented and tested. It does not perform inferential correction. |

## Not implemented as standalone pipelines

| Tool | Status | Clarification |
|---|---|---|
| FreeSurfer `recon-all` | **Planned / not implemented** | Neuravian contains FreeSurfer-compatible surface, annotation, LUT, and statistics viewing used by FastSurfer outputs. It does not currently provide a `recon-all` pipeline. |
| QSIPrep / QSIRecon | **Planned / not implemented** | No registered manifest or execution integration. |
| ANTs | **Planned / not implemented** | ANTs may be used internally by an upstream application such as fMRIPrep; Neuravian does not expose a standalone ANTs pipeline. |
| MRtrix3 | **Planned / not implemented** | No registered manifest or execution integration. |
| AFNI | **Planned / not implemented** | No registered manifest or execution integration. |

## Environment qualification

| Environment | Status |
|---|---|
| Local Docker on the audited Apple Silicon workstation | MRIQC participant and group qualified with the limitations above |
| Linux x86_64 | Automated tests and deployment guidance exist; not every pipeline has an end-to-end qualification |
| Researcher-managed SSH/cloud workspace | Contracts and synchronization are tested; no universal environment qualification is possible |
| Windows / WSL2 | May work, but is not part of the current CI or release qualification matrix |

## Evidence

- [MRIQC execution qualification](qa/mriqc-execution-qualification/REPORT.md)
- [fMRIPrep integration qualification](qa/fmriprep-integration-qualification/REPORT.md)
- [Unified artifact viewing](qa/unified-artifact-viewing/REPORT.md)
- [Scientific viewer evidence](qa/scientific-viewer-v2/README.md)
- [Report design-system verification](qa/report-design-system/verification.md)

When a pipeline gains new qualification evidence, update this file first and link
to the evidence. Do not copy a separate status matrix into another document.
