/**
 * Workflow template definitions and edge validation.
 *
 * Every template edge is validated against the pipeline manifests before the
 * builder canvas is populated. Invalid edges are rejected at load time so
 * broken chains cannot reach the execution layer.
 *
 * Validation rules (see validateTemplateEdges):
 *  1. Every pipeline ID must exist in the manifest registry.
 *  2. Every step must declare an artifactType that the pipeline's accepts[] covers.
 *  3. For step i > 0, step[i].artifactType must be produced by step[i-1].
 *  4. For step 0, artifactType must match the template's requiredSourceArtifact.
 */

import type { ComputeProfile, PipelineCategory } from "../api/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TemplateStepDef {
  pipelineId: string;
  /** Displayed on the node card as the "Input" artifact chip. */
  inputArtifactType: string;
  edge: {
    artifactType: string;
    acceptParam: string | null;
    acceptDatasetSlot: boolean;
    acceptLabel: string | null;
  };
}

export type TemplateSourceKind = "dataset" | "run";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  categoryKey: PipelineCategory | "unknown";
  estimatedRuntime: string;
  steps: TemplateStepDef[];
  /** Whether the source selector should be "dataset" or "run". */
  requiredSourceKind: TemplateSourceKind;
  /**
   * Artifact type the source must expose (e.g. "bids_dataset", "nifti_raw").
   * Must match step[0].edge.artifactType.
   */
  requiredSourceArtifact: string;
  /** Human-readable label for the required source shown on the template card. */
  requiredSourceLabel: string;
  /** Most demanding compute profile in this chain (for card warning). */
  worstComputeProfile: ComputeProfile;
  /** Optional warning text shown on the card for compute-heavy templates. */
  computeWarning?: string;
  /**
   * Set to true for templates that are planned but not yet representable in
   * the linear V1 builder. Shown on the picker as an informational card
   * but cannot be selected.
   */
  disabled?: boolean;
  disabledReason?: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Slim manifest shape needed for edge validation (subset of Pipeline). */
export interface ManifestSlim {
  id: string;
  accepts: Array<{ type: string; param?: string; dataset_slot?: boolean }>;
  produces: Array<{ type: string }>;
}

export interface TemplateValidationError {
  step: number;
  pipelineId: string;
  message: string;
}

export interface TemplateValidationResult {
  valid: boolean;
  errors: TemplateValidationError[];
}

/**
 * Validates that every edge in a template sequence is supported by the
 * accepts/produces slots in the fetched pipeline manifests.
 *
 * Returns { valid: true, errors: [] } when all edges are sound.
 * Returns { valid: false, errors: [...] } with every violation listed.
 */
export function validateTemplateEdges(
  template: WorkflowTemplate,
  manifests: Record<string, ManifestSlim>,
): TemplateValidationResult {
  const errors: TemplateValidationError[] = [];

  if (template.steps.length === 0) {
    // Disabled / coming-soon templates have no steps; skip.
    return { valid: true, errors: [] };
  }

  for (let i = 0; i < template.steps.length; i++) {
    const step = template.steps[i];
    const manifest = manifests[step.pipelineId];

    // Rule 1 — pipeline must exist in registry
    if (!manifest) {
      errors.push({
        step: i,
        pipelineId: step.pipelineId,
        message: `Pipeline "${step.pipelineId}" not found in manifest registry.`,
      });
      // Cannot check edge rules without the manifest; move to next step.
      continue;
    }

    const declared = step.edge.artifactType;
    const accepts = manifest.accepts ?? [];
    const canAccept = accepts.some((a) => a.type === declared);

    // Rule 2 — the pipeline must accept the declared artifact type
    if (!canAccept) {
      const acceptedTypes = accepts.map((a) => a.type).join(", ") || "none";
      errors.push({
        step: i,
        pipelineId: step.pipelineId,
        message:
          `Pipeline "${step.pipelineId}" does not accept artifact type ` +
          `"${declared}". Accepted: [${acceptedTypes}].`,
      });
    }

    if (i === 0) {
      // Rule 4 — first step's artifact type must match the template's source
      if (declared !== template.requiredSourceArtifact) {
        errors.push({
          step: i,
          pipelineId: step.pipelineId,
          message:
            `First step declares input "${declared}" but the template source ` +
            `exposes "${template.requiredSourceArtifact}". These must match.`,
        });
      }
    } else {
      // Rule 3 — artifact type must be produced by the previous step
      const prevPipelineId = template.steps[i - 1].pipelineId;
      const prevManifest = manifests[prevPipelineId];
      if (prevManifest) {
        const prevProduces = prevManifest.produces ?? [];
        const prevProducesThis = prevProduces.some((p) => p.type === declared);
        if (!prevProducesThis) {
          const produced = prevProduces.map((p) => p.type).join(", ") || "nothing";
          errors.push({
            step: i,
            pipelineId: step.pipelineId,
            message:
              `Step ${i} expects "${declared}" but step ${i - 1} ` +
              `("${prevPipelineId}") produces [${produced}].`,
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Source helpers ────────────────────────────────────────────────────────────

/**
 * Filter runs to those whose pipeline declares the required artifact type in
 * its `produces[]` manifest slot. The caller supplies a pre-fetched
 * `pipelineProducesMap` (pipeline ID → produced artifact types) so this
 * function stays pure and testable without network calls.
 *
 * A run qualifies automatically when its pipeline's manifest lists the type —
 * no hardcoded pipeline-ID lists are needed.
 */
export function filterRunsByArtifact<T extends { pipeline_manifest_id: string }>(
  runs: T[],
  requiredArtifact: string,
  pipelineProducesMap: Record<string, string[]>,
): T[] {
  return runs.filter((run) =>
    (pipelineProducesMap[run.pipeline_manifest_id] ?? []).includes(requiredArtifact),
  );
}

// ── Template definitions ──────────────────────────────────────────────────────
//
// Every edge here is validated against the live manifests in loadTemplate().
// These definitions reflect the actual accepts/produces slots; do NOT modify
// them to work around invalid artifact chains — fix the chain instead.
//
// Artifact graph for reference:
//   bids_dataset       → bids-validator → bids_dataset_validated
//   bids_dataset_validated → mriqc      → mriqc_report → mriqc-group → mriqc_group_report
//   bids_dataset       → import-fmriprep-derivatives → fmriprep_derivatives
//   fmriprep_derivatives → functional-connectivity
//   nifti_raw          → brainchop      → nifti_skull_stripped
//   nifti_skull_stripped → fastsurfer   → freesurfer_dir
//   nifti_raw          → pydeface       → nifti_defaced

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  // ── 1. BIDS Validation + QC ────────────────────────────────────────────────
  // bids-validator (bids_dataset → bids_dataset_validated) → mriqc (dataset_slot) → mriqc-group
  {
    id: "bids-validation-qc",
    name: "BIDS Validation + QC",
    description:
      "Validate a BIDS dataset, run participant-level MRIQC, then aggregate the results into a group report.",
    categoryKey: "quality_control",
    estimatedRuntime: "30 min – 6 hrs",
    requiredSourceKind: "dataset",
    requiredSourceArtifact: "bids_dataset",
    requiredSourceLabel: "Registered BIDS dataset",
    worstComputeProfile: "local-ok",
    steps: [
      {
        pipelineId: "bids-validator",
        inputArtifactType: "bids_dataset",
        edge: {
          artifactType: "bids_dataset",
          acceptParam: "bids-dir",
          acceptDatasetSlot: false,
          acceptLabel: "BIDS Dataset",
        },
      },
      {
        pipelineId: "mriqc",
        inputArtifactType: "bids_dataset_validated",
        edge: {
          artifactType: "bids_dataset_validated",
          acceptParam: null,
          acceptDatasetSlot: true,
          acceptLabel: "Validated BIDS Dataset",
        },
      },
      {
        pipelineId: "mriqc-group",
        inputArtifactType: "mriqc_report",
        edge: {
          artifactType: "mriqc_report",
          acceptParam: "upstream-mriqc-dir",
          acceptDatasetSlot: false,
          acceptLabel: "Participant MRIQC Report",
        },
      },
    ],
  },

  // ── 2. fMRI Preprocessing ──────────────────────────────────────────────────
  // bids-validator (bids_dataset → bids_dataset_validated) → fmriprep (dataset_slot)
  {
    id: "fmri-preprocessing",
    name: "fMRI Preprocessing",
    description:
      "Validate a BIDS fMRI dataset, then preprocess with fMRIPrep to produce BOLD derivatives ready for first-level modelling.",
    categoryKey: "preprocessing",
    estimatedRuntime: "6 – 24 hrs",
    requiredSourceKind: "dataset",
    requiredSourceArtifact: "bids_dataset",
    requiredSourceLabel: "Registered BIDS dataset with fMRI data",
    worstComputeProfile: "local-unsafe",
    computeWarning: "fMRIPrep is not laptop-safe. Use cloud or HPC if possible.",
    steps: [
      {
        pipelineId: "bids-validator",
        inputArtifactType: "bids_dataset",
        edge: {
          artifactType: "bids_dataset",
          acceptParam: "bids-dir",
          acceptDatasetSlot: false,
          acceptLabel: "BIDS Dataset",
        },
      },
      {
        pipelineId: "fmriprep",
        inputArtifactType: "bids_dataset_validated",
        edge: {
          artifactType: "bids_dataset_validated",
          acceptParam: null,
          acceptDatasetSlot: true,
          acceptLabel: "Validated BIDS Dataset",
        },
      },
    ],
  },

  // ── 3. Functional Connectivity Analysis ───────────────────────────────────
  // import-fmriprep-derivatives → functional-connectivity
  {
    id: "functional-connectivity-analysis",
    name: "Functional Connectivity Analysis",
    description:
      "Import precomputed fMRIPrep derivatives, then compute an atlas-based Pearson connectivity matrix.",
    categoryKey: "connectivity",
    estimatedRuntime: "minutes",
    requiredSourceKind: "dataset",
    requiredSourceArtifact: "bids_dataset",
    requiredSourceLabel: "Registered source BIDS dataset",
    worstComputeProfile: "local-ok",
    computeWarning:
      "Requires precomputed fMRIPrep derivatives. NeuroForge does not run fMRIPrep locally for this template.",
    steps: [
      {
        pipelineId: "import-fmriprep-derivatives",
        inputArtifactType: "bids_dataset",
        edge: {
          artifactType: "bids_dataset",
          acceptParam: null,
          acceptDatasetSlot: true,
          acceptLabel: "Associated BIDS Dataset",
        },
      },
      {
        pipelineId: "functional-connectivity",
        inputArtifactType: "fmriprep_derivatives",
        edge: {
          artifactType: "fmriprep_derivatives",
          acceptParam: "fmriprep-dir",
          acceptDatasetSlot: false,
          acceptLabel: "fMRIPrep Derivatives",
        },
      },
    ],
  },

  // ── 4. NIfTI De-identification ─────────────────────────────────────────────
  // pydeface (nifti_raw → nifti_defaced)
  {
    id: "nifti-deidentification",
    name: "NIfTI De-identification",
    description:
      "Remove facial features from structural NIfTI images with pydeface before sharing data publicly or with collaborators.",
    categoryKey: "deidentification",
    estimatedRuntime: "Varies per file",
    requiredSourceKind: "run",
    requiredSourceArtifact: "nifti_raw",
    requiredSourceLabel: "Completed run producing nifti_raw (e.g. dcm2niix)",
    worstComputeProfile: "local-unsafe",
    steps: [
      {
        pipelineId: "pydeface",
        inputArtifactType: "nifti_raw",
        edge: {
          artifactType: "nifti_raw",
          acceptParam: "nifti-file",
          acceptDatasetSlot: false,
          acceptLabel: "NIfTI",
        },
      },
    ],
  },

  // ── 5. Skull Strip + Surface Reconstruction ────────────────────────────────
  // brainchop (nifti_raw → nifti_skull_stripped) → fastsurfer (nifti_skull_stripped)
  {
    id: "skull-strip-surface",
    name: "Skull Strip + Segmentation",
    description:
      "Strip the skull from a T1w NIfTI with BrainChop, then reconstruct cortical surfaces and parcellations with FastSurfer.",
    categoryKey: "segmentation",
    estimatedRuntime: "10 min – 48 hrs",
    requiredSourceKind: "run",
    requiredSourceArtifact: "nifti_raw",
    requiredSourceLabel: "Completed run producing nifti_raw (e.g. dcm2niix)",
    worstComputeProfile: "local-slow",
    computeWarning: "FastSurfer can take 8–48 hrs under Docker on Apple Silicon.",
    steps: [
      {
        pipelineId: "brainchop",
        inputArtifactType: "nifti_raw",
        edge: {
          artifactType: "nifti_raw",
          acceptParam: "input-file",
          acceptDatasetSlot: false,
          acceptLabel: "T1w NIfTI",
        },
      },
      {
        pipelineId: "fastsurfer",
        inputArtifactType: "nifti_skull_stripped",
        edge: {
          artifactType: "nifti_skull_stripped",
          acceptParam: "t1",
          acceptDatasetSlot: false,
          acceptLabel: "Skull-Stripped T1w",
        },
      },
    ],
  },

  // ── 6. SynthStrip + Surface Reconstruction ────────────────────────────────
  // synthstrip (nifti_raw → nifti_skull_stripped) → fastsurfer (nifti_skull_stripped)
  // FreeSurfer-team chain: SynthStrip skull-strips, FastSurfer reconstructs surfaces.
  // Both tools originate from the Fischl lab; the stripped T1 feeds FastSurfer's --t1.
  {
    id: "synthstrip-surface",
    name: "SynthStrip + Segmentation",
    description:
      "Skull-strip a T1w NIfTI with FreeSurfer's SynthStrip (any contrast), then run FastSurfer for CNN segmentation and cortical surface reconstruction.",
    categoryKey: "segmentation",
    estimatedRuntime: "30 min – 50 hrs",
    requiredSourceKind: "run",
    requiredSourceArtifact: "nifti_raw",
    requiredSourceLabel: "Completed run producing nifti_raw (e.g. dcm2niix)",
    worstComputeProfile: "local-slow",
    computeWarning: "FastSurfer can take 8–48 hrs under Docker on Apple Silicon. SynthStrip adds ~5–15 min.",
    steps: [
      {
        pipelineId: "synthstrip",
        inputArtifactType: "nifti_raw",
        edge: {
          artifactType: "nifti_raw",
          acceptParam: "input",
          acceptDatasetSlot: false,
          acceptLabel: "Structural NIfTI",
        },
      },
      {
        pipelineId: "fastsurfer",
        inputArtifactType: "nifti_skull_stripped",
        edge: {
          artifactType: "nifti_skull_stripped",
          acceptParam: "t1",
          acceptDatasetSlot: false,
          acceptLabel: "Skull-Stripped T1w",
        },
      },
    ],
  },

  // ── 7. DICOM to Validated BIDS — coming later ─────────────────────────────
  // dcm2bids has `accepts: []` — no declared artifact input. The linear V1
  // builder cannot represent a raw DICOM folder as a source. Use the DICOM
  // Wizard (/wizard/dcm2bids) instead.
  {
    id: "dicom-to-bids",
    name: "DICOM to Validated BIDS",
    description:
      "Convert raw DICOM files to BIDS with dcm2bids, then validate the result.",
    categoryKey: "conversion",
    estimatedRuntime: "5 – 60 min",
    requiredSourceKind: "dataset",
    requiredSourceArtifact: "dicom",
    requiredSourceLabel: "Raw DICOM folder",
    worstComputeProfile: "local-ok",
    disabled: true,
    disabledReason:
      "Use the DICOM Wizard to convert DICOM. The workflow builder does not yet support raw DICOM as a source type.",
    steps: [],
  },
];
