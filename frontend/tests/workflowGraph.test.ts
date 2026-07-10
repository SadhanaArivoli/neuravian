import { describe, expect, it } from "vitest";
import type { RunSummary } from "../src/api/client";
import {
  buildWorkflowGraph,
  edgeStroke,
  filterRuns,
  uniquePipelineIds,
} from "../src/lib/workflowGraph";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeRun(
  overrides: Partial<RunSummary> & { id: number },
): RunSummary {
  return {
    pipeline_manifest_id: "mriqc",
    pipeline_version: "24.0.0",
    dataset_id: 1,
    status: "success",
    source_run_id: null,
    remote_host_id: null,
    started_at: null,
    finished_at: null,
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── buildWorkflowGraph: node count ──────────────────────────────────────────

describe("buildWorkflowGraph — nodes", () => {
  it("creates one dataset node + one run node for a single run", () => {
    const run = makeRun({ id: 1 });
    const { nodes } = buildWorkflowGraph([run], 1, "TestDS");
    expect(nodes).toHaveLength(2);
    expect(nodes.some((n) => n.id === "dataset-1")).toBe(true);
    expect(nodes.some((n) => n.id === "run-1")).toBe(true);
  });

  it("creates dataset node + N run nodes for N runs", () => {
    const runs = [
      makeRun({ id: 10 }),
      makeRun({ id: 20 }),
      makeRun({ id: 30 }),
    ];
    const { nodes } = buildWorkflowGraph(runs, 5, null);
    expect(nodes).toHaveLength(4); // 3 runs + 1 dataset
  });

  it("produces an empty graph (only dataset node) for zero runs", () => {
    const { nodes, edges } = buildWorkflowGraph([], 99, "Empty");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("dataset-99");
    expect(edges).toHaveLength(0);
  });
});

// ── buildWorkflowGraph: edge direction ───────────────────────────────────────

describe("buildWorkflowGraph — edges", () => {
  it("connects orphan run (null source_run_id) to dataset node", () => {
    const run = makeRun({ id: 5, source_run_id: null });
    const { edges } = buildWorkflowGraph([run], 1, "DS");
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("dataset-1");
    expect(edges[0].target).toBe("run-5");
  });

  it("connects run to its upstream run when source_run_id is in the set", () => {
    const parent = makeRun({ id: 1 });
    const child = makeRun({ id: 2, source_run_id: 1 });
    const { edges } = buildWorkflowGraph([parent, child], 1, "DS");
    // parent → dataset, child → parent
    const childEdge = edges.find((e) => e.target === "run-2");
    expect(childEdge?.source).toBe("run-1");
  });

  it("connects run to dataset when source_run_id references a run outside the set", () => {
    const run = makeRun({ id: 7, source_run_id: 999 }); // 999 not in set
    const { edges } = buildWorkflowGraph([run], 1, "DS");
    expect(edges[0].source).toBe("dataset-1");
  });

  it("parallel branches both connect to shared parent", () => {
    const parent = makeRun({ id: 1 });
    const branchA = makeRun({ id: 2, source_run_id: 1, pipeline_manifest_id: "brainchop" });
    const branchB = makeRun({ id: 3, source_run_id: 1, pipeline_manifest_id: "synthstrip" });
    const { edges } = buildWorkflowGraph([parent, branchA, branchB], 1, "DS");
    const edgesFromRun1 = edges.filter((e) => e.source === "run-1");
    expect(edgesFromRun1).toHaveLength(2);
    const targets = edgesFromRun1.map((e) => e.target).sort();
    expect(targets).toEqual(["run-2", "run-3"]);
  });
});

// ── buildWorkflowGraph: cycle prevention ─────────────────────────────────────

describe("buildWorkflowGraph — cycle prevention", () => {
  it("removes back-edges to prevent cycles and reports cyclesRemoved > 0", () => {
    // Artificial cycle: 1→2, 2→3, 3→1
    const a = makeRun({ id: 1, source_run_id: 3 });
    const b = makeRun({ id: 2, source_run_id: 1 });
    const c = makeRun({ id: 3, source_run_id: 2 });
    const { cyclesRemoved, nodes, edges } = buildWorkflowGraph([a, b, c], 1, "DS");
    expect(cyclesRemoved).toBeGreaterThan(0);
    // Must still produce layout-able node set
    expect(nodes.length).toBeGreaterThan(0);
    // Should not throw (dagre would throw/hang on a cycle)
    expect(edges.length).toBeGreaterThan(0);
  });

  it("reports cyclesRemoved === 0 for a clean DAG", () => {
    const runs = [
      makeRun({ id: 1 }),
      makeRun({ id: 2, source_run_id: 1 }),
      makeRun({ id: 3, source_run_id: 1 }),
    ];
    const { cyclesRemoved } = buildWorkflowGraph(runs, 1, "DS");
    expect(cyclesRemoved).toBe(0);
  });
});

// ── buildWorkflowGraph: node positions ───────────────────────────────────────

describe("buildWorkflowGraph — layout", () => {
  it("assigns numeric x/y positions to all nodes", () => {
    const runs = [makeRun({ id: 1 }), makeRun({ id: 2, source_run_id: 1 })];
    const { nodes } = buildWorkflowGraph(runs, 1, "DS");
    for (const node of nodes) {
      expect(typeof node.position.x).toBe("number");
      expect(typeof node.position.y).toBe("number");
    }
  });

  it("dataset node is above its child runs (lower y-coordinate)", () => {
    const child = makeRun({ id: 1 });
    const { nodes } = buildWorkflowGraph([child], 1, "DS");
    const dsNode = nodes.find((n) => n.id === "dataset-1")!;
    const runNode = nodes.find((n) => n.id === "run-1")!;
    expect(dsNode.position.y).toBeLessThan(runNode.position.y);
  });
});

// ── edgeStroke ────────────────────────────────────────────────────────────────

describe("edgeStroke", () => {
  it("returns green for success", () => {
    expect(edgeStroke("success")).toMatch(/22c55e/i);
  });
  it("returns red for failed", () => {
    expect(edgeStroke("failed")).toMatch(/ef4444/i);
  });
  it("returns amber for running", () => {
    expect(edgeStroke("running")).toMatch(/f59e0b/i);
  });
  it("returns muted for pending", () => {
    const color = edgeStroke("pending");
    // Should be semi-transparent, not a saturated color
    expect(color).toMatch(/rgba|white/i);
  });
});

// ── filterRuns ────────────────────────────────────────────────────────────────

describe("filterRuns", () => {
  const runs = [
    makeRun({ id: 1, status: "success", pipeline_manifest_id: "mriqc" }),
    makeRun({ id: 2, status: "failed",  pipeline_manifest_id: "mriqc" }),
    makeRun({ id: 3, status: "running", pipeline_manifest_id: "brainchop" }),
    makeRun({ id: 4, status: "pending", pipeline_manifest_id: "synthstrip" }),
  ];

  it("returns all runs when status=all, no pipeline filter, no search", () => {
    expect(filterRuns(runs, "all", "", "")).toHaveLength(4);
  });

  it("filters by status=success", () => {
    const out = filterRuns(runs, "success", "", "");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(1);
  });

  it("filters by pipeline id", () => {
    const out = filterRuns(runs, "all", "mriqc", "");
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("filters by run id search string", () => {
    const out = filterRuns(runs, "all", "", "3");
    expect(out.some((r) => r.id === 3)).toBe(true);
  });

  it("filters by pipeline name search string (case-insensitive)", () => {
    const out = filterRuns(runs, "all", "", "brain");
    expect(out).toHaveLength(1);
    expect(out[0].pipeline_manifest_id).toBe("brainchop");
  });

  it("combines status and pipeline filters", () => {
    const out = filterRuns(runs, "failed", "mriqc", "");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2);
  });

  it("returns empty array when no runs match", () => {
    expect(filterRuns(runs, "success", "synthstrip", "")).toHaveLength(0);
  });
});

// ── uniquePipelineIds ─────────────────────────────────────────────────────────

describe("uniquePipelineIds", () => {
  it("returns unique sorted pipeline IDs", () => {
    const runs = [
      makeRun({ id: 1, pipeline_manifest_id: "mriqc" }),
      makeRun({ id: 2, pipeline_manifest_id: "brainchop" }),
      makeRun({ id: 3, pipeline_manifest_id: "mriqc" }),
    ];
    expect(uniquePipelineIds(runs)).toEqual(["brainchop", "mriqc"]);
  });

  it("returns empty array for no runs", () => {
    expect(uniquePipelineIds([])).toEqual([]);
  });
});
