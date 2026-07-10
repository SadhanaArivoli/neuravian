import { describe, expect, it } from "vitest";
import {
  WORKFLOW_SCHEMA_VERSION,
  buildExportEnvelope,
  checkPipelineAvailability,
  deserializeWorkflowState,
  parseWorkflowImport,
  serializeWorkflowState,
  validateWorkflowState,
  type SerializedNode,
  type SerializedSource,
  type WorkflowState,
} from "../src/lib/workflowPersistence";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSource(overrides: Partial<SerializedSource> = {}): SerializedSource {
  return { kind: "dataset", datasetId: 1, runId: "", ...overrides };
}

function makeNode(overrides: Partial<SerializedNode> = {}): SerializedNode {
  return {
    id: "mriqc-1",
    pipelineId: "mriqc",
    displayName: "MRIQC",
    category: "quality_control",
    computeProfile: "local-ok",
    inputArtifactType: "bids_dataset_validated",
    produced: [{ type: "mriqc_report" }],
    params: { "nthreads": 4 },
    datasetId: 1,
    edge: {
      artifactType: "bids_dataset_validated",
      acceptParam: null,
      acceptDatasetSlot: true,
      acceptLabel: "Validated BIDS",
    },
    ...overrides,
  };
}

function makeValidState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    source: makeSource(),
    nodes: [makeNode()],
    activeTemplateId: null,
    ...overrides,
  };
}

// ── validateWorkflowState ─────────────────────────────────────────────────────

describe("validateWorkflowState", () => {
  it("accepts a valid state", () => {
    const result = validateWorkflowState(makeValidState());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects null", () => {
    const result = validateWorkflowState(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/JSON object/);
  });

  it("rejects wrong schema_version", () => {
    const result = validateWorkflowState({ ...makeValidState(), schema_version: "v0-old" as never });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/schema version/);
  });

  it("rejects missing source", () => {
    const { source: _source, ...rest } = makeValidState();
    const result = validateWorkflowState(rest);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/source/);
  });

  it("rejects invalid source.kind", () => {
    const state = { ...makeValidState(), source: { kind: "banana", datasetId: 1, runId: "" } };
    const result = validateWorkflowState(state);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/source\.kind/);
  });

  it("rejects nodes without pipelineId", () => {
    const state = makeValidState({ nodes: [{ ...makeNode(), pipelineId: "" }] });
    const result = validateWorkflowState(state);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/pipelineId/);
  });

  it("rejects node missing edge", () => {
    const { edge: _edge, ...nodeWithoutEdge } = makeNode();
    const state = makeValidState({ nodes: [nodeWithoutEdge as SerializedNode] });
    const result = validateWorkflowState(state);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/edge/);
  });

  it("rejects non-array nodes", () => {
    const state = { ...makeValidState(), nodes: "not-an-array" };
    const result = validateWorkflowState(state);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/nodes/);
  });

  it("accepts empty nodes array (blank workflow)", () => {
    const result = validateWorkflowState(makeValidState({ nodes: [] }));
    expect(result.valid).toBe(true);
  });

  it("accepts run source kind", () => {
    const result = validateWorkflowState(makeValidState({ source: makeSource({ kind: "run", runId: 5, datasetId: "" }) }));
    expect(result.valid).toBe(true);
  });
});

// ── serializeWorkflowState ────────────────────────────────────────────────────

describe("serializeWorkflowState", () => {
  it("produces a state with the correct schema version", () => {
    const state = serializeWorkflowState(makeSource(), [makeNode()], null);
    expect(state.schema_version).toBe(WORKFLOW_SCHEMA_VERSION);
  });

  it("strips runtime-only node fields", () => {
    const nodeWithRuntime = {
      ...makeNode(),
      status: "success" as const,
      runId: 42,
      error: "some error",
      resolvedOutputs: [{ type: "x", label: "x", description: "", resolved: true, multiple: false, resolution_source: "", paths: [], host_paths: [] }],
    };
    const state = serializeWorkflowState(makeSource(), [nodeWithRuntime], null);
    const serialized = state.nodes[0] as unknown as Record<string, unknown>;
    expect(serialized.status).toBeUndefined();
    expect(serialized.runId).toBeUndefined();
    expect(serialized.error).toBeUndefined();
    expect(serialized.resolvedOutputs).toBeUndefined();
  });

  it("preserves params, edge, produced, datasetId", () => {
    const node = makeNode({ params: { foo: "bar" }, datasetId: 7 });
    const state = serializeWorkflowState(makeSource(), [node], "bids-validation-qc");
    expect(state.nodes[0].params).toEqual({ foo: "bar" });
    expect(state.nodes[0].datasetId).toBe(7);
    expect(state.activeTemplateId).toBe("bids-validation-qc");
  });

  it("serializes multiple nodes in order", () => {
    const nodes = [makeNode({ id: "a", pipelineId: "p1" }), makeNode({ id: "b", pipelineId: "p2" })];
    const state = serializeWorkflowState(makeSource(), nodes, null);
    expect(state.nodes.map((n) => n.pipelineId)).toEqual(["p1", "p2"]);
  });

  it("handles empty nodes array", () => {
    const state = serializeWorkflowState(makeSource(), [], null);
    expect(state.nodes).toHaveLength(0);
  });
});

// ── deserializeWorkflowState ──────────────────────────────────────────────────

describe("deserializeWorkflowState", () => {
  it("returns a valid state unchanged", () => {
    const raw = makeValidState() as unknown as Record<string, unknown>;
    const result = deserializeWorkflowState(raw);
    expect(result).not.toBeNull();
    expect(result!.schema_version).toBe(WORKFLOW_SCHEMA_VERSION);
    expect(result!.nodes).toHaveLength(1);
  });

  it("returns null for invalid state", () => {
    const result = deserializeWorkflowState({ schema_version: "bad" } as Record<string, unknown>);
    expect(result).toBeNull();
  });

  it("round-trips a serialized state", () => {
    const source = makeSource();
    const nodes = [makeNode()];
    const serialized = serializeWorkflowState(source, nodes, "some-template");
    const deserialized = deserializeWorkflowState(serialized as unknown as Record<string, unknown>);
    expect(deserialized).not.toBeNull();
    expect(deserialized!.activeTemplateId).toBe("some-template");
    expect(deserialized!.source.datasetId).toBe(1);
    expect(deserialized!.nodes[0].pipelineId).toBe("mriqc");
  });
});

// ── buildExportEnvelope ───────────────────────────────────────────────────────

describe("buildExportEnvelope", () => {
  it("sets the correct export_format", () => {
    const state = makeValidState();
    const env = buildExportEnvelope("My WF", "desc", ["neuro", "qc"], state);
    expect(env.export_format).toBe("neuroforge-workflow-export-v1");
  });

  it("includes name, description, tags, state", () => {
    const state = makeValidState();
    const env = buildExportEnvelope("My WF", "desc", ["neuro"], state);
    expect(env.name).toBe("My WF");
    expect(env.description).toBe("desc");
    expect(env.tags).toEqual(["neuro"]);
    expect(env.state.schema_version).toBe(WORKFLOW_SCHEMA_VERSION);
  });

  it("sets exported_at to a valid ISO timestamp", () => {
    const env = buildExportEnvelope("x", null, [], makeValidState());
    expect(() => new Date(env.exported_at)).not.toThrow();
    expect(new Date(env.exported_at).getFullYear()).toBeGreaterThan(2020);
  });

  it("accepts null description", () => {
    const env = buildExportEnvelope("x", null, [], makeValidState());
    expect(env.description).toBeNull();
  });
});

// ── parseWorkflowImport ───────────────────────────────────────────────────────

describe("parseWorkflowImport", () => {
  function validEnvelopeJSON(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      export_format: "neuroforge-workflow-export-v1",
      exported_at: new Date().toISOString(),
      name: "Test WF",
      description: "A test",
      tags: ["neuro"],
      state: makeValidState(),
      ...overrides,
    });
  }

  it("accepts a valid envelope", () => {
    const result = parseWorkflowImport(validEnvelopeJSON());
    expect(result.valid).toBe(true);
    expect(result.envelope?.name).toBe("Test WF");
    expect(result.envelope?.tags).toEqual(["neuro"]);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects non-JSON text", () => {
    const result = parseWorkflowImport("not-json{{{{");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/JSON/);
  });

  it("rejects wrong export_format", () => {
    const result = parseWorkflowImport(validEnvelopeJSON({ export_format: "other-tool-v1" }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/export format/);
  });

  it("rejects invalid inner state", () => {
    const result = parseWorkflowImport(validEnvelopeJSON({ state: { schema_version: "v0" } }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("uses fallback name when name is missing", () => {
    const result = parseWorkflowImport(validEnvelopeJSON({ name: "" }));
    expect(result.valid).toBe(true);
    expect(result.envelope?.name).toBe("Imported Workflow");
  });

  it("filters non-string tags", () => {
    const result = parseWorkflowImport(validEnvelopeJSON({ tags: ["neuro", 42, null, "qc"] }));
    expect(result.valid).toBe(true);
    expect(result.envelope?.tags).toEqual(["neuro", "qc"]);
  });

  it("round-trips buildExportEnvelope output", () => {
    const state = makeValidState();
    const env = buildExportEnvelope("Round-trip", "desc", ["t1"], state);
    const result = parseWorkflowImport(JSON.stringify(env));
    expect(result.valid).toBe(true);
    expect(result.envelope?.name).toBe("Round-trip");
    expect(result.envelope?.state.nodes[0].pipelineId).toBe("mriqc");
  });
});

// ── checkPipelineAvailability ─────────────────────────────────────────────────

describe("checkPipelineAvailability", () => {
  it("marks all available when registry includes all pipeline IDs", () => {
    const nodes = [makeNode({ pipelineId: "mriqc" }), makeNode({ id: "bids-2", pipelineId: "bids-validator" })];
    const registry = new Set(["mriqc", "bids-validator"]);
    const result = checkPipelineAvailability(nodes, registry);
    expect(result.every((r) => r.available)).toBe(true);
  });

  it("marks missing pipelines as unavailable", () => {
    const nodes = [makeNode({ pipelineId: "mriqc" }), makeNode({ id: "old-2", pipelineId: "old-pipeline" })];
    const registry = new Set(["mriqc"]);
    const result = checkPipelineAvailability(nodes, registry);
    expect(result[0].available).toBe(true);
    expect(result[1].available).toBe(false);
    expect(result[1].pipelineId).toBe("old-pipeline");
  });

  it("returns empty array for empty nodes", () => {
    const result = checkPipelineAvailability([], new Set(["mriqc"]));
    expect(result).toHaveLength(0);
  });

  it("returns all unavailable when registry is empty", () => {
    const nodes = [makeNode(), makeNode({ id: "b", pipelineId: "synthstrip" })];
    const result = checkPipelineAvailability(nodes, new Set());
    expect(result.every((r) => !r.available)).toBe(true);
  });

  it("preserves displayName for user-facing messages", () => {
    const nodes = [makeNode({ displayName: "MRIQC Participant" })];
    const result = checkPipelineAvailability(nodes, new Set());
    expect(result[0].displayName).toBe("MRIQC Participant");
  });
});
