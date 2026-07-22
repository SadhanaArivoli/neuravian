/**
 * Workflow serialization, deserialization, and schema validation.
 *
 * The persisted state is an opaque JSON blob stored in saved_workflows.state_json.
 * It captures the canvas plus durable node status/run/location fields so an
 * interrupted mixed-location execution can resume after an app restart. Large
 * resolved artifact payloads remain runtime-only and are reconstructed from runs.
 *
 * Schema version: "neuravian-workflow-v1"
 * Backward compat: only one version exists today. If the schema evolves, bump to
 * "neuravian-workflow-v2" and add a migration shim in deserializeWorkflowState.
 */

import type { ComputeProfile, PipelineCategory, PipelineProduceSlot } from "../api/client";

export const WORKFLOW_SCHEMA_VERSION = "neuravian-workflow-v1";
const DEFAULT_FUNCTIONAL_CONNECTIVITY_ATLAS = "schaefer100_7";

// ── Serializable types ────────────────────────────────────────────────────────

export type SourceKind = "dataset" | "run";

export interface SerializedSource {
  kind: SourceKind;
  datasetId: number | "";
  runId: number | "";
}

export interface SerializedEdge {
  artifactType: string;
  acceptParam: string | null;
  acceptDatasetSlot: boolean;
  acceptLabel: string | null;
}

export interface SerializedNode {
  id: string;
  pipelineId: string;
  displayName: string;
  category: PipelineCategory | null;
  computeProfile: ComputeProfile | null;
  inputArtifactType: string;
  produced: PipelineProduceSlot[];
  params: Record<string, unknown>;
  datasetId: number | "";
  edge: SerializedEdge;
  status?: "draft" | "ready" | "running" | "success" | "failed";
  runId?: number;
  executionLocation?: "Local" | "Cloud";
  error?: string;
}

export interface WorkflowState {
  schema_version: typeof WORKFLOW_SCHEMA_VERSION;
  source: SerializedSource;
  nodes: SerializedNode[];
  activeTemplateId: string | null;
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateWorkflowState(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["State must be a JSON object."] };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.schema_version !== WORKFLOW_SCHEMA_VERSION) {
    errors.push(
      `Unsupported schema version "${String(obj.schema_version ?? "missing")}". ` +
        `Expected "${WORKFLOW_SCHEMA_VERSION}".`,
    );
  }

  if (!obj.source || typeof obj.source !== "object") {
    errors.push("Missing or invalid source.");
  } else {
    const src = obj.source as Record<string, unknown>;
    if (src.kind !== "dataset" && src.kind !== "run") {
      errors.push(`source.kind must be "dataset" or "run", got "${String(src.kind)}".`);
    }
  }

  if (!Array.isArray(obj.nodes)) {
    errors.push("Missing or invalid nodes array.");
  } else {
    for (let i = 0; i < obj.nodes.length; i++) {
      const node = obj.nodes[i] as Record<string, unknown>;
      if (typeof node.pipelineId !== "string" || !node.pipelineId) {
        errors.push(`nodes[${i}].pipelineId is required.`);
      }
      if (!node.edge || typeof node.edge !== "object") {
        errors.push(`nodes[${i}].edge is required.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Serialization ─────────────────────────────────────────────────────────────

export interface BuilderRuntimeNode {
  id: string;
  pipelineId: string;
  displayName: string;
  category: PipelineCategory | null;
  computeProfile: ComputeProfile | null;
  inputArtifactType: string;
  produced: PipelineProduceSlot[];
  params: Record<string, unknown>;
  datasetId: number | "";
  edge: SerializedEdge;
  // Runtime fields present at builder time — stripped on save
  status?: "draft" | "ready" | "running" | "success" | "failed";
  runId?: number;
  error?: string;
  executionLocation?: "Local" | "Cloud";
  resolvedOutputs?: unknown;
}

export function serializeWorkflowState(
  source: SerializedSource,
  nodes: BuilderRuntimeNode[],
  activeTemplateId: string | null,
): WorkflowState {
  return {
    schema_version: WORKFLOW_SCHEMA_VERSION,
    source,
    nodes: nodes.map((n) => ({
      id: n.id,
      pipelineId: n.pipelineId,
      displayName: n.displayName,
      category: n.category,
      computeProfile: n.computeProfile,
      inputArtifactType: n.inputArtifactType,
      produced: n.produced,
      params: n.params,
      datasetId: n.datasetId,
      edge: n.edge,
      status: n.status,
      runId: n.runId,
      error: n.error,
      executionLocation: n.executionLocation,
    })),
    activeTemplateId,
  };
}

export function deserializeWorkflowState(raw: Record<string, unknown>): WorkflowState | null {
  const result = validateWorkflowState(raw);
  if (!result.valid) {
    console.warn("deserializeWorkflowState: invalid state", result.errors);
    return null;
  }
  const state = raw as unknown as WorkflowState;
  return {
    ...state,
    nodes: state.nodes.map((node) => {
      if (
        node.pipelineId !== "functional-connectivity" ||
        node.params["atlas-name"] !== undefined ||
        node.params.atlas !== undefined
      ) {
        return node;
      }
      return {
        ...node,
        params: {
          ...node.params,
          "atlas-name": DEFAULT_FUNCTIONAL_CONNECTIVITY_ATLAS,
        },
      };
    }),
  };
}

// ── Import / Export ───────────────────────────────────────────────────────────

export interface WorkflowExportEnvelope {
  export_format: "neuravian-workflow-export-v1";
  exported_at: string;
  name: string;
  description: string | null;
  tags: string[];
  state: WorkflowState;
}

export function buildExportEnvelope(
  name: string,
  description: string | null,
  tags: string[],
  state: WorkflowState,
): WorkflowExportEnvelope {
  return {
    export_format: "neuravian-workflow-export-v1",
    exported_at: new Date().toISOString(),
    name,
    description,
    tags,
    state,
  };
}

export interface ImportResult {
  valid: boolean;
  envelope?: WorkflowExportEnvelope;
  errors: string[];
}

export function parseWorkflowImport(jsonText: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { valid: false, errors: ["File is not valid JSON."] };
  }

  if (!parsed || typeof parsed !== "object") {
    return { valid: false, errors: ["File must be a JSON object."] };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.export_format !== "neuravian-workflow-export-v1") {
    return {
      valid: false,
      errors: [
        `Unrecognised export format "${String(obj.export_format ?? "missing")}". ` +
          `Expected "neuravian-workflow-export-v1".`,
      ],
    };
  }

  const stateValidation = validateWorkflowState(obj.state);
  if (!stateValidation.valid) {
    return { valid: false, errors: stateValidation.errors };
  }

  const name = typeof obj.name === "string" && obj.name ? obj.name : "Imported Workflow";
  const description = typeof obj.description === "string" ? obj.description : null;
  const tags = Array.isArray(obj.tags) ? (obj.tags as string[]).filter((t) => typeof t === "string") : [];

  return {
    valid: true,
    envelope: {
      export_format: "neuravian-workflow-export-v1",
      exported_at: typeof obj.exported_at === "string" ? obj.exported_at : new Date().toISOString(),
      name,
      description,
      tags,
      state: obj.state as WorkflowState,
    },
    errors: [],
  };
}

// ── Missing pipeline detection ─────────────────────────────────────────────────

export interface PipelineAvailability {
  pipelineId: string;
  displayName: string;
  available: boolean;
}

export function checkPipelineAvailability(
  nodes: SerializedNode[],
  availablePipelineIds: Set<string>,
): PipelineAvailability[] {
  return nodes.map((n) => ({
    pipelineId: n.pipelineId,
    displayName: n.displayName,
    available: availablePipelineIds.has(n.pipelineId),
  }));
}
