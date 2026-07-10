import { describe, expect, it } from "vitest";
import type { RunMetadata } from "../src/api/client";
import {
  buildSoftwareTable,
  buildParamAppendix,
  generateMethodsParagraphs,
  generateMethodsSection,
  findReproducibilityConcerns,
  buildProvenanceExport,
  provenanceToYAML,
  exportMarkdown,
  buildWorkflowSVG,
} from "../src/lib/methodsEngine";
import type { Citation } from "../src/lib/citationRegistry";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<RunMetadata> & { run_id: number; pipeline_id: string }): RunMetadata {
  return {
    pipeline_display_name: null,
    pipeline_version: "24.0.0",
    status: "success",
    compute_profile: null,
    execution_type: "docker",
    container_image: "nipreps/mriqc:24.0.0",
    created_at: "2025-01-01T10:00:00Z",
    started_at: "2025-01-01T10:00:00Z",
    finished_at: "2025-01-01T10:30:00Z",
    runtime_seconds: 1800,
    dataset_id: 1,
    dataset_name: "sample-bids",
    dataset_path: "/data/sample-bids",
    output_dir: "/data/output",
    command_preview: null,
    params: {},
    lineage: null,
    ...overrides,
  };
}

// ── buildSoftwareTable ────────────────────────────────────────────────────────

describe("buildSoftwareTable", () => {
  it("deduplicates same pipeline/version", () => {
    const runs = [
      makeRun({ run_id: 1, pipeline_id: "mriqc", pipeline_version: "24.0.0" }),
      makeRun({ run_id: 2, pipeline_id: "mriqc", pipeline_version: "24.0.0" }),
    ];
    expect(buildSoftwareTable(runs)).toHaveLength(1);
  });

  it("keeps distinct pipeline/version combinations", () => {
    const runs = [
      makeRun({ run_id: 1, pipeline_id: "mriqc", pipeline_version: "24.0.0" }),
      makeRun({ run_id: 2, pipeline_id: "fmriprep", pipeline_version: "25.2.5", container_image: "nipreps/fmriprep:25.2.5" }),
    ];
    expect(buildSoftwareTable(runs)).toHaveLength(2);
  });

  it("marks versionComplete false when version is missing", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc", pipeline_version: "" })];
    expect(buildSoftwareTable(runs)[0].versionComplete).toBe(false);
  });

  it("records container image", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc", container_image: "nipreps/mriqc:24.0.0" })];
    expect(buildSoftwareTable(runs)[0].containerImage).toBe("nipreps/mriqc:24.0.0");
  });

  it("returns sorted by pipelineId", () => {
    const runs = [
      makeRun({ run_id: 2, pipeline_id: "synthstrip" }),
      makeRun({ run_id: 1, pipeline_id: "mriqc" }),
    ];
    const table = buildSoftwareTable(runs);
    expect(table[0].pipelineId).toBe("mriqc");
    expect(table[1].pipelineId).toBe("synthstrip");
  });
});

// ── buildParamAppendix ────────────────────────────────────────────────────────

describe("buildParamAppendix", () => {
  it("returns empty for runs with no params", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc", params: {} })];
    expect(buildParamAppendix(runs)).toHaveLength(0);
  });

  it("groups params by pipeline", () => {
    const runs = [
      makeRun({ run_id: 1, pipeline_id: "mriqc", params: { "no-sub": true } }),
      makeRun({ run_id: 2, pipeline_id: "synthstrip", params: { border: 1 } }),
    ];
    const groups = buildParamAppendix(runs);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.pipelineId === "mriqc")?.params).toMatchObject({ "no-sub": true });
  });

  it("merges params across runs of same pipeline", () => {
    const runs = [
      makeRun({ run_id: 1, pipeline_id: "mriqc", params: { "no-sub": true } }),
      makeRun({ run_id: 2, pipeline_id: "mriqc", params: { verbose: true } }),
    ];
    const groups = buildParamAppendix(runs);
    expect(groups[0].params).toMatchObject({ "no-sub": true, verbose: true });
    expect(groups[0].runIds).toEqual([1, 2]);
  });
});

// ── generateMethodsParagraphs ─────────────────────────────────────────────────

describe("generateMethodsParagraphs", () => {
  it("generates one paragraph per unique pipeline", () => {
    const runs = [
      makeRun({ run_id: 1, pipeline_id: "mriqc" }),
      makeRun({ run_id: 2, pipeline_id: "mriqc" }),
    ];
    expect(generateMethodsParagraphs(runs)).toHaveLength(1);
  });

  it("includes version in mriqc prose", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc", pipeline_version: "24.0.0" })];
    const paras = generateMethodsParagraphs(runs);
    expect(paras[0]).toContain("24.0.0");
  });

  it("includes atlas in functional-connectivity prose when recorded", () => {
    const runs = [
      makeRun({
        run_id: 1,
        pipeline_id: "functional-connectivity",
        params: { atlas: "Schaefer2018", "n-rois": 200 },
      }),
    ];
    expect(generateMethodsParagraphs(runs)[0]).toContain("Schaefer2018");
  });

  it("expands known functional-connectivity atlas ids to readable methods prose", () => {
    const runs = [
      makeRun({
        run_id: 1,
        pipeline_id: "functional-connectivity",
        params: { "atlas-name": "aal" },
      }),
    ];
    const paragraph = generateMethodsParagraphs(runs)[0];
    expect(paragraph).toContain("AAL3");
    expect(paragraph).toContain("166 ROIs");
  });

  it("uses generic prose for unknown pipelines", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "custom-tool", pipeline_version: "1.0" })];
    const paras = generateMethodsParagraphs(runs);
    expect(paras[0]).toContain("1.0");
  });

  it("does not invent values for missing version", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc", pipeline_version: "" })];
    const paras = generateMethodsParagraphs(runs);
    expect(paras[0]).toContain("Not recorded");
  });

  it("mentions border param for synthstrip when provided", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "synthstrip", params: { border: 2 } })];
    expect(generateMethodsParagraphs(runs)[0]).toContain("2");
  });
});

// ── generateMethodsSection ────────────────────────────────────────────────────

describe("generateMethodsSection", () => {
  it("includes NeuroForge preamble", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc" })];
    const section = generateMethodsSection(runs, null);
    expect(section).toContain("NeuroForge");
  });

  it("includes dataset name when provided", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc" })];
    const section = generateMethodsSection(runs, {
      id: 1, name: "My Study", path: "/data", bids_version: "1.7.0",
      subject_count: 30, validation_status: "valid", created_at: "", updated_at: "",
      indexed_metadata: null, validation_issues: null,
    });
    expect(section).toContain("My Study");
    expect(section).toContain("30 participants");
  });

  it("includes reproducibility closing statement", () => {
    const section = generateMethodsSection([], null);
    expect(section).toContain("provenance");
  });
});

// ── findReproducibilityConcerns ───────────────────────────────────────────────

describe("findReproducibilityConcerns", () => {
  it("flags missing version", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc", pipeline_version: "" })];
    const concerns = findReproducibilityConcerns(runs);
    expect(concerns.some((c) => c.level === "warning" && c.message.includes("version"))).toBe(true);
  });

  it("flags docker run without container image", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc", execution_type: "docker", container_image: null })];
    const concerns = findReproducibilityConcerns(runs);
    expect(concerns.some((c) => c.message.includes("container"))).toBe(true);
  });

  it("flags native execution as info", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc", execution_type: "native", container_image: null })];
    const concerns = findReproducibilityConcerns(runs);
    expect(concerns.some((c) => c.level === "info" && c.message.includes("native"))).toBe(true);
  });

  it("flags failed runs", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc", status: "failed" })];
    const concerns = findReproducibilityConcerns(runs);
    expect(concerns.some((c) => c.message.includes("not complete"))).toBe(true);
  });

  it("returns no concerns for clean runs", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc" })];
    expect(findReproducibilityConcerns(runs)).toHaveLength(0);
  });
});

// ── buildProvenanceExport ─────────────────────────────────────────────────────

describe("buildProvenanceExport", () => {
  it("includes schema field", () => {
    const prov = buildProvenanceExport([], null);
    expect(prov.schema).toBe("neuroforge-provenance-v1");
  });

  it("maps run fields correctly", () => {
    const runs = [makeRun({ run_id: 42, pipeline_id: "mriqc" })];
    const prov = buildProvenanceExport(runs, null);
    expect(prov.runs[0].run_id).toBe(42);
    expect(prov.runs[0].pipeline_id).toBe("mriqc");
  });

  it("includes dataset info when provided", () => {
    const prov = buildProvenanceExport([], {
      id: 1, name: "DS", path: "/data", bids_version: "1.7.0",
      subject_count: 5, validation_status: "valid", created_at: "", updated_at: "",
      indexed_metadata: null, validation_issues: null,
    });
    expect(prov.dataset?.name).toBe("DS");
  });
});

// ── provenanceToYAML ──────────────────────────────────────────────────────────

describe("provenanceToYAML", () => {
  it("produces valid YAML-like text with expected keys", () => {
    const prov = buildProvenanceExport(
      [makeRun({ run_id: 1, pipeline_id: "mriqc" })],
      null,
    );
    const yaml = provenanceToYAML(prov);
    expect(yaml).toContain("schema:");
    expect(yaml).toContain("runs:");
    expect(yaml).toContain("pipeline_id: mriqc");
  });
});

// ── exportMarkdown ────────────────────────────────────────────────────────────

describe("exportMarkdown", () => {
  const mockCitation: Citation = {
    key: "mriqc",
    tool: "MRIQC",
    pipelineIds: ["mriqc"],
    authors: "Esteban O, Gorgolewski KJ",
    year: 2017,
    title: "MRIQC",
    journal: "PLOS ONE",
    doi: "10.1371/journal.pone.0184661",
    rrid: "SCR_022942",
  };

  it("includes Methods heading", () => {
    const md = exportMarkdown({
      methodsSection: "test methods",
      citations: [mockCitation],
      softwareTable: [],
      paramGroups: [],
      concerns: [],
      datasetName: "DS",
    });
    expect(md).toContain("## Methods");
  });

  it("includes software table header", () => {
    const md = exportMarkdown({
      methodsSection: "",
      citations: [],
      softwareTable: [{ pipelineId: "mriqc", displayName: "MRIQC", version: "24.0.0", containerImage: null, executionType: "docker", citationKey: "mriqc", versionComplete: true }],
      paramGroups: [],
      concerns: [],
      datasetName: "DS",
    });
    expect(md).toContain("| Software |");
    expect(md).toContain("MRIQC");
  });

  it("includes references", () => {
    const md = exportMarkdown({
      methodsSection: "",
      citations: [mockCitation],
      softwareTable: [],
      paramGroups: [],
      concerns: [],
      datasetName: "DS",
    });
    expect(md).toContain("## References");
    expect(md).toContain("10.1371/journal.pone.0184661");
  });

  it("includes parameter appendix when params exist", () => {
    const md = exportMarkdown({
      methodsSection: "",
      citations: [],
      softwareTable: [],
      paramGroups: [{ pipelineId: "mriqc", displayName: "MRIQC", runIds: [1], params: { "no-sub": true } }],
      concerns: [],
      datasetName: "DS",
    });
    expect(md).toContain("Parameters Appendix");
    expect(md).toContain("--no-sub");
  });
});

// ── buildWorkflowSVG ──────────────────────────────────────────────────────────

describe("buildWorkflowSVG", () => {
  it("returns empty string for no runs", () => {
    expect(buildWorkflowSVG([], "DS")).toBe("");
  });

  it("produces SVG element", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc" })];
    const svg = buildWorkflowSVG(runs, "test-dataset");
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("includes pipeline name in SVG", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc", pipeline_display_name: "MRIQC" })];
    const svg = buildWorkflowSVG(runs, "DS");
    expect(svg).toContain("MRIQC");
  });

  it("includes dataset node", () => {
    const runs = [makeRun({ run_id: 1, pipeline_id: "mriqc" })];
    const svg = buildWorkflowSVG(runs, "My Dataset");
    expect(svg).toContain("My Dataset");
  });
});
