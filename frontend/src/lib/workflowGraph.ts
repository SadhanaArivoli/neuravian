/**
 * Pure graph-construction logic for the Workflow Graph Studio.
 *
 * Converts a flat list of RunSummary objects into a positioned DAG
 * using dagre for top-down auto-layout. No React dependencies here
 * so the functions are easy to unit-test.
 */

import Dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { ReportSummary, RunSummary } from "../api/client";

// ── Node dimensions ──────────────────────────────────────────────────────────

export const RUN_NODE_W = 220;
export const RUN_NODE_H = 128;
export const DATASET_NODE_W = 220;
export const DATASET_NODE_H = 64;

// ── Node data types ───────────────────────────────────────────────────────────

export interface RunNodeData extends Record<string, unknown> {
  kind: "run";
  run: RunSummary;
}

export interface DatasetNodeData extends Record<string, unknown> {
  kind: "dataset";
  datasetId: number;
  datasetName: string | null;
}
export interface ReportNodeData extends Record<string, unknown> { kind:"report"; report:ReportSummary; }

export type WorkflowNodeData = RunNodeData | DatasetNodeData | ReportNodeData;

// ── Edge removal result ────────────────────────────────────────────────────────

export interface BuildResult {
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  /** Number of back-edges removed to make the graph acyclic. */
  cyclesRemoved: number;
}

// ── Cycle detection (DFS-based) ───────────────────────────────────────────────

/**
 * Returns the set of edge keys (src→tgt) that must be removed to make the
 * directed graph acyclic. Uses iterative DFS with a recursion-stack set.
 */
function removeCycleEdges(
  nodeIds: string[],
  rawEdges: Array<{ source: string; target: string }>,
): Set<string> {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of rawEdges) {
    adj.get(e.source)?.push(e.target);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const badEdges = new Set<string>();

  function dfs(id: string, path: string[]) {
    visited.add(id);
    inStack.add(id);
    path.push(id);
    for (const next of adj.get(id) ?? []) {
      if (!visited.has(next)) {
        dfs(next, path);
      } else if (inStack.has(next)) {
        badEdges.add(`${id}→${next}`);
      }
    }
    inStack.delete(id);
    path.pop();
  }

  for (const id of nodeIds) {
    if (!visited.has(id)) dfs(id, []);
  }

  return badEdges;
}

// ── Edge color by target run status ──────────────────────────────────────────

export function edgeStroke(status: RunSummary["status"]): string {
  switch (status) {
    case "success": return "#22c55e";
    case "failed":  return "#ef4444";
    case "running": return "#f59e0b";
    default:        return "rgba(255,255,255,0.15)";
  }
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Builds a fully laid-out React Flow graph from a set of runs that all belong
 * to the same dataset.
 *
 * Edge direction is `source_run_id → run.id`. Runs with no `source_run_id`
 * (or whose source run is outside this set) connect to the dataset root node.
 *
 * Cycles are detected and the back-edges removed so dagre can produce a valid
 * layout; `cyclesRemoved` on the result tells the caller if any were found.
 */
export function buildWorkflowGraph(
  runs: RunSummary[],
  datasetId: number,
  datasetName: string | null,
  reports: ReportSummary[] = [],
): BuildResult {
  const dsId = `dataset-${datasetId}`;
  const runIdSet = new Set(runs.map((r) => r.id));

  // ── Raw edges (before cycle removal) ───────────────────────────────────────
  const rawEdges: Array<{ source: string; target: string; run: RunSummary }> =
    runs.map((run) => {
      const srcId =
        run.source_run_id !== null && runIdSet.has(run.source_run_id)
          ? `run-${run.source_run_id}`
          : dsId;
      return { source: srcId, target: `run-${run.id}`, run };
    });

  const childSources = new Set(runs.map(r=>r.source_run_id).filter((id): id is number=>id!==null));
  const leaves = runs.filter(r=>!childSources.has(r.id));
  for(const report of reports.filter(r=>r.status==="ready")) for(const leaf of leaves) rawEdges.push({source:`run-${leaf.id}`,target:`report-${report.id}`,run:leaf});
  const allNodeIds = [dsId, ...runs.map((r) => `run-${r.id}`), ...reports.filter(r=>r.status==="ready").map(r=>`report-${r.id}`)];
  const badEdgeKeys = removeCycleEdges(allNodeIds, rawEdges);
  const cyclesRemoved = badEdgeKeys.size;

  const safeEdges = rawEdges.filter(
    (e) => !badEdgeKeys.has(`${e.source}→${e.target}`),
  );

  // ── Dagre layout ─────────────────────────────────────────────────────────
  const g = new Dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 72, marginx: 24, marginy: 24 });

  g.setNode(dsId, { width: DATASET_NODE_W, height: DATASET_NODE_H });
  for (const run of runs) {
    g.setNode(`run-${run.id}`, { width: RUN_NODE_W, height: RUN_NODE_H });
  }
  for(const report of reports.filter(r=>r.status==="ready")) g.setNode(`report-${report.id}`,{width:RUN_NODE_W,height:DATASET_NODE_H});
  for (const e of safeEdges) {
    g.setEdge(e.source, e.target);
  }

  Dagre.layout(g);

  // ── React Flow nodes ──────────────────────────────────────────────────────
  const dsPos = g.node(dsId);
  const rfNodes: Node<WorkflowNodeData>[] = [
    {
      id: dsId,
      type: "datasetNode",
      position: {
        x: dsPos.x - DATASET_NODE_W / 2,
        y: dsPos.y - DATASET_NODE_H / 2,
      },
      data: { kind: "dataset", datasetId, datasetName },
    },
  ];

  for (const run of runs) {
    const nodeId = `run-${run.id}`;
    const pos = g.node(nodeId);
    rfNodes.push({
      id: nodeId,
      type: "runNode",
      position: {
        x: pos.x - RUN_NODE_W / 2,
        y: pos.y - RUN_NODE_H / 2,
      },
      data: { kind: "run", run },
    });
  }
  for(const report of reports.filter(r=>r.status==="ready")){const pos=g.node(`report-${report.id}`);rfNodes.push({id:`report-${report.id}`,type:"reportNode",position:{x:pos.x-RUN_NODE_W/2,y:pos.y-DATASET_NODE_H/2},data:{kind:"report",report}})}

  // ── React Flow edges ──────────────────────────────────────────────────────
  const rfEdges: Edge[] = safeEdges.map((e) => ({
    id: `e-${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    animated: e.run.status === "running",
    style: {
      stroke: edgeStroke(e.run.status),
      strokeWidth: 1.5,
    },
  }));

  return { nodes: rfNodes, edges: rfEdges, cyclesRemoved };
}

// ── Filter helpers ────────────────────────────────────────────────────────────

export type StatusFilter = "all" | RunSummary["status"];

export function filterRuns(
  runs: RunSummary[],
  status: StatusFilter,
  pipelineId: string,
  search: string,
): RunSummary[] {
  let out = runs;
  if (status !== "all") out = out.filter((r) => r.status === status);
  if (pipelineId) out = out.filter((r) => r.pipeline_manifest_id === pipelineId);
  const q = search.trim().toLowerCase();
  if (q) {
    out = out.filter(
      (r) =>
        String(r.id).includes(q) ||
        r.pipeline_manifest_id.toLowerCase().includes(q),
    );
  }
  return out;
}

// ── Unique pipeline IDs for the filter dropdown ──────────────────────────────

export function uniquePipelineIds(runs: RunSummary[]): string[] {
  return [...new Set(runs.map((r) => r.pipeline_manifest_id))].sort();
}
