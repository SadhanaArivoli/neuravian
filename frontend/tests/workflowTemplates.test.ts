import { describe, expect, it } from "vitest";
import {
  WORKFLOW_TEMPLATES,
  isNiftiRawRun,
  validateTemplateEdges,
  type ManifestSlim,
  type WorkflowTemplate,
} from "../src/lib/workflowTemplates";

// ── Mock manifests ────────────────────────────────────────────────────────────
// Mirrors the real manifest accepts/produces slots. Update if manifests change.

const MANIFESTS: Record<string, ManifestSlim> = {
  "bids-validator": {
    id: "bids-validator",
    accepts: [{ type: "bids_dataset", param: "bids-dir" }],
    produces: [{ type: "bids_dataset_validated" }],
  },
  mriqc: {
    id: "mriqc",
    accepts: [
      { type: "bids_dataset", dataset_slot: true },
      { type: "bids_dataset_validated", dataset_slot: true },
    ],
    produces: [{ type: "mriqc_report" }],
  },
  fmriprep: {
    id: "fmriprep",
    accepts: [
      { type: "bids_dataset", dataset_slot: true },
      { type: "bids_dataset_validated", dataset_slot: true },
    ],
    produces: [{ type: "fmriprep_derivatives" }],
  },
  fastsurfer: {
    id: "fastsurfer",
    accepts: [
      { type: "nifti_raw", param: "t1" },
      { type: "nifti_skull_stripped", param: "t1" },
    ],
    produces: [{ type: "freesurfer_dir" }],
  },
  brainchop: {
    id: "brainchop",
    accepts: [{ type: "nifti_raw", param: "input-file" }],
    produces: [{ type: "nifti_skull_stripped" }],
  },
  pydeface: {
    id: "pydeface",
    accepts: [{ type: "nifti_raw", param: "nifti-file" }],
    produces: [{ type: "nifti_defaced" }],
  },
};

// ── Valid templates ───────────────────────────────────────────────────────────

describe("WORKFLOW_TEMPLATES — all live templates pass validation", () => {
  const liveTemplates = WORKFLOW_TEMPLATES.filter((t) => !t.disabled);

  it("there are at least 4 live templates", () => {
    expect(liveTemplates.length).toBeGreaterThanOrEqual(4);
  });

  for (const template of liveTemplates) {
    it(`"${template.name}" has valid edges`, () => {
      const result = validateTemplateEdges(template, MANIFESTS);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  }
});

describe("validateTemplateEdges — known invalid chains are rejected", () => {
  // ── MRIQC → FastSurfer ────────────────────────────────────────────────────
  // mriqc produces "mriqc_report"; fastsurfer needs "nifti_raw" or "nifti_skull_stripped"
  it("rejects MRIQC → FastSurfer (mriqc_report ≠ nifti_raw)", () => {
    const broken: WorkflowTemplate = {
      id: "test-mriqc-fastsurfer",
      name: "Broken: MRIQC → FastSurfer",
      description: "",
      categoryKey: "unknown",
      estimatedRuntime: "",
      requiredSourceKind: "dataset",
      requiredSourceArtifact: "bids_dataset",
      requiredSourceLabel: "",
      worstComputeProfile: "local-ok",
      steps: [
        {
          pipelineId: "bids-validator",
          inputArtifactType: "bids_dataset",
          edge: { artifactType: "bids_dataset", acceptParam: "bids-dir", acceptDatasetSlot: false, acceptLabel: null },
        },
        {
          pipelineId: "mriqc",
          inputArtifactType: "bids_dataset_validated",
          edge: { artifactType: "bids_dataset_validated", acceptParam: null, acceptDatasetSlot: true, acceptLabel: null },
        },
        {
          // fastsurfer expects nifti_raw or nifti_skull_stripped, not mriqc_report
          pipelineId: "fastsurfer",
          inputArtifactType: "mriqc_report",
          edge: { artifactType: "mriqc_report", acceptParam: "t1", acceptDatasetSlot: false, acceptLabel: null },
        },
      ],
    };
    const result = validateTemplateEdges(broken, MANIFESTS);
    expect(result.valid).toBe(false);
    // Step 2 (fastsurfer) should fail: fastsurfer doesn't accept mriqc_report
    const step2Errors = result.errors.filter((e) => e.step === 2);
    expect(step2Errors.length).toBeGreaterThan(0);
  });

  // ── MRIQC → fMRIPrep ─────────────────────────────────────────────────────
  // mriqc produces "mriqc_report"; fmriprep needs "bids_dataset_validated"
  it("rejects MRIQC → fMRIPrep (mriqc_report ≠ bids_dataset_validated)", () => {
    const broken: WorkflowTemplate = {
      id: "test-mriqc-fmriprep",
      name: "Broken: MRIQC → fMRIPrep",
      description: "",
      categoryKey: "unknown",
      estimatedRuntime: "",
      requiredSourceKind: "dataset",
      requiredSourceArtifact: "bids_dataset",
      requiredSourceLabel: "",
      worstComputeProfile: "local-ok",
      steps: [
        {
          pipelineId: "mriqc",
          inputArtifactType: "bids_dataset",
          edge: { artifactType: "bids_dataset", acceptParam: null, acceptDatasetSlot: true, acceptLabel: null },
        },
        {
          // fmriprep needs bids_dataset_validated, not mriqc_report
          pipelineId: "fmriprep",
          inputArtifactType: "mriqc_report",
          edge: { artifactType: "mriqc_report", acceptParam: null, acceptDatasetSlot: true, acceptLabel: null },
        },
      ],
    };
    const result = validateTemplateEdges(broken, MANIFESTS);
    expect(result.valid).toBe(false);
    // fmriprep doesn't accept mriqc_report, and mriqc doesn't produce it for chaining
    const step1Errors = result.errors.filter((e) => e.step === 1);
    expect(step1Errors.length).toBeGreaterThan(0);
  });

  // ── Missing pipeline ID ───────────────────────────────────────────────────
  it("rejects a template with a non-existent pipeline ID", () => {
    const broken: WorkflowTemplate = {
      id: "test-missing-pipeline",
      name: "Broken: missing pipeline",
      description: "",
      categoryKey: "unknown",
      estimatedRuntime: "",
      requiredSourceKind: "dataset",
      requiredSourceArtifact: "bids_dataset",
      requiredSourceLabel: "",
      worstComputeProfile: "local-ok",
      steps: [
        {
          pipelineId: "nonexistent-pipeline",
          inputArtifactType: "bids_dataset",
          edge: { artifactType: "bids_dataset", acceptParam: null, acceptDatasetSlot: false, acceptLabel: null },
        },
      ],
    };
    const result = validateTemplateEdges(broken, MANIFESTS);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("not found in manifest registry");
  });

  // ── Source artifact mismatch ──────────────────────────────────────────────
  it("rejects a template whose first step expects a different artifact than the source exposes", () => {
    const broken: WorkflowTemplate = {
      id: "test-source-mismatch",
      name: "Broken: source mismatch",
      description: "",
      categoryKey: "unknown",
      estimatedRuntime: "",
      requiredSourceKind: "run",
      // Template says source produces nifti_raw ...
      requiredSourceArtifact: "nifti_raw",
      requiredSourceLabel: "",
      worstComputeProfile: "local-ok",
      steps: [
        {
          pipelineId: "bids-validator",
          inputArtifactType: "bids_dataset",
          // ... but first step declares bids_dataset — mismatch
          edge: { artifactType: "bids_dataset", acceptParam: "bids-dir", acceptDatasetSlot: false, acceptLabel: null },
        },
      ],
    };
    const result = validateTemplateEdges(broken, MANIFESTS);
    expect(result.valid).toBe(false);
    const sourceErrors = result.errors.filter((e) => e.message.includes("template source exposes"));
    expect(sourceErrors.length).toBeGreaterThan(0);
  });

  // ── Disabled template with empty steps passes ─────────────────────────────
  it("passes validation for disabled (coming-soon) templates with no steps", () => {
    const disabled = WORKFLOW_TEMPLATES.find((t) => t.disabled);
    expect(disabled).toBeDefined();
    const result = validateTemplateEdges(disabled!, MANIFESTS);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── isNiftiRawRun ─────────────────────────────────────────────────────────────

describe("isNiftiRawRun", () => {
  it("returns true for dcm2niix runs", () => {
    expect(isNiftiRawRun({ pipeline_manifest_id: "dcm2niix" })).toBe(true);
  });

  it("returns false for mriqc runs", () => {
    expect(isNiftiRawRun({ pipeline_manifest_id: "mriqc" })).toBe(false);
  });

  it("returns false for bids-validator runs", () => {
    expect(isNiftiRawRun({ pipeline_manifest_id: "bids-validator" })).toBe(false);
  });

  it("returns false for brainchop runs (produces nifti_skull_stripped, not nifti_raw)", () => {
    expect(isNiftiRawRun({ pipeline_manifest_id: "brainchop" })).toBe(false);
  });
});
