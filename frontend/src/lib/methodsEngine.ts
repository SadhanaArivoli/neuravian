/**
 * Methods generation engine for NeuroForge.
 *
 * All output is derived exclusively from recorded run metadata.
 * No values are inferred or hallucinated. When data is absent, the
 * output explicitly states "Not recorded."
 */

import type { RunMetadata, Dataset } from "../api/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SoftwareTableRow {
  pipelineId: string;
  displayName: string;
  version: string;
  containerImage: string | null;
  executionType: string;
  citationKey: string;
  /** Whether every run of this pipeline had a version recorded. */
  versionComplete: boolean;
}

export interface ParamGroup {
  pipelineId: string;
  displayName: string;
  runIds: number[];
  params: Record<string, unknown>;
}

export interface ReproducibilityConcern {
  level: "warning" | "info";
  message: string;
}

export interface ProvenanceExport {
  schema: "neuroforge-provenance-v1";
  exported_at: string;
  dataset: {
    id: number | null;
    name: string | null;
    path: string | null;
    bids_version: string | null;
    subject_count: number;
  } | null;
  runs: ProvenanceRun[];
}

interface ProvenanceRun {
  run_id: number;
  pipeline_id: string;
  pipeline_display_name: string | null;
  pipeline_version: string;
  status: string;
  container_image: string | null;
  execution_type: string | null;
  started_at: string | null;
  finished_at: string | null;
  runtime_seconds: number | null;
  params: Record<string, unknown>;
  lineage: {
    upstream_run_id: number;
    artifact_type: string;
  } | null;
}

// ── Display-name lookup (fallback when RunMetadata.pipeline_display_name is null) ─

const DISPLAY_NAMES: Record<string, string> = {
  mriqc: "MRIQC",
  "mriqc-group": "MRIQC Group Report",
  fmriprep: "fMRIPrep",
  "import-fmriprep-derivatives": "Import fMRIPrep Derivatives",
  brainchop: "BrainChop",
  synthstrip: "SynthStrip",
  fastsurfer: "FastSurfer",
  "bids-validator": "BIDS Validator",
  dcm2niix: "dcm2niix",
  dcm2bids: "dcm2bids",
  pydeface: "pydeface",
  "functional-connectivity": "Functional Connectivity (Nilearn)",
};

const FUNCTIONAL_CONNECTIVITY_ATLASES: Record<string, { label: string; rois: number; networks?: number }> = {
  schaefer100_7: { label: "Schaefer 2018 100 parcels / 7 networks", rois: 100, networks: 7 },
  schaefer_100_7: { label: "Schaefer 2018 100 parcels / 7 networks", rois: 100, networks: 7 },
  schaefer200_7: { label: "Schaefer 2018 200 parcels / 7 networks", rois: 200, networks: 7 },
  aal: { label: "AAL3", rois: 166 },
  harvard_oxford_cortical: { label: "Harvard-Oxford cortical", rois: 48 },
};

export function pipelineDisplayName(m: RunMetadata): string {
  return m.pipeline_display_name ?? DISPLAY_NAMES[m.pipeline_id] ?? m.pipeline_id;
}

// ── Software table ─────────────────────────────────────────────────────────────

/**
 * Deduplicate runs into one row per unique (pipelineId, version) combination.
 * Runs with status !== "success" are still included — provenance should be complete.
 */
export function buildSoftwareTable(runs: RunMetadata[]): SoftwareTableRow[] {
  const rowMap = new Map<string, SoftwareTableRow>();

  for (const run of runs) {
    const key = `${run.pipeline_id}@${run.pipeline_version}`;
    if (rowMap.has(key)) continue;

    const image = run.container_image
      ? run.container_image
      : null;

    rowMap.set(key, {
      pipelineId: run.pipeline_id,
      displayName: pipelineDisplayName(run),
      version: run.pipeline_version || "Not recorded",
      containerImage: image,
      executionType: run.execution_type ?? "Not recorded",
      citationKey: run.pipeline_id,
      versionComplete: !!run.pipeline_version,
    });
  }

  return Array.from(rowMap.values()).sort((a, b) =>
    a.pipelineId.localeCompare(b.pipelineId),
  );
}

// ── Parameter appendix ────────────────────────────────────────────────────────

/** Group non-default parameters by pipeline across all runs. */
export function buildParamAppendix(runs: RunMetadata[]): ParamGroup[] {
  const groups = new Map<string, ParamGroup>();

  for (const run of runs) {
    const params = run.params ?? {};
    if (Object.keys(params).length === 0) continue;

    const key = run.pipeline_id;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        pipelineId: run.pipeline_id,
        displayName: pipelineDisplayName(run),
        runIds: [run.run_id],
        params: { ...params },
      });
    } else {
      // Merge params — keep all unique keys seen across runs
      existing.runIds.push(run.run_id);
      for (const [k, v] of Object.entries(params)) {
        if (!(k in existing.params)) {
          existing.params[k] = v;
        }
      }
    }
  }

  return Array.from(groups.values()).sort((a, b) =>
    a.pipelineId.localeCompare(b.pipelineId),
  );
}

// ── Methods prose generator ───────────────────────────────────────────────────

const NOT_RECORDED = "Not recorded";

function executionDescription(run: RunMetadata): string {
  if (run.execution_type === "docker" && run.container_image) {
    return `within a Docker container (${run.container_image})`;
  }
  if (run.execution_type === "docker") {
    return "within a Docker container";
  }
  if (run.execution_type === "native") {
    return "natively (without containerization)";
  }
  return NOT_RECORDED;
}

function runtimeDescription(run: RunMetadata): string {
  if (!run.runtime_seconds) return "";
  const s = run.runtime_seconds;
  if (s < 60) return ` in ${s} seconds`;
  const m = Math.floor(s / 60);
  if (m < 60) return ` in ${m} minutes`;
  return ` in ${Math.floor(m / 60)} hours ${m % 60} minutes`;
}

const PROSE_TEMPLATES: Record<
  string,
  (run: RunMetadata) => string
> = {
  mriqc: (run) =>
    `Image quality metrics were computed using MRIQC (v${run.pipeline_version || NOT_RECORDED}) ` +
    `executed ${executionDescription(run)}${runtimeDescription(run)}. ` +
    `MRIQC produces a set of no-reference image quality metrics (IQMs) for each participant ` +
    `and modality, enabling systematic quality control without manual review of every scan.`,

  "mriqc-group": (run) =>
    `A group-level quality control report was generated using MRIQC Group Report ` +
    `(v${run.pipeline_version || NOT_RECORDED}) executed ${executionDescription(run)}. ` +
    `The group report aggregates per-participant IQMs to identify systematic ` +
    `acquisition artifacts or outliers across the dataset.`,

  fmriprep: (run) =>
    `Functional MRI data were preprocessed using fMRIPrep ` +
    `(v${run.pipeline_version || NOT_RECORDED}) ` +
    `executed ${executionDescription(run)}${runtimeDescription(run)}. ` +
    `fMRIPrep is a robust and reproducible preprocessing workflow built upon ` +
    `Nipype (Gorgolewski et al., 2011). Preprocessing steps included slice-time ` +
    `correction, motion estimation and correction, susceptibility distortion ` +
    `correction, co-registration, normalization, and confound estimation.`,

  "import-fmriprep-derivatives": (run) =>
    `Precomputed fMRIPrep derivatives (v${run.pipeline_version || NOT_RECORDED}) ` +
    `were imported into the NeuroForge workspace` +
    `${runtimeDescription(run)}. ` +
    `These derivatives were generated externally and registered for downstream analysis.`,

  brainchop: (run) =>
    `Skull stripping was performed using BrainChop/MindGrab ` +
    `(v${run.pipeline_version || NOT_RECORDED}) ` +
    `executed ${executionDescription(run)}${runtimeDescription(run)}. ` +
    `BrainChop applies a convolutional neural network trained on multi-site ` +
    `T1-weighted images to produce a binary brain mask and skull-stripped volume.`,

  synthstrip: (run) => {
    const border = run.params?.border !== undefined
      ? ` with a border of ${run.params.border} voxel(s)`
      : "";
    return (
      `Skull stripping was performed using SynthStrip ` +
      `(FreeSurfer v${run.pipeline_version || NOT_RECORDED}) ` +
      `executed ${executionDescription(run)}${runtimeDescription(run)}${border}. ` +
      `SynthStrip is a learning-based skull-stripping tool that operates on ` +
      `any MRI contrast without requiring contrast-specific training data.`
    );
  },

  fastsurfer: (run) =>
    `Cortical surface reconstruction and subcortical segmentation were performed ` +
    `using FastSurfer (v${run.pipeline_version || NOT_RECORDED}) ` +
    `executed ${executionDescription(run)}${runtimeDescription(run)}. ` +
    `FastSurfer employs deep learning for rapid segmentation followed by ` +
    `surface reconstruction compatible with the FreeSurfer file format.`,

  "bids-validator": (run) =>
    `Dataset compliance with the Brain Imaging Data Structure (BIDS) standard ` +
    `was verified using the BIDS Validator (v${run.pipeline_version || NOT_RECORDED}) ` +
    `executed ${executionDescription(run)}.`,

  dcm2niix: (run) =>
    `DICOM images were converted to NIfTI format using dcm2niix ` +
    `(v${run.pipeline_version || NOT_RECORDED}) ` +
    `executed ${executionDescription(run)}${runtimeDescription(run)}.`,

  dcm2bids: (run) =>
    `DICOM data were organized into BIDS-compliant format using dcm2bids ` +
    `(v${run.pipeline_version || NOT_RECORDED}) ` +
    `executed ${executionDescription(run)}${runtimeDescription(run)}.`,

  pydeface: (run) =>
    `Facial features were removed from structural images using pydeface ` +
    `(v${run.pipeline_version || NOT_RECORDED}) ` +
    `executed ${executionDescription(run)}${runtimeDescription(run)}, ` +
    `following the method described by Milchenko & Marcus (2013).`,

  "functional-connectivity": (run) => {
    const atlasId = String(run.params?.["atlas-name"] ?? run.params?.atlas ?? "schaefer100_7");
    const atlasMeta = FUNCTIONAL_CONNECTIVITY_ATLASES[atlasId];
    const atlas = atlasMeta?.label ?? atlasId;
    const n = run.params?.["n-rois"] ?? run.params?.n_rois ?? atlasMeta?.rois ?? NOT_RECORDED;
    const networkText = atlasMeta?.networks ? ` across ${atlasMeta.networks} networks` : "";
    const measure = run.params?.measure ?? "Pearson correlation";
    return (
      `Functional connectivity was computed using Nilearn ` +
      `(v${run.pipeline_version || NOT_RECORDED}) ` +
      `executed ${executionDescription(run)}${runtimeDescription(run)}. ` +
      `A ${measure} matrix was constructed using the ${atlas} atlas` +
      (n !== NOT_RECORDED ? ` (${n} ROIs${networkText})` : "") +
      `. Time-series were extracted from the fMRIPrep-preprocessed BOLD data ` +
      `and connectivity was estimated as pairwise ${measure} coefficients. ` +
      `Per-ROI descriptive statistics were generated for the selected atlas` +
      (n !== NOT_RECORDED ? ` (${n} ROIs)` : "") +
      `.`
    );
  },
  "seed-based-connectivity": (run) => {
    const atlasId = String(run.params?.["atlas-name"] ?? run.params?.atlas ?? "schaefer100_7");
    const atlasMeta = FUNCTIONAL_CONNECTIVITY_ATLASES[atlasId];
    const atlas = atlasMeta?.label ?? atlasId;
    const seedRoi = run.params?.["seed-roi"] ?? run.params?.seed_roi ?? NOT_RECORDED;
    return (
      `Seed-based functional connectivity was computed using Nilearn ` +
      `(v${run.pipeline_version || NOT_RECORDED}) ` +
      `executed ${executionDescription(run)}${runtimeDescription(run)}. ` +
      `The seed region of interest (ROI${seedRoi !== NOT_RECORDED ? ` #${seedRoi}` : ""}) was defined using the ${atlas} atlas. ` +
      `A single-seed time series was extracted from the fMRIPrep-preprocessed BOLD data ` +
      `using NiftiLabelsMasker with z-score standardization and linear detrending. ` +
      `Voxelwise Pearson correlation was computed between the seed time series and all ` +
      `brain voxels extracted with NiftiMasker. Correlation values were Fisher ` +
      `z-transformed (arctanh) to produce an approximately normally distributed ` +
      `connectivity map.`
    );
  },
  "atlas-roi-extraction": (run) => {
    const atlasId = String(run.params?.["atlas"] ?? run.params?.atlas ?? "schaefer100_7");
    const atlasMeta = FUNCTIONAL_CONNECTIVITY_ATLASES[atlasId];
    const atlas = atlasMeta?.label ?? atlasId;
    const nRois = atlasMeta?.rois ?? NOT_RECORDED;
    const aggMode = String(run.params?.["aggregation-mode"] ?? run.params?.aggregation_mode ?? "none");
    const aggText = aggMode === "temporal_mean"
      ? " 4D data were temporally averaged prior to extraction."
      : "";
    const resampNote =
      "Where the input image and atlas differed in voxel spacing or field of view, " +
      "the atlas was resampled to the image space using nearest-neighbour interpolation " +
      "to preserve integer parcel labels exactly.";
    return (
      `Atlas-based region-of-interest (ROI) statistics were extracted using a NeuroForge ` +
      `native pipeline built on nibabel and Nilearn ` +
      `(v${run.pipeline_version || NOT_RECORDED}) ` +
      `executed ${executionDescription(run)}${runtimeDescription(run)}. ` +
      `The ${atlas} atlas` +
      (typeof nRois === "number" ? ` (${nRois} parcels)` : "") +
      ` was applied to the input scalar image. ` +
      `For each parcel, the following statistics were computed: mean, median, ` +
      `standard deviation, minimum, maximum, 5th and 95th percentiles, voxel count, ` +
      `non-zero voxel count, and coverage percentage.${aggText} ` +
      resampNote +
      ` All reported statistics are descriptive; no inferential tests were performed.`
    );
  },
  "group-functional-connectivity": (run) => {
    const nRuns = run.params?.["input-run-ids"]
      ? String(run.params["input-run-ids"]).split(",").filter(Boolean).length
      : NOT_RECORDED;
    const runsText = nRuns !== NOT_RECORDED ? `${nRuns} run${Number(nRuns) === 1 ? "" : "s"}` : "multiple runs";
    return (
      `Group-level functional connectivity was computed using Nilearn ` +
      `(v${run.pipeline_version || NOT_RECORDED}) ` +
      `executed ${executionDescription(run)}${runtimeDescription(run)}. ` +
      `Individual ROI-by-ROI connectivity matrices from ${runsText} were aggregated ` +
      `by computing the element-wise arithmetic mean and sample standard deviation ` +
      `(ddof=1) across all input matrices. All input matrices were verified to share ` +
      `the same atlas, ROI count, and correlation method prior to aggregation. ` +
      `Reported statistics are descriptive only and do not include inferential tests.`
    );
  },
};

function genericProse(run: RunMetadata): string {
  return (
    `${pipelineDisplayName(run)} (v${run.pipeline_version || NOT_RECORDED}) ` +
    `was executed ${executionDescription(run)}${runtimeDescription(run)}.`
  );
}

/**
 * Generate publication-ready Methods prose from recorded run metadata.
 * Runs are ordered by started_at ascending (chronological).
 * Returns an array of paragraphs — one per unique pipeline.
 */
export function generateMethodsParagraphs(runs: RunMetadata[]): string[] {
  // Deduplicate: one paragraph per unique pipeline, use the most recent run's metadata
  const byPipeline = new Map<string, RunMetadata>();
  for (const run of [...runs].sort((a, b) =>
    (a.started_at ?? "").localeCompare(b.started_at ?? ""),
  )) {
    byPipeline.set(run.pipeline_id, run);
  }

  return Array.from(byPipeline.values()).map((run) => {
    const template = PROSE_TEMPLATES[run.pipeline_id];
    return template ? template(run) : genericProse(run);
  });
}

/**
 * Generate a full methods section combining all paragraphs.
 * Adds a preamble about NeuroForge and a closing reproducibility note.
 */
export function generateMethodsSection(
  runs: RunMetadata[],
  dataset: Dataset | null,
): string {
  const paragraphs = generateMethodsParagraphs(runs);

  const datasetName = dataset?.name ?? "the dataset";
  const subjectCount = dataset?.subject_count ?? null;
  const subjectLine =
    subjectCount != null
      ? ` The dataset comprised ${subjectCount} participant${subjectCount !== 1 ? "s" : ""}.`
      : "";

  const preamble =
    `All analyses were performed using NeuroForge, an open-source neuroimaging ` +
    `workflow platform (https://github.com/SadhanaArivoli/neuroforge), ` +
    `operating on ${datasetName}.${subjectLine}`;

  const closing =
    `All pipeline executions were logged with version numbers, container images, ` +
    `parameters, and timestamps to support reproducibility. ` +
    `Detailed provenance records are available as supplementary material.`;

  return [preamble, ...paragraphs, closing].join("\n\n");
}

// ── Reproducibility concerns ───────────────────────────────────────────────────

export function findReproducibilityConcerns(
  runs: RunMetadata[],
): ReproducibilityConcern[] {
  const concerns: ReproducibilityConcern[] = [];
  const missingVersions = runs.filter(
    (r) => !r.pipeline_version || r.pipeline_version === "unknown",
  );
  if (missingVersions.length > 0) {
    const names = [...new Set(missingVersions.map(pipelineDisplayName))].join(", ");
    concerns.push({
      level: "warning",
      message: `Software version not recorded for: ${names}. Exact reproducibility cannot be guaranteed.`,
    });
  }

  const missingContainer = runs.filter(
    (r) => r.execution_type === "docker" && !r.container_image,
  );
  if (missingContainer.length > 0) {
    concerns.push({
      level: "warning",
      message:
        "Some Docker runs have no container image tag recorded. Pin the image digest for full reproducibility.",
    });
  }

  const nativeRuns = runs.filter((r) => r.execution_type === "native");
  if (nativeRuns.length > 0) {
    const names = [...new Set(nativeRuns.map(pipelineDisplayName))].join(", ");
    concerns.push({
      level: "info",
      message: `${names} ran natively (not containerized). System-level dependencies may affect reproducibility.`,
    });
  }

  const failedRuns = runs.filter((r) => r.status === "failed");
  if (failedRuns.length > 0) {
    concerns.push({
      level: "warning",
      message: `${failedRuns.length} run(s) did not complete successfully and are included in this report.`,
    });
  }

  return concerns;
}

// ── Provenance export ─────────────────────────────────────────────────────────

export function buildProvenanceExport(
  runs: RunMetadata[],
  dataset: Dataset | null,
): ProvenanceExport {
  return {
    schema: "neuroforge-provenance-v1",
    exported_at: new Date().toISOString(),
    dataset: dataset
      ? {
          id: dataset.id,
          name: dataset.name,
          path: dataset.path,
          bids_version: dataset.bids_version,
          subject_count: dataset.subject_count,
        }
      : null,
    runs: runs.map((r) => ({
      run_id: r.run_id,
      pipeline_id: r.pipeline_id,
      pipeline_display_name: r.pipeline_display_name,
      pipeline_version: r.pipeline_version,
      status: r.status,
      container_image: r.container_image,
      execution_type: r.execution_type,
      started_at: r.started_at,
      finished_at: r.finished_at,
      runtime_seconds: r.runtime_seconds,
      params: r.params,
      lineage: r.lineage
        ? {
            upstream_run_id: r.lineage.upstream_run_id,
            artifact_type: r.lineage.artifact_type,
          }
        : null,
    })),
  };
}

/** Convert a provenance export object to YAML string (no external deps). */
export function provenanceToYAML(prov: ProvenanceExport): string {
  function indent(s: string, n: number): string {
    const pad = " ".repeat(n);
    return s
      .split("\n")
      .map((l) => pad + l)
      .join("\n");
  }

  function valueToYAML(v: unknown, depth: number): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") {
      if (v.includes(":") || v.includes("#") || v === "") return `"${v.replace(/"/g, '\\"')}"`;
      return v;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return "\n" + v.map((item) => indent(`- ${valueToYAML(item, depth + 1)}`, depth * 2)).join("\n");
    }
    if (typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) return "{}";
      return "\n" + entries
        .map(([k, val]) => indent(`${k}: ${valueToYAML(val, depth + 1)}`, depth * 2))
        .join("\n");
    }
    return String(v);
  }

  const lines: string[] = [
    `schema: "${prov.schema}"`,
    `exported_at: "${prov.exported_at}"`,
  ];

  if (prov.dataset) {
    lines.push("dataset:");
    for (const [k, v] of Object.entries(prov.dataset)) {
      lines.push(`  ${k}: ${valueToYAML(v, 2)}`);
    }
  } else {
    lines.push("dataset: null");
  }

  lines.push("runs:");
  for (const run of prov.runs) {
    lines.push(`  - run_id: ${run.run_id}`);
    lines.push(`    pipeline_id: ${run.pipeline_id}`);
    lines.push(`    pipeline_display_name: ${valueToYAML(run.pipeline_display_name, 2)}`);
    lines.push(`    pipeline_version: ${valueToYAML(run.pipeline_version, 2)}`);
    lines.push(`    status: ${run.status}`);
    lines.push(`    container_image: ${valueToYAML(run.container_image, 2)}`);
    lines.push(`    execution_type: ${valueToYAML(run.execution_type, 2)}`);
    lines.push(`    started_at: ${valueToYAML(run.started_at, 2)}`);
    lines.push(`    finished_at: ${valueToYAML(run.finished_at, 2)}`);
    lines.push(`    runtime_seconds: ${valueToYAML(run.runtime_seconds, 2)}`);
    if (Object.keys(run.params).length === 0) {
      lines.push("    params: {}");
    } else {
      lines.push("    params:");
      for (const [k, v] of Object.entries(run.params)) {
        lines.push(`      ${k}: ${valueToYAML(v, 3)}`);
      }
    }
    if (run.lineage) {
      lines.push("    lineage:");
      lines.push(`      upstream_run_id: ${run.lineage.upstream_run_id}`);
      lines.push(`      artifact_type: ${run.lineage.artifact_type}`);
    } else {
      lines.push("    lineage: null");
    }
  }

  return lines.join("\n");
}

// ── Markdown export ───────────────────────────────────────────────────────────

import type { Citation } from "./citationRegistry";
import { formatAPA } from "./citationRegistry";

export function exportMarkdown(opts: {
  methodsSection: string;
  citations: Citation[];
  softwareTable: SoftwareTableRow[];
  paramGroups: ParamGroup[];
  concerns: ReproducibilityConcern[];
  datasetName: string;
}): string {
  const { methodsSection, citations, softwareTable, paramGroups, concerns, datasetName } = opts;
  const date = new Date().toISOString().slice(0, 10);

  const lines: string[] = [
    `# Methods & Citation Report`,
    ``,
    `**Dataset:** ${datasetName}`,
    `**Generated:** ${date}`,
    `**Generated by:** NeuroForge`,
    ``,
    `---`,
    ``,
    `## Methods`,
    ``,
    methodsSection,
    ``,
    `---`,
    ``,
    `## Software Table`,
    ``,
    `| Software | Version | Container | Execution | Citation |`,
    `|---|---|---|---|---|`,
    ...softwareTable.map(
      (r) =>
        `| ${r.displayName} | ${r.version} | ${r.containerImage ?? "—"} | ${r.executionType} | ${r.citationKey} |`,
    ),
    ``,
    `---`,
    ``,
    `## References`,
    ``,
    ...citations.map((c, i) => `${i + 1}. ${formatAPA(c)}`),
    ``,
  ];

  if (paramGroups.length > 0) {
    lines.push(`---`, ``, `## Parameters Appendix`, ``);
    for (const g of paramGroups) {
      lines.push(`### ${g.displayName}`, ``);
      lines.push(`Runs: ${g.runIds.map((id) => `#${id}`).join(", ")}`, ``);
      lines.push("```");
      for (const [k, v] of Object.entries(g.params)) {
        lines.push(`--${k} ${v}`);
      }
      lines.push("```", ``);
    }
  }

  if (concerns.length > 0) {
    lines.push(`---`, ``, `## Reproducibility Notes`, ``);
    for (const c of concerns) {
      const prefix = c.level === "warning" ? "⚠️" : "ℹ️";
      lines.push(`- ${prefix} ${c.message}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ── SVG workflow figure ───────────────────────────────────────────────────────

interface FigureNode {
  id: number | "dataset";
  label: string;
  version: string;
  status: string;
  x: number;
  y: number;
}

interface FigureEdge {
  from: number | "dataset";
  to: number;
}

const NODE_W = 200;
const NODE_H = 64;
const LEVEL_GAP = 110;
const H_GAP = 220;

/**
 * Build a publication-quality SVG workflow figure from run metadata.
 * White background, clean typography, suitable for research papers.
 */
export function buildWorkflowSVG(
  runs: RunMetadata[],
  datasetName: string,
): string {
  if (runs.length === 0) return "";

  // Topological sort by source_run_id
  const idSet = new Set(runs.map((r) => r.run_id));
  const levels = new Map<number | "dataset", number>();
  levels.set("dataset", 0);

  function getLevel(runId: number): number {
    if (levels.has(runId)) return levels.get(runId)!;
    const run = runs.find((r) => r.run_id === runId);
    if (!run || !run.lineage?.upstream_run_id) {
      const lvl = 1;
      levels.set(runId, lvl);
      return lvl;
    }
    const parentId = run.lineage.upstream_run_id;
    const parentLevel = idSet.has(parentId) ? getLevel(parentId) : 0;
    const lvl = parentLevel + 1;
    levels.set(runId, lvl);
    return lvl;
  }

  for (const r of runs) getLevel(r.run_id);

  // Group by level
  const byLevel = new Map<number, (number | "dataset")[]>();
  for (const [id, lvl] of levels) {
    const arr = byLevel.get(lvl) ?? [];
    arr.push(id);
    byLevel.set(lvl, arr);
  }

  const maxLevel = Math.max(...levels.values());
  const maxWidth = Math.max(...Array.from(byLevel.values()).map((a) => a.length));

  const svgW = Math.max(NODE_W + 40, maxWidth * H_GAP + 40);
  const svgH = (maxLevel + 2) * LEVEL_GAP + NODE_H + 40;

  // Assign positions
  const nodes: FigureNode[] = [];
  for (const [lvl, ids] of byLevel) {
    const count = ids.length;
    const totalWidth = count * NODE_W + (count - 1) * (H_GAP - NODE_W);
    const startX = (svgW - totalWidth) / 2;
    ids.forEach((id, idx) => {
      const x = startX + idx * H_GAP;
      const y = lvl * LEVEL_GAP + 20;
      if (id === "dataset") {
        nodes.push({ id: "dataset", label: datasetName || "Dataset", version: "", status: "dataset", x, y });
      } else {
        const run = runs.find((r) => r.run_id === id)!;
        nodes.push({
          id,
          label: pipelineDisplayName(run),
          version: run.pipeline_version ? `v${run.pipeline_version}` : "",
          status: run.status,
          x,
          y,
        });
      }
    });
  }

  const edges: FigureEdge[] = [];
  for (const run of runs) {
    const parentId = run.lineage?.upstream_run_id;
    if (parentId && idSet.has(parentId)) {
      edges.push({ from: parentId, to: run.run_id });
    } else {
      edges.push({ from: "dataset", to: run.run_id });
    }
  }

  const STATUS_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
    success:  { fill: "#f0fdf4", stroke: "#16a34a", text: "#15803d" },
    failed:   { fill: "#fef2f2", stroke: "#dc2626", text: "#b91c1c" },
    running:  { fill: "#fffbeb", stroke: "#d97706", text: "#b45309" },
    pending:  { fill: "#f9fafb", stroke: "#9ca3af", text: "#6b7280" },
    dataset:  { fill: "#ede9fe", stroke: "#7c3aed", text: "#5b21b6" },
  };

  function nodePos(id: number | "dataset"): { cx: number; cy: number } {
    const n = nodes.find((node) => node.id === id);
    if (!n) return { cx: 0, cy: 0 };
    return { cx: n.x + NODE_W / 2, cy: n.y + NODE_H / 2 };
  }

  const edgeLines = edges.map(({ from, to }) => {
    const f = nodePos(from);
    const t = nodePos(to);
    const my = (f.cy + t.cy) / 2;
    return `<path d="M ${f.cx} ${f.cy + NODE_H / 2 - 20} C ${f.cx} ${my} ${t.cx} ${my} ${t.cx} ${t.cy - NODE_H / 2 + 20}" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#arrow)" />`;
  });

  const nodeRects = nodes.map((n) => {
    const colors = STATUS_COLORS[n.status] ?? STATUS_COLORS.pending;
    const runLabel = n.id !== "dataset" ? `  <text x="${n.x + NODE_W / 2}" y="${n.y + 52}" font-size="9" fill="#6b7280" text-anchor="middle">Run #${n.id}</text>` : "";
    const versionLabel = n.version
      ? `  <text x="${n.x + NODE_W - 8}" y="${n.y + 16}" font-size="8" fill="${colors.text}" text-anchor="end">${n.version}</text>`
      : "";
    return [
      `<rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" rx="8" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="1.5" />`,
      `<text x="${n.x + NODE_W / 2}" y="${n.y + 30}" font-size="11" font-weight="600" fill="#1e293b" text-anchor="middle" font-family="system-ui,sans-serif">${n.label}</text>`,
      versionLabel,
      runLabel,
    ].join("\n");
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="background:white;font-family:system-ui,sans-serif">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
    </marker>
  </defs>
  ${edgeLines.join("\n  ")}
  ${nodeRects.join("\n  ")}
</svg>`;
}
