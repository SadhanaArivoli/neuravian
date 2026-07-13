# Changelog

All notable changes are documented here. NeuroForge follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-alpha] — 2024

Initial public release.

### Pipelines (20 total)

**Conversion**
- dcm2niix — DICOM to NIfTI conversion
- dcm2bids + DICOM Wizard — guided DICOM to BIDS with series scouting and entity mapping

**Validation and QC**
- BIDS Validator — BIDS structure and metadata validation
- MRIQC — per-subject image quality metrics (T1w, T2w, BOLD)
- MRIQC Group — aggregate IQM table across subjects
- NIfTI Inspector — header metadata, voxel statistics, intensity histogram, and warning summary

**Skull stripping**
- BrainChop — CNN-based skull stripping (MindGrab)
- SynthStrip — any-contrast skull stripping (FreeSurfer team)

**Segmentation**
- FastSurfer — deep-learning cortical segmentation and surface reconstruction

**Preprocessing**
- fMRIPrep — robust fMRI preprocessing (`local-unsafe` on Apple Silicon; use Import instead)
- Import fMRIPrep Derivatives — register precomputed derivatives without re-running

**Functional connectivity**
- Functional Connectivity — atlas-based Pearson correlation matrix (Nilearn)
- Seed-Based Connectivity — voxelwise seed connectivity z-map
- ALFF / fALFF — voxelwise amplitude and fractional amplitude of low-frequency fluctuations
- Regional Homogeneity (ReHo) — voxelwise Kendall's Coefficient of Concordance
- Group Functional Connectivity — across-run mean connectivity matrix
- Atlas ROI Extraction — per-ROI voxel statistics from any NIfTI
- Connectome Graph Analysis — graph-theoretic metrics (NetworkX + Louvain)
- Statistical Map Explorer — thresholding, cluster labelling, and cluster reporting

**De-identification**
- pydeface — facial feature removal from structural NIfTI

### Platform features

- Manifest-driven pipeline registry (YAML, no hardcoded pipeline logic)
- Artifact-typed run chaining with automatic Run Next compatibility
- Execution queue (sequential, cancel, retry, re-run, duplicate)
- Stalled-run detection and recovery
- Analysis Graph (directed run and artifact lineage graph)
- Artifact Explorer (typed previews: NIfTI viewer, matrix heatmap, HTML embed, CSV table)
- Comparison Studio (skull-strip Dice, matrix Frobenius norm and difference heatmap)
- Workflow Builder and Library (save, load, export, import)
- Workflow Templates (BIDS+QC, fMRI Preprocessing, Functional Connectivity, Skull Strip+Segment, Seed FC → Statistical Map, ALFF/fALFF, Regional Homogeneity)
- Methods Studio (draft methods paragraph from provenance)
- Citation Studio (reference list from pipeline registry)
- Study Report Studio (full dataset report; PDF export; multi-report comparison)
- Project Studio with lab notebook
- Per-run provenance records (tool, version, command, parameters, container digest, timestamps)
- Run lineage via `source_run_id`
- SQLite local database with Alembic migrations
- Docker Compose deployment (nginx + FastAPI)
- GitHub Actions CI (backend pytest + frontend Vitest + TypeScript)

[0.1.0-alpha]: https://github.com/SadhanaArivoli/neuroforge/releases/tag/v0.1.0-alpha
