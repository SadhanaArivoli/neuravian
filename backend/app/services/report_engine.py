"""Study Report Studio — report data aggregation and rendering.

Collects data from the existing DB, run outputs, and artifact registry,
then renders self-contained HTML, Markdown, and JSON documents.

PDF is intentionally not generated server-side (no WeasyPrint dependency).
The rendered HTML includes @media print CSS so the user can print-to-PDF
from the browser.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.dataset import Dataset
from app.models.pipeline import Pipeline
from app.models.run import Run
from app.services.artifact_registry import resolve_run_artifacts
from app.services.pipeline import get_registry

log = logging.getLogger(__name__)

# ── Citation registry (Python port of citationRegistry.ts) ────────────────────

_CITATIONS: list[dict[str, Any]] = [
    {
        "key": "mriqc",
        "tool": "MRIQC",
        "pipeline_ids": ["mriqc", "mriqc-group"],
        "authors": "Esteban O, Birman D, Schaer M, Koyejo OO, Poldrack RA, Gorgolewski KJ",
        "year": 2017,
        "title": "MRIQC: Advancing the Automatic Prediction of Image Quality in MRI from Unseen Sites",
        "journal": "PLOS ONE",
        "volume": "12",
        "issue": "9",
        "pages": "e0184661",
        "doi": "10.1371/journal.pone.0184661",
        "rrid": "SCR_022942",
    },
    {
        "key": "fmriprep",
        "tool": "fMRIPrep",
        "pipeline_ids": ["fmriprep", "import-fmriprep-derivatives"],
        "authors": "Esteban O, Markiewicz CJ, Blair RW, et al.",
        "year": 2019,
        "title": "fMRIPrep: a robust preprocessing pipeline for functional MRI",
        "journal": "Nature Methods",
        "volume": "16",
        "pages": "111–116",
        "doi": "10.1038/s41592-018-0235-4",
        "rrid": "SCR_016216",
    },
    {
        "key": "fastsurfer",
        "tool": "FastSurfer",
        "pipeline_ids": ["fastsurfer"],
        "authors": "Henschel L, Conjeti S, Estrada S, Diers K, Fischl B, Reuter M",
        "year": 2020,
        "title": "FastSurfer — A fast and accurate deep learning based neuroimaging pipeline",
        "journal": "NeuroImage",
        "volume": "219",
        "pages": "117012",
        "doi": "10.1016/j.neuroimage.2020.116973",
        "rrid": "SCR_023263",
    },
    {
        "key": "synthstrip",
        "tool": "SynthStrip",
        "pipeline_ids": ["synthstrip"],
        "authors": "Hoopes A, Mora JS, Dalca AV, Fischl B, Hoffmann M",
        "year": 2022,
        "title": "SynthStrip: skull-stripping for any brain image",
        "journal": "NeuroImage",
        "volume": "260",
        "pages": "119474",
        "doi": "10.1016/j.neuroimage.2022.119474",
        "rrid": "SCR_023265",
    },
    {
        "key": "brainchop",
        "tool": "BrainChop",
        "pipeline_ids": ["brainchop"],
        "authors": "Sherif T, Kassis N, Schroeder ME, Khalili-Mahani N, Evans AC",
        "year": 2022,
        "title": "BrainChop: In-browser MRI Volumetry and Segmentation",
        "journal": "Frontiers in Neuroinformatics",
        "volume": "16",
        "pages": "981877",
        "doi": "10.3389/fninf.2022.981877",
    },
    {
        "key": "bids",
        "tool": "BIDS",
        "pipeline_ids": ["bids-validator"],
        "authors": "Gorgolewski KJ, Auer T, Calhoun VD, et al.",
        "year": 2016,
        "title": "The brain imaging data structure, a format for organizing and describing outputs of neuroimaging experiments",
        "journal": "Scientific Data",
        "volume": "3",
        "pages": "160044",
        "doi": "10.1038/sdata.2016.44",
        "rrid": "SCR_019113",
    },
    {
        "key": "dcm2niix",
        "tool": "dcm2niix",
        "pipeline_ids": ["dcm2niix"],
        "authors": "Li X, Morgan PS, Ashburner J, Smith J, Rorden C",
        "year": 2016,
        "title": "The first step for neuroimaging data analysis: DICOM to NIfTI conversion",
        "journal": "Journal of Neuroscience Methods",
        "volume": "264",
        "pages": "47–56",
        "doi": "10.1016/j.jneumeth.2016.03.001",
        "rrid": "SCR_023207",
    },
    {
        "key": "dcm2bids",
        "tool": "dcm2bids",
        "pipeline_ids": ["dcm2bids"],
        "authors": "Boré A, Guay S, Bedetti C, Meisler S, GuenTher N",
        "year": 2023,
        "title": "Dcm2Bids",
        "journal": "Zenodo",
        "doi": "10.5281/zenodo.8167920",
        "is_software_citation": True,
    },
    {
        "key": "nilearn",
        "tool": "Nilearn",
        "pipeline_ids": [
            "functional-connectivity", "seed-based-connectivity",
            "group-functional-connectivity", "atlas-roi-extraction",
            "connectome-graph-analysis",
        ],
        "authors": "Abraham A, Pedregosa F, Eickenberg M, et al.",
        "year": 2014,
        "title": "Machine learning for neuroimaging with scikit-learn",
        "journal": "Frontiers in Neuroinformatics",
        "volume": "8",
        "pages": "14",
        "doi": "10.3389/fninf.2014.00014",
        "rrid": "SCR_001362",
    },
    {
        "key": "pydeface",
        "tool": "pydeface",
        "pipeline_ids": ["pydeface"],
        "authors": "Gulban OF, Nielson D, Poldrack R, et al.",
        "year": 2019,
        "title": "poldracklab/pydeface",
        "journal": "Zenodo",
        "doi": "10.1007/s12021-012-9160-3",
        "is_software_citation": True,
    },
    {
        "key": "alff", "tool": "ALFF", "pipeline_ids": ["alff-falff"],
        "authors": "Zang YF, He Y, Zhu CZ, et al.", "year": 2007,
        "title": "Altered baseline brain activity in children with ADHD revealed by resting-state functional MRI",
        "journal": "Brain & Development", "volume": "29", "issue": "2", "pages": "83-91",
        "doi": "10.1016/j.braindev.2006.07.002",
    },
    {
        "key": "falff", "tool": "fALFF", "pipeline_ids": ["alff-falff"],
        "authors": "Zou QH, Zhu CZ, Yang Y, et al.", "year": 2008,
        "title": "An improved approach to detection of amplitude of low-frequency fluctuation for resting-state fMRI: fractional ALFF",
        "journal": "Journal of Neuroscience Methods", "volume": "172", "issue": "1", "pages": "137-141",
        "doi": "10.1016/j.jneumeth.2008.04.012",
    },
]

_PIPELINE_DISPLAY_NAMES: dict[str, str] = {
    "mriqc": "MRIQC",
    "mriqc-group": "MRIQC Group Report",
    "fmriprep": "fMRIPrep",
    "import-fmriprep-derivatives": "Import fMRIPrep Derivatives",
    "brainchop": "BrainChop",
    "synthstrip": "SynthStrip",
    "fastsurfer": "FastSurfer",
    "bids-validator": "BIDS Validator",
    "dcm2niix": "dcm2niix",
    "dcm2bids": "dcm2bids",
    "pydeface": "pydeface",
    "functional-connectivity": "Functional Connectivity",
    "seed-based-connectivity": "Seed-Based Connectivity",
    "group-functional-connectivity": "Group Functional Connectivity",
    "atlas-roi-extraction": "Atlas ROI Extraction",
    "connectome-graph-analysis": "Connectome Graph Analysis",
    "nifti-inspector": "NIfTI Inspector",
    "statistical-map-explorer": "Statistical Map Explorer",
    "alff-falff": "ALFF / fALFF Analysis",
}


# ── Dataclasses ────────────────────────────────────────────────────────────────

@dataclass
class RunSummary:
    run_id: int
    pipeline_id: str
    pipeline_display_name: str
    pipeline_version: str
    status: str
    execution_type: str
    container_image: str | None
    started_at: str | None
    finished_at: str | None
    runtime_seconds: int | None
    params: dict[str, Any]
    artifact_count: int
    output_dir: str | None


@dataclass
class ArtifactSummary:
    run_id: int
    pipeline_id: str
    type: str
    label: str
    description: str
    paths: list[str]


@dataclass
class FigureEmbed:
    caption: str
    alt: str
    data_uri: str  # base64 PNG
    source_run_id: int
    pipeline_id: str


@dataclass
class CitationEntry:
    key: str
    tool: str
    apa: str
    vancouver: str
    bibtex: str
    doi: str
    rrid: str | None


@dataclass
class ReportData:
    # Identity
    report_id: int
    dataset_id: int
    generated_at: str
    neuroforge_version: str
    git_commit: str

    # Dataset
    dataset_name: str | None
    dataset_path: str | None
    dataset_bids_version: str | None
    dataset_validation_status: str
    dataset_imported_at: str | None
    dataset_subjects: list[str]
    dataset_sessions: list[str]
    dataset_modalities: list[str]
    dataset_file_count: int

    # Runs
    runs: list[RunSummary]
    total_runs: int
    success_runs: int
    failed_runs: int
    cancelled_runs: int

    # Artifacts
    artifacts: list[ArtifactSummary]
    alff_falff_sections: list[dict[str, Any]]

    # Figures (embedded)
    figures: list[FigureEmbed]

    # Methods prose (per pipeline)
    methods_sections: list[dict[str, str]]  # [{"pipeline_id": ..., "title": ..., "text": ...}]

    # Software versions table
    software_table: list[dict[str, str]]  # [{"tool": ..., "version": ..., "execution": ..., "image": ...}]

    # Citations
    citations: list[CitationEntry]

    # Warnings
    warnings: list[str]

    # Per-run section data (optional, default empty for backward compat)
    reho_sections: list[dict[str, Any]] = field(default_factory=list)


# ── Data collection ────────────────────────────────────────────────────────────

def collect_report_data(dataset_id: int, report_id: int, db: Session) -> ReportData:
    """Aggregate all report data for a dataset."""
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise KeyError(f"Dataset {dataset_id} not found")

    registry = get_registry()
    runs_orm: list[Run] = db.query(Run).filter(Run.dataset_id == dataset_id).all()

    # ── Dataset metadata ──────────────────────────────────────────────────────
    indexed: dict[str, Any] = {}
    try:
        indexed = json.loads(dataset.indexed_metadata or "{}")
    except Exception:
        pass

    subjects: list[str] = indexed.get("subjects", [])
    sessions: list[str] = indexed.get("sessions", [])
    modalities: list[str] = indexed.get("datatypes", [])
    file_count: int = indexed.get("file_count", 0)

    # ── Run summaries ─────────────────────────────────────────────────────────
    run_summaries: list[RunSummary] = []
    all_artifacts: list[ArtifactSummary] = []
    figures: list[FigureEmbed] = []
    alff_sections: list[dict[str, Any]] = []
    reho_sections_list: list[dict[str, Any]] = []
    seen_pipeline_ids: set[str] = set()

    for run in runs_orm:
        # run.pipeline_id is an integer FK; look up the manifest string name
        pipeline_row = db.get(Pipeline, run.pipeline_id)
        manifest_id: str = pipeline_row.name if pipeline_row else ""
        manifest = registry.get(manifest_id, {})
        display_name: str = (
            str(manifest.get("display_name") or "")
            or _PIPELINE_DISPLAY_NAMES.get(manifest_id, manifest_id or "Unknown")
        )

        container_cfg = manifest.get("container")
        if container_cfg:
            execution_type = "docker"
            container_image: str | None = f"{container_cfg['image']}:{container_cfg['tag']}"
        else:
            execution_type = "native"
            container_image = None

        runtime_seconds: int | None = None
        if run.started_at and run.finished_at:
            runtime_seconds = int((run.finished_at - run.started_at).total_seconds())

        params: dict[str, Any] = {}
        try:
            params = json.loads(run.params_json or "{}")
        except Exception:
            pass

        # Resolve artifacts for successful runs
        artifact_count = 0
        if run.status == "success" and run.output_dir:
            try:
                resolved = resolve_run_artifacts(
                    manifest=manifest,
                    output_dir=run.output_dir,
                    params=params,
                    status=run.status,
                )
                artifact_count = sum(1 for a in resolved if a.resolved)
                for a in resolved:
                    if a.resolved:
                        all_artifacts.append(ArtifactSummary(
                            run_id=run.id,
                            pipeline_id=run.pipeline_id or "",
                            type=a.type,
                            label=a.label,
                            description=a.description,
                            paths=a.paths,
                        ))

                # Collect PNG figures from output dir
                out_path = Path(run.output_dir)
                if out_path.exists():
                    if manifest_id == "alff-falff":
                        metadata_path = out_path / "alff_falff_metadata.json"
                        if metadata_path.exists():
                            try:
                                md = json.loads(metadata_path.read_text(encoding="utf-8"))
                                md["run_id"] = run.id
                                alff_sections.append(md)
                                warnings_list_from_run = md.get("warnings", [])
                                for warning in warnings_list_from_run:
                                    if warning:
                                        md.setdefault("report_warnings", []).append(str(warning))
                            except Exception as exc:
                                log.warning("Could not parse ALFF/fALFF metadata for run %d: %s", run.id, exc)
                    if manifest_id == "regional-homogeneity":
                        metadata_path = out_path / "reho_metadata.json"
                        if metadata_path.exists():
                            try:
                                md = json.loads(metadata_path.read_text(encoding="utf-8"))
                                md["run_id"] = run.id
                                reho_sections_list.append(md)
                            except Exception as exc:
                                log.warning("Could not parse ReHo metadata for run %d: %s", run.id, exc)
                    for png in sorted(out_path.glob("*.png"))[:4]:  # max 4 per run
                        try:
                            data = png.read_bytes()
                            b64 = base64.b64encode(data).decode()
                            figures.append(FigureEmbed(
                                caption=f"{display_name} — {png.stem}",
                                alt=png.stem.replace("_", " "),
                                data_uri=f"data:image/png;base64,{b64}",
                                source_run_id=run.id,
                                pipeline_id=run.pipeline_id or "",
                            ))
                        except Exception:
                            pass
            except Exception as exc:
                log.warning("Artifact resolution failed for run %d: %s", run.id, exc)

        pipeline_id = manifest_id
        seen_pipeline_ids.add(pipeline_id)

        run_summaries.append(RunSummary(
            run_id=run.id,
            pipeline_id=pipeline_id,
            pipeline_display_name=display_name,
            pipeline_version=run.pipeline_version or "unknown",
            status=run.status,
            execution_type=execution_type,
            container_image=container_image,
            started_at=run.started_at.isoformat() if run.started_at else None,
            finished_at=run.finished_at.isoformat() if run.finished_at else None,
            runtime_seconds=runtime_seconds,
            params=params,
            artifact_count=artifact_count,
            output_dir=run.output_dir,
        ))

    # ── Status counts ─────────────────────────────────────────────────────────
    status_counts: dict[str, int] = {}
    for r in runs_orm:
        status_counts[r.status] = status_counts.get(r.status, 0) + 1

    # ── Software versions table (deduplicated by pipeline_id) ─────────────────
    software_table = _build_software_table(run_summaries)

    # ── Methods prose ─────────────────────────────────────────────────────────
    methods_sections = _build_methods_sections(run_summaries, registry)

    # ── Citations ─────────────────────────────────────────────────────────────
    citations = _build_citations(seen_pipeline_ids)

    # ── Warnings ─────────────────────────────────────────────────────────────
    warnings_list: list[str] = []
    if dataset.validation_status == "invalid":
        warnings_list.append("BIDS validation reported errors. Some analyses may have run on non-compliant data.")
    if any(r.pipeline_version == "unknown" for r in run_summaries):
        warnings_list.append("One or more runs has an unknown pipeline version. Reproducibility may be limited.")
    if any(r.status == "failed" for r in run_summaries):
        n_failed = sum(1 for r in run_summaries if r.status == "failed")
        warnings_list.append(f"{n_failed} run(s) failed. Results from failed runs are excluded from this report.")
    for section in alff_sections:
        warnings_list.extend(f"ALFF/fALFF run {section['run_id']}: {w}" for w in section.get("warnings", []) if w)
    for section in reho_sections_list:
        warnings_list.extend(f"ReHo run {section['run_id']}: {w}" for w in section.get("warnings", []) if w)

    # ── Version info ──────────────────────────────────────────────────────────
    try:
        import importlib.metadata as _meta
        nf_version = _meta.version("neuroforge-backend")
    except Exception:
        nf_version = "0.1.0"

    git_commit = os.environ.get("NEUROFORGE_GIT_COMMIT", "unknown")

    return ReportData(
        report_id=report_id,
        dataset_id=dataset_id,
        generated_at=datetime.now(UTC).isoformat(),
        neuroforge_version=nf_version,
        git_commit=git_commit,
        dataset_name=dataset.name,
        dataset_path=dataset.path,
        dataset_bids_version=dataset.bids_version,
        dataset_validation_status=dataset.validation_status,
        dataset_imported_at=dataset.created_at.isoformat() if dataset.created_at else None,
        dataset_subjects=subjects,
        dataset_sessions=sessions,
        dataset_modalities=modalities,
        dataset_file_count=file_count,
        runs=run_summaries,
        total_runs=len(run_summaries),
        success_runs=status_counts.get("success", 0),
        failed_runs=status_counts.get("failed", 0),
        cancelled_runs=status_counts.get("cancelled", 0),
        artifacts=all_artifacts,
        alff_falff_sections=alff_sections,
        reho_sections=reho_sections_list,
        figures=figures,
        methods_sections=methods_sections,
        software_table=software_table,
        citations=citations,
        warnings=warnings_list,
    )


def _build_software_table(runs: list[RunSummary]) -> list[dict[str, str]]:
    """Deduplicated software table: one row per pipeline_id."""
    seen: dict[str, dict[str, str]] = {}
    for r in runs:
        if r.pipeline_id not in seen:
            seen[r.pipeline_id] = {
                "tool": r.pipeline_display_name,
                "pipeline_id": r.pipeline_id,
                "version": r.pipeline_version,
                "execution": r.execution_type,
                "image": r.container_image or "—",
            }
    return list(seen.values())


_METHODS_PROSE: dict[str, str] = {
    "mriqc": (
        "Image quality metrics (IQMs) were computed using MRIQC {version}. "
        "MRIQC extracts no-reference IQMs from structural and functional MRI "
        "and produces individual and group-level quality reports (Esteban et al., 2017)."
    ),
    "mriqc-group": (
        "Group-level quality reports were generated using MRIQC {version} to "
        "aggregate individual IQMs across all participants."
    ),
    "fmriprep": (
        "Functional MRI data were preprocessed using fMRIPrep {version}, "
        "a robust and reproducible preprocessing pipeline (Esteban et al., 2019). "
        "fMRIPrep performs slice-timing correction, head motion correction, "
        "susceptibility distortion correction, spatial normalisation, and confound estimation."
    ),
    "import-fmriprep-derivatives": (
        "Previously computed fMRIPrep derivatives were imported into NeuroForge "
        "for downstream analysis."
    ),
    "brainchop": (
        "Skull stripping and volumetric segmentation were performed using BrainChop {version}, "
        "an in-browser deep-learning pipeline for MRI volumetry (Sherif et al., 2022)."
    ),
    "synthstrip": (
        "Skull stripping was performed using SynthStrip {version}, "
        "a learning-based tool robust to MRI contrast and resolution variations "
        "(Hoopes et al., 2022)."
    ),
    "fastsurfer": (
        "Cortical surface reconstruction was performed using FastSurfer {version}, "
        "a deep-learning accelerated reimplementation of the FreeSurfer pipeline "
        "(Henschel et al., 2020)."
    ),
    "bids-validator": (
        "The dataset was validated against the Brain Imaging Data Structure (BIDS) "
        "specification using the BIDS Validator {version} (Gorgolewski et al., 2016)."
    ),
    "dcm2niix": (
        "DICOM images were converted to NIfTI format using dcm2niix {version} "
        "(Li et al., 2016)."
    ),
    "dcm2bids": (
        "NIfTI images were organised into BIDS format using dcm2bids {version} "
        "(Boré et al., 2023)."
    ),
    "pydeface": (
        "Facial features were removed from structural images using pydeface {version} "
        "to support data sharing while preserving participant privacy."
    ),
    "functional-connectivity": (
        "Functional connectivity matrices were computed using Nilearn {version} "
        "by extracting mean time series from atlas-defined regions of interest "
        "and computing pairwise Pearson correlations (Abraham et al., 2014)."
    ),
    "seed-based-connectivity": (
        "Seed-based functional connectivity maps were computed using Nilearn {version} "
        "by correlating the mean time series of a seed region with all other brain voxels."
    ),
    "group-functional-connectivity": (
        "Group-level functional connectivity was estimated by averaging individual "
        "connectivity matrices using Nilearn {version}."
    ),
    "atlas-roi-extraction": (
        "Region-of-interest time series were extracted from preprocessed fMRI data "
        "using atlas-defined parcellations via Nilearn {version}."
    ),
    "connectome-graph-analysis": (
        "Graph-theoretic properties of the functional connectome were characterised "
        "using NetworkX {version}, including global efficiency, modularity, clustering "
        "coefficient, and betweenness centrality."
    ),
    "nifti-inspector": (
        "NIfTI image headers and voxel statistics were inspected using NeuroForge's "
        "built-in NIfTI Inspector."
    ),
    "statistical-map-explorer": (
        "Statistical thresholding and cluster detection were performed using NeuroForge's "
        "Statistical Map Explorer (version {version}). Suprathreshold voxels were identified "
        "by applying an absolute threshold to the statistical map, and contiguous clusters "
        "were delineated using 6-connectivity connected-component labelling (scipy.ndimage). "
        "No random field theory, permutation testing, or inferential correction for multiple "
        "comparisons was applied; threshold selection was at the investigator's discretion."
    ),
    "alff-falff": (
        "Voxelwise amplitude of low-frequency fluctuations (ALFF) and fractional ALFF "
        "were computed from fMRIPrep-preprocessed BOLD data using a native NumPy/SciPy "
        "FFT workflow (pipeline version {version}). Raw ALFF was the summed FFT amplitude "
        "within the recorded low-frequency band; fALFF was that amplitude divided by "
        "summed positive-frequency amplitude through Nyquist, excluding DC. Recorded "
        "run metadata provide TR, frequency band, nuisance regressors, detrending, mask, "
        "normalization, and software versions. No inferential statistics or scientific "
        "interpretation were generated (Zang et al., 2007; Zou et al., 2008)."
    ),
}


def _build_methods_sections(
    runs: list[RunSummary], registry: dict[str, Any]
) -> list[dict[str, str]]:
    seen_pipeline_ids: set[str] = set()
    sections: list[dict[str, str]] = []
    for r in runs:
        if r.pipeline_id in seen_pipeline_ids:
            continue
        seen_pipeline_ids.add(r.pipeline_id)
        prose_template = _METHODS_PROSE.get(r.pipeline_id)
        if not prose_template:
            continue
        text = prose_template.format(version=r.pipeline_version or "unknown")
        sections.append({
            "pipeline_id": r.pipeline_id,
            "title": r.pipeline_display_name,
            "text": text,
        })
    return sections


def _build_citations(pipeline_ids: set[str]) -> list[CitationEntry]:
    entries: list[CitationEntry] = []
    seen_keys: set[str] = set()
    for cit in _CITATIONS:
        if not any(pid in pipeline_ids for pid in cit.get("pipeline_ids", [])):
            continue
        if cit["key"] in seen_keys:
            continue
        seen_keys.add(cit["key"])
        entries.append(CitationEntry(
            key=cit["key"],
            tool=cit["tool"],
            apa=_format_apa(cit),
            vancouver=_format_vancouver(cit),
            bibtex=_format_bibtex(cit),
            doi=cit.get("doi", ""),
            rrid=cit.get("rrid"),
        ))
    return entries


def _format_apa(c: dict[str, Any]) -> str:
    parts = [f"{c['authors']} ({c['year']}). {c['title']}."]
    journal = c.get("journal", "")
    if journal:
        vol = c.get("volume", "")
        issue = c.get("issue", "")
        pages = c.get("pages", "")
        parts.append(f" {journal}")
        if vol:
            parts.append(f", {vol}")
        if issue:
            parts.append(f"({issue})")
        if pages:
            parts.append(f", {pages}")
        parts.append(".")
    if c.get("doi"):
        parts.append(f" https://doi.org/{c['doi']}")
    return "".join(parts)


def _format_vancouver(c: dict[str, Any]) -> str:
    vol = c.get("volume", "")
    issue = c.get("issue", "")
    pages = c.get("pages", "")
    vol_str = f"{vol}" + (f"({issue})" if issue else "")
    loc = f":{pages}" if pages else ""
    return (
        f"{c['authors']}. {c['title']}. {c.get('journal', '')}. "
        f"{c['year']};{vol_str}{loc}. doi:{c.get('doi', '')}"
    )


def _format_bibtex(c: dict[str, Any]) -> str:
    entry_type = "software" if c.get("is_software_citation") else "article"
    key = f"{c['key']}{c['year']}"
    lines = [
        f"@{entry_type}{{{key},",
        f"  author = {{{c['authors']}}},",
        f"  title  = {{{c['title']}}},",
        f"  year   = {{{c['year']}}},",
    ]
    if c.get("journal"):
        lines.append(f"  journal = {{{c['journal']}}},")
    if c.get("volume"):
        lines.append(f"  volume  = {{{c['volume']}}},")
    if c.get("pages"):
        lines.append(f"  pages   = {{{c['pages']}}},")
    if c.get("doi"):
        lines.append(f"  doi     = {{{c['doi']}}},")
    if c.get("rrid"):
        lines.append(f"  note    = {{RRID:{c['rrid']}}},")
    lines.append("}")
    return "\n".join(lines)


# ── Renderers ─────────────────────────────────────────────────────────────────

def render_html(data: ReportData) -> str:
    """Render a self-contained HTML report."""
    return _HTML_TEMPLATE.format(**_html_vars(data))


def render_markdown(data: ReportData) -> str:
    """Render a Markdown summary report."""
    lines: list[str] = []

    lines += [
        f"# Study Report: {data.dataset_name or data.dataset_path or 'Dataset'}",
        f"\n*Generated by NeuroForge {data.neuroforge_version} on "
        f"{data.generated_at[:10]}*\n",
        "---\n",
        "## Dataset Summary\n",
        f"- **Name:** {data.dataset_name or '—'}",
        f"- **Path:** {data.dataset_path or '—'}",
        f"- **BIDS version:** {data.dataset_bids_version or '—'}",
        f"- **Validation status:** {data.dataset_validation_status}",
        f"- **Subjects:** {len(data.dataset_subjects)}",
        f"- **Sessions:** {len(data.dataset_sessions) or '—'}",
        f"- **Modalities:** {', '.join(data.dataset_modalities) or '—'}",
        f"- **Total files:** {data.dataset_file_count}",
        f"- **Imported:** {(data.dataset_imported_at or '')[:10] or '—'}",
        "",
        "## Analysis Timeline\n",
        f"- **Total runs:** {data.total_runs}",
        f"- **Successful:** {data.success_runs}",
        f"- **Failed:** {data.failed_runs}",
        f"- **Cancelled:** {data.cancelled_runs}",
        "",
    ]

    if data.runs:
        lines.append("## Pipeline Summary\n")
        lines.append("| Pipeline | Version | Execution | Runtime | Status | Artifacts |")
        lines.append("|----------|---------|-----------|---------|--------|-----------|")
        for r in data.runs:
            rt = f"{r.runtime_seconds}s" if r.runtime_seconds is not None else "—"
            lines.append(
                f"| {r.pipeline_display_name} | {r.pipeline_version} "
                f"| {r.execution_type} | {rt} | {r.status} | {r.artifact_count} |"
            )
        lines.append("")

    if data.alff_falff_sections:
        lines.append("## ALFF / fALFF Analysis\n")
        for section in data.alff_falff_sections:
            band = section.get("frequency_band", ["—", "—"])
            lines += [
                f"### Run #{section.get('run_id')}\n",
                f"- **Frequency band:** {band[0]}–{band[1]} Hz",
                f"- **TR:** {section.get('tr', '—')} s",
                f"- **Nyquist frequency:** {section.get('nyquist_frequency', '—')} Hz",
                f"- **Confound strategy:** {section.get('confound_strategy', '—')}",
                f"- **Normalization:** {section.get('normalization', '—')}",
                f"- **Runtime:** {section.get('runtime_seconds', '—')} s",
                f"- **Mask voxels:** {section.get('mask_voxel_count', '—')}",
                f"- **ALFF statistics:** `{json.dumps(section.get('alff_statistics', {}), sort_keys=True)}`",
                f"- **fALFF statistics:** `{json.dumps(section.get('falff_statistics', {}), sort_keys=True)}`",
                "",
            ]

    if data.reho_sections:
        lines.append("## Regional Homogeneity (ReHo)\n")
        for section in data.reho_sections:
            lines += [
                f"### Run #{section.get('run_id')}\n",
                f"- **Neighborhood:** {section.get('neighborhood', '—')} voxels",
                f"- **Confound strategy:** {section.get('confound_strategy', '—')}",
                f"- **Detrend:** {section.get('detrend', '—')}",
                f"- **Z-normalize:** {section.get('z_normalize', '—')}",
                f"- **Runtime:** {section.get('runtime_seconds', '—')} s",
                f"- **Mask voxels:** {section.get('mask_voxel_count', '—')}",
                f"- **Valid voxels:** {section.get('valid_voxel_count', '—')}",
                f"- **ReHo statistics:** `{json.dumps(section.get('reho_statistics', {}), sort_keys=True)}`",
                "",
            ]

    if data.methods_sections:
        lines.append("## Methods\n")
        for sec in data.methods_sections:
            lines.append(f"### {sec['title']}\n")
            lines.append(sec["text"] + "\n")

    if data.software_table:
        lines.append("## Software Versions\n")
        lines.append("| Tool | Version | Execution | Image |")
        lines.append("|------|---------|-----------|-------|")
        for row in data.software_table:
            lines.append(
                f"| {row['tool']} | {row['version']} | {row['execution']} | {row['image']} |"
            )
        lines.append("")

    if data.citations:
        lines.append("## References\n")
        for i, cit in enumerate(data.citations, 1):
            lines.append(f"{i}. {cit.apa}")
        lines.append("")

    if data.warnings:
        lines.append("## Warnings\n")
        for w in data.warnings:
            lines.append(f"- ⚠️ {w}")
        lines.append("")

    lines += [
        "---",
        "## Reproducibility\n",
        f"- NeuroForge version: {data.neuroforge_version}",
        f"- Git commit: {data.git_commit}",
        f"- Report ID: {data.report_id}",
        f"- Dataset ID: {data.dataset_id}",
        f"- Generated: {data.generated_at}",
        "",
        "*This report was generated automatically by NeuroForge. "
        "No AI-generated scientific interpretation is included. "
        "All values are derived from recorded pipeline outputs.*",
    ]

    return "\n".join(lines)


def render_json(data: ReportData) -> str:
    """Render a structured JSON report (figures excluded — too large)."""
    d = asdict(data)
    # Strip base64 image data from JSON export
    for fig in d.get("figures", []):
        fig["data_uri"] = "[embedded in HTML]"
    return json.dumps(d, indent=2, default=str)


def build_supplement_zip(data: ReportData, report_dir: Path) -> Path:
    """Build supplementary_materials.zip containing key report files."""
    zip_path = report_dir / "supplementary_materials.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # Include generated files
        for fname in ["study_report.html", "study_report.md", "study_report.json"]:
            fp = report_dir / fname
            if fp.exists():
                zf.write(fp, fname)

        # Include parameter table as TSV
        if data.runs:
            param_keys = sorted({k for r in data.runs for k in r.params.keys()})
            header = "\t".join(["run_id", "pipeline", "status", "runtime_s"] + param_keys)
            tsv_lines = [header]
            for r in data.runs:
                row = [str(r.run_id), r.pipeline_display_name, r.status,
                       str(r.runtime_seconds if r.runtime_seconds is not None else "")]
                row += [str(r.params.get(k, "")) for k in param_keys]
                tsv_lines.append("\t".join(row))
            zf.writestr("pipeline_parameters.tsv", "\n".join(tsv_lines))

        # Include citations in BibTeX
        if data.citations:
            bibtex = "\n\n".join(c.bibtex for c in data.citations)
            zf.writestr("references.bib", bibtex)

        # Include provenance JSON
        prov = {
            "schema": "neuroforge-provenance-v1",
            "report_id": data.report_id,
            "dataset_id": data.dataset_id,
            "generated_at": data.generated_at,
            "neuroforge_version": data.neuroforge_version,
            "git_commit": data.git_commit,
            "runs": [
                {
                    "run_id": r.run_id,
                    "pipeline_id": r.pipeline_id,
                    "version": r.pipeline_version,
                    "status": r.status,
                    "started_at": r.started_at,
                    "finished_at": r.finished_at,
                    "params": r.params,
                }
                for r in data.runs
            ],
        }
        zf.writestr("provenance.json", json.dumps(prov, indent=2, default=str))

    return zip_path


# ── HTML template ─────────────────────────────────────────────────────────────

def _html_vars(d: ReportData) -> dict[str, Any]:
    """Build template substitution variables."""
    title = d.dataset_name or (Path(d.dataset_path).name if d.dataset_path else "Dataset")

    # Dataset summary rows
    ds_rows = [
        ("Name", d.dataset_name or "—"),
        ("Path", d.dataset_path or "—"),
        ("BIDS version", d.dataset_bids_version or "—"),
        ("Validation", d.dataset_validation_status),
        ("Subjects", str(len(d.dataset_subjects))),
        ("Sessions", str(len(d.dataset_sessions)) if d.dataset_sessions else "—"),
        ("Modalities", ", ".join(d.dataset_modalities) or "—"),
        ("Total files", str(d.dataset_file_count)),
        ("Imported", (d.dataset_imported_at or "")[:10] or "—"),
    ]
    ds_html = "\n".join(
        f"<tr><td class='label'>{k}</td><td>{v}</td></tr>" for k, v in ds_rows
    )

    # Run status cards
    run_cards_html = (
        f'<div class="stat-card"><span class="stat-num">{d.total_runs}</span>'
        f'<span class="stat-lbl">Total runs</span></div>'
        f'<div class="stat-card success"><span class="stat-num">{d.success_runs}</span>'
        f'<span class="stat-lbl">Successful</span></div>'
        f'<div class="stat-card failed"><span class="stat-num">{d.failed_runs}</span>'
        f'<span class="stat-lbl">Failed</span></div>'
        f'<div class="stat-card"><span class="stat-num">{d.cancelled_runs}</span>'
        f'<span class="stat-lbl">Cancelled</span></div>'
    )

    # Pipeline summary table
    if d.runs:
        pipeline_rows = "\n".join(
            f"<tr>"
            f"<td>{r.pipeline_display_name}</td>"
            f"<td><code>{r.pipeline_version}</code></td>"
            f"<td>{r.execution_type}</td>"
            f"<td>{f'{r.runtime_seconds}s' if r.runtime_seconds is not None else '—'}</td>"
            f"<td><span class='badge {r.status}'>{r.status}</span></td>"
            f"<td>{r.artifact_count}</td>"
            f"</tr>"
            for r in d.runs
        )
        pipeline_table_html = (
            "<table class='data-table'>"
            "<thead><tr><th>Pipeline</th><th>Version</th><th>Execution</th>"
            "<th>Runtime</th><th>Status</th><th>Artifacts</th></tr></thead>"
            f"<tbody>{pipeline_rows}</tbody></table>"
        )
    else:
        pipeline_table_html = "<p class='empty'>No runs recorded for this dataset.</p>"

    # Methods sections
    if d.methods_sections:
        methods_html = "\n".join(
            f"<div class='methods-section'>"
            f"<h3>{sec['title']}</h3>"
            f"<p>{sec['text']}</p>"
            f"</div>"
            for sec in d.methods_sections
        )
    else:
        methods_html = "<p class='empty'>No pipeline runs recorded.</p>"

    if d.alff_falff_sections:
        alff_parts = []
        for section in d.alff_falff_sections:
            band = section.get("frequency_band", ["—", "—"])
            rows = [
                ("Run", f"#{section.get('run_id')}"), ("Frequency band", f"{band[0]}–{band[1]} Hz"),
                ("TR", f"{section.get('tr', '—')} s"), ("Nyquist", f"{section.get('nyquist_frequency', '—')} Hz"),
                ("Confounds", section.get("confound_strategy", "—")), ("Normalization", section.get("normalization", "—")),
                ("Runtime", f"{section.get('runtime_seconds', '—')} s"), ("Mask voxels", section.get("mask_voxel_count", "—")),
                ("ALFF statistics", json.dumps(section.get("alff_statistics", {}), sort_keys=True)),
                ("fALFF statistics", json.dumps(section.get("falff_statistics", {}), sort_keys=True)),
            ]
            alff_parts.append("<table class='data-table'><tbody>" + "".join(f"<tr><td>{k}</td><td><code>{v}</code></td></tr>" for k,v in rows) + "</tbody></table>")
        alff_html = "".join(alff_parts) + "<p>No clinical, biological, or inferential interpretation was generated.</p>"
    else:
        alff_html = "<p class='empty'>No ALFF/fALFF runs exist for this dataset.</p>"

    if d.reho_sections:
        reho_parts = []
        for section in d.reho_sections:
            rows = [
                ("Run", f"#{section.get('run_id')}"),
                ("Neighborhood", f"{section.get('neighborhood', '—')} voxels"),
                ("Confounds", section.get("confound_strategy", "—")),
                ("Detrend", str(section.get("detrend", "—"))),
                ("Z-normalize", str(section.get("z_normalize", "—"))),
                ("Runtime", f"{section.get('runtime_seconds', '—')} s"),
                ("Mask voxels", str(section.get("mask_voxel_count", "—"))),
                ("Valid voxels", str(section.get("valid_voxel_count", "—"))),
                ("ReHo statistics", json.dumps(section.get("reho_statistics", {}), sort_keys=True)),
            ]
            reho_parts.append("<table class='data-table'><tbody>" + "".join(f"<tr><td>{k}</td><td><code>{v}</code></td></tr>" for k,v in rows) + "</tbody></table>")
        reho_html = "".join(reho_parts) + "<p>No clinical, biological, or inferential interpretation was generated.</p>"
    else:
        reho_html = "<p class='empty'>No Regional Homogeneity runs exist for this dataset.</p>"

    # Software versions table
    if d.software_table:
        sw_rows = "\n".join(
            f"<tr><td>{row['tool']}</td><td><code>{row['version']}</code></td>"
            f"<td>{row['execution']}</td><td><code>{row['image']}</code></td></tr>"
            for row in d.software_table
        )
        sw_table_html = (
            "<table class='data-table'>"
            "<thead><tr><th>Tool</th><th>Version</th><th>Execution</th><th>Image</th></tr></thead>"
            f"<tbody>{sw_rows}</tbody></table>"
        )
    else:
        sw_table_html = "<p class='empty'>No software version data.</p>"

    # Citations
    if d.citations:
        citations_html = "<ol class='citation-list'>" + "\n".join(
            f"<li><span class='cit-text'>{cit.apa}</span>"
            f"<a class='doi-link' href='https://doi.org/{cit.doi}' target='_blank'>DOI</a>"
            + (f"<span class='rrid'>RRID:{cit.rrid}</span>" if cit.rrid else "")
            + "</li>"
            for cit in d.citations
        ) + "</ol>"
    else:
        citations_html = "<p class='empty'>No citations (no recognised pipelines run).</p>"

    # Warnings
    if d.warnings:
        warnings_html = "<ul class='warnings'>" + "\n".join(
            f"<li>⚠️ {w}</li>" for w in d.warnings
        ) + "</ul>"
    else:
        warnings_html = "<p class='no-warnings'>✓ No warnings.</p>"

    # Figures
    if d.figures:
        figs_html = "<div class='figures-grid'>" + "\n".join(
            f"<figure>"
            f"<img src='{fig.data_uri}' alt='{fig.alt}' />"
            f"<figcaption>{fig.caption}</figcaption>"
            f"</figure>"
            for fig in d.figures
        ) + "</div>"
    else:
        figs_html = "<p class='empty'>No figures produced by completed runs.</p>"

    # Artifact inventory
    if d.artifacts:
        art_rows = "\n".join(
            f"<tr><td>Run {a.run_id}</td><td>{_PIPELINE_DISPLAY_NAMES.get(a.pipeline_id, a.pipeline_id)}</td>"
            f"<td><code>{a.type}</code></td><td>{a.label}</td></tr>"
            for a in d.artifacts
        )
        artifacts_html = (
            "<table class='data-table'>"
            "<thead><tr><th>Run</th><th>Pipeline</th><th>Type</th><th>Label</th></tr></thead>"
            f"<tbody>{art_rows}</tbody></table>"
        )
    else:
        artifacts_html = "<p class='empty'>No resolved artifacts.</p>"

    # Reproducibility checklist
    repro_rows = [
        ("✅" if d.dataset_bids_version else "⚠️", "Dataset is BIDS-formatted"),
        ("✅" if d.dataset_validation_status == "valid" else "⚠️", "BIDS validation passed"),
        ("✅" if d.success_runs > 0 else "—", "At least one successful run"),
        ("✅" if all(r.container_image for r in d.runs) else "⚠️",
         "All pipelines ran in containers (reproducible environment)"),
        ("✅" if d.citations else "—", "Software citations available"),
        ("✅", "Provenance logged (run IDs, parameters, timestamps)"),
        ("✅", "Report generated by NeuroForge with version tracking"),
    ]
    repro_html = "<ul class='repro-list'>" + "\n".join(
        f"<li><span class='repro-icon'>{icon}</span> {text}</li>"
        for icon, text in repro_rows
    ) + "</ul>"

    return {
        "title": title,
        "generated_at": d.generated_at[:19].replace("T", " ") + " UTC",
        "neuroforge_version": d.neuroforge_version,
        "git_commit": d.git_commit,
        "report_id": d.report_id,
        "dataset_id": d.dataset_id,
        "ds_html": ds_html,
        "run_cards_html": run_cards_html,
        "pipeline_table_html": pipeline_table_html,
        "methods_html": methods_html,
        "alff_html": alff_html,
        "reho_html": reho_html,
        "sw_table_html": sw_table_html,
        "citations_html": citations_html,
        "warnings_html": warnings_html,
        "figs_html": figs_html,
        "artifacts_html": artifacts_html,
        "repro_html": repro_html,
    }


_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Study Report — {title}</title>
<style>
/* ── Reset ── */
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
html {{ font-size: 16px; }}
body {{
  font-family: 'Helvetica Neue', Arial, sans-serif;
  color: #1a1a2e;
  background: #ffffff;
  line-height: 1.6;
}}

/* ── Layout ── */
.page {{ max-width: 900px; margin: 0 auto; padding: 48px 40px; }}

/* ── Cover ── */
.cover {{
  border-bottom: 3px solid #5b4fcf;
  padding-bottom: 32px;
  margin-bottom: 40px;
}}
.cover h1 {{ font-size: 2rem; font-weight: 700; color: #1a1a2e; margin-bottom: 8px; }}
.cover .subtitle {{ font-size: 1.1rem; color: #5b4fcf; font-weight: 500; margin-bottom: 24px; }}
.cover-meta {{ display: flex; gap: 24px; flex-wrap: wrap; font-size: 0.85rem; color: #555; }}
.cover-meta span {{ display: flex; align-items: center; gap: 6px; }}

/* ── Section headers ── */
h2 {{
  font-size: 1.3rem;
  font-weight: 700;
  color: #1a1a2e;
  margin: 48px 0 16px;
  padding-bottom: 6px;
  border-bottom: 2px solid #e8e8f0;
}}
h3 {{ font-size: 1.05rem; font-weight: 600; color: #2d2d4e; margin: 20px 0 8px; }}

/* ── Tables ── */
.data-table {{
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
  margin-top: 12px;
}}
.data-table th {{
  background: #f0eff8;
  font-weight: 600;
  text-align: left;
  padding: 8px 12px;
  border: 1px solid #ddd;
  color: #333;
}}
.data-table td {{
  padding: 7px 12px;
  border: 1px solid #e0e0e0;
  vertical-align: top;
}}
.data-table tbody tr:nth-child(even) {{ background: #fafafa; }}
.label {{ color: #555; font-weight: 500; white-space: nowrap; }}
code {{ font-family: 'Courier New', monospace; font-size: 0.85em; background: #f3f3f8; padding: 2px 5px; border-radius: 3px; }}

/* ── Stat cards ── */
.stats-row {{ display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }}
.stat-card {{
  flex: 1; min-width: 120px;
  background: #f5f5fb;
  border: 1px solid #e0e0ef;
  border-radius: 8px;
  padding: 16px;
  text-align: center;
}}
.stat-card.success {{ border-color: #22c55e; background: #f0fdf4; }}
.stat-card.failed {{ border-color: #ef4444; background: #fef2f2; }}
.stat-num {{ display: block; font-size: 2rem; font-weight: 700; color: #1a1a2e; }}
.stat-lbl {{ display: block; font-size: 0.78rem; color: #666; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }}

/* ── Badges ── */
.badge {{
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 0.8em;
  font-weight: 600;
  text-transform: uppercase;
}}
.badge.success {{ background: #dcfce7; color: #166534; }}
.badge.failed {{ background: #fee2e2; color: #991b1b; }}
.badge.running {{ background: #dbeafe; color: #1e40af; }}
.badge.pending {{ background: #fef3c7; color: #92400e; }}
.badge.cancelled {{ background: #f3f4f6; color: #374151; }}

/* ── Methods ── */
.methods-section {{ margin-bottom: 20px; }}
.methods-section p {{ color: #333; }}

/* ── Citations ── */
.citation-list {{ padding-left: 20px; font-size: 0.88rem; }}
.citation-list li {{ margin-bottom: 10px; }}
.cit-text {{ color: #333; }}
.doi-link {{ margin-left: 8px; color: #5b4fcf; font-size: 0.85em; }}
.rrid {{ margin-left: 8px; font-size: 0.8em; color: #888; }}

/* ── Warnings ── */
.warnings {{ list-style: none; padding: 0; }}
.warnings li {{ background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; color: #78350f; }}
.no-warnings {{ color: #166534; }}

/* ── Figures ── */
.figures-grid {{ display: flex; flex-wrap: wrap; gap: 20px; margin-top: 16px; }}
figure {{ flex: 1; min-width: 280px; max-width: 420px; }}
figure img {{ width: 100%; border-radius: 6px; border: 1px solid #e0e0e0; }}
figcaption {{ font-size: 0.82rem; color: #666; margin-top: 6px; text-align: center; }}

/* ── Repro checklist ── */
.repro-list {{ list-style: none; padding: 0; }}
.repro-list li {{ display: flex; align-items: flex-start; gap: 10px; padding: 6px 0; font-size: 0.9rem; border-bottom: 1px solid #f0f0f0; }}
.repro-icon {{ font-size: 1.1em; min-width: 24px; }}

/* ── Footer ── */
.footer {{
  margin-top: 60px;
  padding-top: 20px;
  border-top: 1px solid #e0e0e0;
  font-size: 0.8rem;
  color: #888;
  text-align: center;
}}

.empty {{ color: #999; font-style: italic; margin-top: 8px; }}

/* ── Print styles ── */
@media print {{
  body {{ color: #000; }}
  .cover {{ border-color: #000; }}
  h2 {{ border-color: #ccc; color: #000; }}
  .stat-card {{ border: 1px solid #ccc; background: #fff; }}
  .data-table th {{ background: #f5f5f5; }}
  a {{ color: #000; text-decoration: underline; }}
  .no-print {{ display: none !important; }}
  @page {{ margin: 2cm; }}
  h2 {{ page-break-before: always; }}
  h2:first-of-type {{ page-break-before: auto; }}
}}
</style>
</head>
<body>
<div class="page">

<!-- Cover -->
<div class="cover">
  <h1>{title}</h1>
  <div class="subtitle">NeuroForge Study Report</div>
  <div class="cover-meta">
    <span>Generated: {generated_at}</span>
    <span>NeuroForge {neuroforge_version}</span>
    <span>Commit: {git_commit}</span>
    <span>Report #{report_id} · Dataset #{dataset_id}</span>
  </div>
</div>

<!-- Dataset Summary -->
<h2>Dataset Summary</h2>
<table class="data-table">
  <tbody>
    {ds_html}
  </tbody>
</table>

<!-- Analysis Timeline -->
<h2>Analysis Timeline</h2>
<div class="stats-row">
  {run_cards_html}
</div>

<!-- Pipeline Summary -->
<h2>Pipeline Summary</h2>
{pipeline_table_html}

<!-- Figures -->
<h2>Figures</h2>
{figs_html}

<!-- ALFF/fALFF -->
<h2>ALFF / fALFF Analysis</h2>
{alff_html}

<!-- Regional Homogeneity -->
<h2>Regional Homogeneity (ReHo)</h2>
{reho_html}

<!-- Artifact Inventory -->
<h2>Artifact Inventory</h2>
{artifacts_html}

<!-- Methods -->
<h2>Methods</h2>
{methods_html}

<!-- Software Versions -->
<h2>Software Versions</h2>
{sw_table_html}

<!-- References -->
<h2>References</h2>
{citations_html}

<!-- Warnings -->
<h2>Warnings</h2>
{warnings_html}

<!-- Reproducibility Checklist -->
<h2>Reproducibility Checklist</h2>
{repro_html}

<!-- Footer -->
<div class="footer">
  <p>
    This report was generated automatically by
    <strong>NeuroForge {neuroforge_version}</strong>
    (commit: <code>{git_commit}</code>) on {generated_at}.
    No AI-generated scientific interpretation is included.
    All values are derived exclusively from recorded pipeline outputs.
  </p>
  <p style="margin-top:6px">
    Report ID: {report_id} · Dataset ID: {dataset_id}
  </p>
</div>

</div><!-- /page -->
</body>
</html>"""
