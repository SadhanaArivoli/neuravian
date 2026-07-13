import { describe, expect, it } from "vitest";
import {
  WORKFLOW_TEMPLATES,
  filterRunsByArtifact,
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
  "mriqc-group": {
    id: "mriqc-group",
    accepts: [{ type: "mriqc_report", param: "upstream-mriqc-dir" }],
    produces: [{ type: "mriqc_group_report" }],
  },
  fmriprep: {
    id: "fmriprep",
    accepts: [
      { type: "bids_dataset", dataset_slot: true },
      { type: "bids_dataset_validated", dataset_slot: true },
    ],
    produces: [{ type: "fmriprep_derivatives" }],
  },
  "import-fmriprep-derivatives": {
    id: "import-fmriprep-derivatives",
    accepts: [{ type: "bids_dataset", dataset_slot: true }],
    produces: [{ type: "fmriprep_derivatives" }],
  },
  "functional-connectivity": {
    id: "functional-connectivity",
    accepts: [{ type: "fmriprep_derivatives", param: "fmriprep-dir" }],
    produces: [
      { type: "connectivity_matrix_csv" },
      { type: "connectivity_matrix_png" },
      { type: "connectivity_matrix_npy" },
      { type: "timeseries_tsv" },
      { type: "roi_statistics_csv" },
      { type: "roi_statistics_json" },
      { type: "connectivity_report_html" },
    ],
  },
  "alff-falff": { id: "alff-falff", accepts: [{type:"fmriprep_derivatives",param:"fmriprep-dir"}], produces: [{type:"alff_map_nii"},{type:"falff_map_nii"}] },
  "seed-based-connectivity": { id: "seed-based-connectivity", accepts: [{type:"fmriprep_derivatives",param:"fmriprep-dir"}], produces: [{type:"seed_connectivity_map_nii"}] },
  "regional-homogeneity": { id: "regional-homogeneity", accepts: [{type:"fmriprep_derivatives",param:"fmriprep-dir"}], produces: [{type:"reho_map_nii"},{type:"reho_normalized_map_nii"}] },
  "statistical-map-explorer": { id: "statistical-map-explorer", accepts: [{type:"seed_connectivity_map_nii",param:"input-file"},{type:"alff_map_nii",param:"input-file"},{type:"reho_map_nii",param:"input-file"}], produces: [{type:"statistical_map_thresholded"}] },
  "atlas-roi-extraction": { id: "atlas-roi-extraction", accepts: [{type:"nifti_skull_stripped",param:"input-file"},{type:"alff_map_nii",param:"input-file"},{type:"reho_map_nii",param:"input-file"}], produces: [{type:"roi_extraction_csv"}] },
  "connectome-graph-analysis": { id: "connectome-graph-analysis", accepts: [{type:"connectivity_matrix_npy",param:"input-matrix"},{type:"connectivity_matrix_csv",param:"input-matrix"}], produces: [{type:"graph_metrics_json"}] },
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
  synthstrip: {
    id: "synthstrip",
    accepts: [{ type: "nifti_raw", param: "input" }],
    produces: [{ type: "nifti_skull_stripped" }, { type: "brain_mask" }],
  },
};

// ── Valid templates ───────────────────────────────────────────────────────────

describe("WORKFLOW_TEMPLATES — all live templates pass validation", () => {
  const liveTemplates = WORKFLOW_TEMPLATES.filter((t) => !t.disabled);

  it("there are at least 5 live templates", () => {
    expect(liveTemplates.length).toBeGreaterThanOrEqual(5);
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

  // ── SynthStrip → FastSurfer chain ────────────────────────────────────────
  // synthstrip: nifti_raw → nifti_skull_stripped; fastsurfer: nifti_skull_stripped → freesurfer_dir
  it("accepts SynthStrip → FastSurfer (nifti_raw → nifti_skull_stripped → freesurfer_dir)", () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.id === "synthstrip-surface");
    expect(template).toBeDefined();
    const result = validateTemplateEdges(template!, MANIFESTS);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
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

// ── filterRunsByArtifact ──────────────────────────────────────────────────────
// Qualification is driven by the pipeline's declared produces[], not by a
// hardcoded pipeline-ID allowlist.  A run from any pipeline whose manifest
// declares the required artifact type should qualify automatically.

const PRODUCES_CACHE: Record<string, string[]> = {
  "dcm2niix":       ["nifti_raw"],
  "brainchop":      ["nifti_skull_stripped"],
  "synthstrip":     ["nifti_skull_stripped", "brain_mask"],
  "mriqc":          ["mriqc_report"],
  "mriqc-group":    ["mriqc_group_report"],
  "import-fmriprep-derivatives": ["fmriprep_derivatives"],
  "functional-connectivity": ["connectivity_matrix_csv", "connectivity_matrix_png"],
  "bids-validator": ["bids_dataset_validated"],
  // Hypothetical future pipeline — not dcm2niix, but also produces nifti_raw
  "dicom-custom":   ["nifti_raw", "nifti_defaced"],
};

const RUNS = [
  { id: 1, pipeline_manifest_id: "dcm2niix" },
  { id: 2, pipeline_manifest_id: "mriqc" },
  { id: 3, pipeline_manifest_id: "bids-validator" },
  { id: 4, pipeline_manifest_id: "brainchop" },
  { id: 5, pipeline_manifest_id: "dicom-custom" },
  { id: 6, pipeline_manifest_id: "import-fmriprep-derivatives" },
];

describe("filterRunsByArtifact", () => {
  it("returns dcm2niix run for nifti_raw requirement", () => {
    const result = filterRunsByArtifact(RUNS, "nifti_raw", PRODUCES_CACHE);
    expect(result.map((r) => r.id)).toContain(1);
  });

  it("returns a hypothetical non-dcm2niix run that also produces nifti_raw", () => {
    const result = filterRunsByArtifact(RUNS, "nifti_raw", PRODUCES_CACHE);
    // Both dcm2niix (id=1) and dicom-custom (id=5) produce nifti_raw
    expect(result.map((r) => r.id)).toContain(5);
  });

  it("excludes mriqc runs from nifti_raw filter (mriqc produces mriqc_report)", () => {
    const result = filterRunsByArtifact(RUNS, "nifti_raw", PRODUCES_CACHE);
    expect(result.map((r) => r.id)).not.toContain(2);
  });

  it("excludes brainchop runs from nifti_raw filter (brainchop produces nifti_skull_stripped)", () => {
    const result = filterRunsByArtifact(RUNS, "nifti_raw", PRODUCES_CACHE);
    expect(result.map((r) => r.id)).not.toContain(4);
  });

  it("returns empty array when no runs match the required artifact", () => {
    const result = filterRunsByArtifact(RUNS, "freesurfer_dir", PRODUCES_CACHE);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when pipelineProducesMap is empty (cache not yet populated)", () => {
    const result = filterRunsByArtifact(RUNS, "nifti_raw", {});
    expect(result).toHaveLength(0);
  });
});
