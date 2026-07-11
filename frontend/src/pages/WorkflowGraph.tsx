/**
 * Workflow Graph Studio
 *
 * Visual DAG of every analysis run for a dataset.
 * Edges derived from `source_run_id` — no invented lineage.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { RunSummary } from "../api/client";
import { useDataset } from "../hooks/useDatasets";
import { useRunResults, useRuns } from "../hooks/useRuns";
import {
  buildWorkflowGraph,
  filterRuns,
  uniquePipelineIds,
  type DatasetNodeData,
  type RunNodeData,
  type StatusFilter,
} from "../lib/workflowGraph";

// ── Category metadata (2-letter code + colour) ───────────────────────────────

const CAT_META: Record<string, { icon: string; color: string }> = {
  conversion:       { icon: "CV", color: "text-cyan-300"   },
  validation:       { icon: "VA", color: "text-green-300"  },
  quality_control:  { icon: "QC", color: "text-amber-300"  },
  segmentation:     { icon: "SG", color: "text-violet-300" },
  preprocessing:    { icon: "PR", color: "text-orange-300" },
  deidentification: { icon: "DI", color: "text-red-300"    },
  connectivity:     { icon: "CN", color: "text-sky-300"    },
};

function catMeta(id: string) {
  return CAT_META[id] ?? { icon: id.slice(0, 2).toUpperCase(), color: "text-gray-400" };
}

// ── Status helpers ─────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  success: "border-green-600  bg-green-900/20 shadow-green-900/20",
  failed:  "border-red-600    bg-red-900/20   shadow-red-900/20",
  running: "border-amber-500  bg-amber-900/20 workflow-node-running",
  pending: "border-white/15   bg-white/[0.03]",
};

const STATUS_BADGE: Record<string, string> = {
  success: "bg-green-900/60 text-green-300 border-green-700",
  failed:  "bg-red-900/60   text-red-300   border-red-700",
  running: "bg-amber-900/60 text-amber-300 border-amber-700",
  pending: "bg-white/5      text-gray-400  border-white/10",
};

function parseUtc(iso: string): Date {
  return new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return parseUtc(iso).toLocaleString(undefined, {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function runtime(run: RunSummary): string | null {
  if (!run.started_at || !run.finished_at) return null;
  const s = Math.round(
    (parseUtc(run.finished_at).getTime() - parseUtc(run.started_at).getTime()) / 1000,
  );
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── Custom Run Node ───────────────────────────────────────────────────────────

function RunNode({ data, selected }: NodeProps) {
  const { run } = data as RunNodeData;
  const meta = catMeta(run.pipeline_manifest_id);
  const rt = runtime(run);
  const borderBase = STATUS_STYLES[run.status] ?? STATUS_STYLES.pending;

  return (
    <>
      <Handle type="target" position={Position.Top} className="!bg-white/20 !border-white/10" />
      <div
        className={`w-[220px] rounded-xl border p-4 text-left shadow-lg transition-all duration-150 ${borderBase} ${
          selected ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""
        }`}
        style={{ background: "rgba(30,30,46,0.97)" }}
      >
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/10 bg-surface-overlay text-[10px] font-bold ${meta.color}`}
            >
              {meta.icon}
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-white leading-tight">
                {run.pipeline_manifest_id}
              </p>
              <p className="text-[10px] text-gray-500">v{run.pipeline_version}</p>
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${STATUS_BADGE[run.status] ?? STATUS_BADGE.pending}`}
          >
            {run.status === "running" ? (
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                {run.status}
              </span>
            ) : run.status}
          </span>
        </div>

        {/* Meta row */}
        <div className="mt-3 space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-gray-500">Run</span>
            <span className="font-mono text-gray-300">#{run.id}</span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-gray-500">Started</span>
            <span className="text-gray-300">{fmt(run.started_at)}</span>
          </div>
          {rt && (
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-gray-500">Runtime</span>
              <span className="text-gray-300">{rt}</span>
            </div>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-white/20 !border-white/10" />
    </>
  );
}

// ── Custom Dataset Node ───────────────────────────────────────────────────────

function DatasetNode({ data, selected }: NodeProps) {
  const { datasetName, datasetId } = data as DatasetNodeData;
  return (
    <>
      <div
        className={`w-[220px] rounded-xl border border-accent/40 bg-accent/[0.08] p-3.5 shadow-lg ${
          selected ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""
        }`}
        style={{ background: "rgba(124,106,247,0.08)" }}
      >
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/15 text-[10px] font-bold text-accent">
            DS
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-white">
              {datasetName ?? `Dataset #${datasetId}`}
            </p>
            <p className="text-[10px] text-gray-500">Root dataset</p>
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-accent/40 !border-accent/20" />
    </>
  );
}

const NODE_TYPES = { runNode: RunNode, datasetNode: DatasetNode };

// ── Run Side Panel ─────────────────────────────────────────────────────────────

function RunPanel({
  run,
  onClose,
}: {
  run: RunSummary;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const rt = runtime(run);
  const { data: results, isLoading } = useRunResults(run.id, true);
  const artifacts = results?.artifacts ?? [];
  const resolved = artifacts.filter((a) => a.resolved);
  const meta = results?.metadata;

  return (
    <aside className="flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-surface-raised shadow-2xl">
      {/* Header */}
      <div className="flex items-start justify-between border-b border-white/5 p-4">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Run #{run.id}</p>
          <h2 className="mt-0.5 truncate text-sm font-semibold text-white">{run.pipeline_manifest_id}</h2>
          <span
            className={`mt-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              STATUS_BADGE[run.status] ?? STATUS_BADGE.pending
            }`}
          >
            {run.status === "running" && (
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
            )}
            {run.status}
          </span>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded-md p-1 text-gray-500 hover:bg-white/5 hover:text-gray-200 transition-colors"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>

      {/* Body (scrollable) */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
        {/* Timing */}
        <section className="rounded-lg border border-white/8 bg-surface p-3 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Timing</p>
          <Row label="Version" value={`v${run.pipeline_version}`} />
          {rt && <Row label="Runtime" value={rt} />}
          {run.started_at && <Row label="Started" value={fmt(run.started_at)} />}
          {run.finished_at && <Row label="Finished" value={fmt(run.finished_at)} />}
          {run.remote_host_id && (
            <Row label="Execution" value="Remote SSH" highlight />
          )}
        </section>

        {/* Container / profile from metadata */}
        {meta && (
          <section className="rounded-lg border border-white/8 bg-surface p-3 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Pipeline info
            </p>
            {meta.container_image && (
              <Row label="Container" value={meta.container_image} mono truncate />
            )}
            {meta.compute_profile && <Row label="Profile" value={meta.compute_profile} />}
            {meta.execution_type && <Row label="Execution" value={meta.execution_type} />}
          </section>
        )}

        {/* Lineage */}
        {run.source_run_id && (
          <section className="rounded-lg border border-white/8 bg-surface p-3 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Lineage</p>
            <Row
              label="Source run"
              value={`#${run.source_run_id}`}
              onClick={() => navigate(`/runs/${run.source_run_id}`)}
            />
          </section>
        )}

        {/* Resolved artifacts */}
        {isLoading ? (
          <p className="text-[10px] text-gray-500">Loading artifacts…</p>
        ) : resolved.length > 0 ? (
          <section className="rounded-lg border border-white/8 bg-surface p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              Artifacts ({resolved.length})
            </p>
            <ul className="space-y-1.5">
              {resolved.map((a) => (
                <li key={a.type} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                  <span className="font-mono text-[10px] text-gray-300 truncate">{a.type}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {/* Actions */}
      <div className="border-t border-white/5 p-4 space-y-2">
        <Link
          to={`/runs/${run.id}`}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent-hover transition-colors"
        >
          Open Results
        </Link>
        <div className="flex gap-2">
          <Link
            to={`/compare?a=${run.id}`}
            className="flex-1 rounded-md border border-white/15 px-2.5 py-1.5 text-center text-xs font-medium text-gray-300 hover:border-white/30 hover:text-white transition-colors"
          >
            Compare
          </Link>
          <a
            href={`/api/runs/${run.id}/download`}
            download
            className="flex-1 rounded-md border border-white/15 px-2.5 py-1.5 text-center text-xs font-medium text-gray-300 hover:border-white/30 hover:text-white transition-colors"
          >
            Download
          </a>
        </div>
      </div>
    </aside>
  );
}

function Row({
  label,
  value,
  mono = false,
  truncate = false,
  highlight = false,
  onClick,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
  highlight?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2 text-[10px]">
      <span className="shrink-0 text-gray-500">{label}</span>
      {onClick ? (
        <button
          onClick={onClick}
          className="text-accent hover:underline font-medium"
        >
          {value}
        </button>
      ) : (
        <span
          className={`text-right leading-tight ${mono ? "font-mono" : ""} ${
            truncate ? "max-w-[140px] truncate" : ""
          } ${highlight ? "text-violet-300" : "text-gray-300"}`}
        >
          {value}
        </span>
      )}
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────────

function EmptyState({ datasetId }: { datasetId: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      {/* Icon illustration */}
      <svg viewBox="0 0 80 80" className="h-20 w-20 text-gray-700" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="10" y="8" width="60" height="64" rx="8" strokeOpacity="0.5" />
        <circle cx="40" cy="28" r="9" />
        <line x1="40" y1="37" x2="40" y2="50" />
        <circle cx="22" cy="58" r="8" />
        <circle cx="58" cy="58" r="8" />
        <line x1="32" y1="50" x2="22" y2="50" />
        <line x1="48" y1="50" x2="58" y2="50" />
      </svg>
      <div>
        <h3 className="text-sm font-semibold text-white">No runs yet for this dataset</h3>
        <p className="mt-1 text-xs text-gray-400">
          Run your first pipeline to see the graph populate.
        </p>
      </div>
      <Link
        to="/pipelines"
        className="mt-2 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-hover transition-colors"
      >
        Run first pipeline
      </Link>
      <Link
        to={`/datasets/${datasetId}`}
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        ← Back to dataset
      </Link>
    </div>
  );
}

// ── Filter bar ─────────────────────────────────────────────────────────────────

function FilterBar({
  status,
  pipelineId,
  search,
  pipelines,
  total,
  visible,
  onStatus,
  onPipeline,
  onSearch,
}: {
  status: StatusFilter;
  pipelineId: string;
  search: string;
  pipelines: string[];
  total: number;
  visible: number;
  onStatus: (v: StatusFilter) => void;
  onPipeline: (v: string) => void;
  onSearch: (v: string) => void;
}) {
  const SELECT_CLS =
    "rounded-md border border-white/10 bg-surface px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-accent/50 transition-colors";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-surface-raised/90 backdrop-blur px-4 py-2.5">
      {/* Search */}
      <input
        type="search"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search run ID or pipeline…"
        className="w-48 rounded-md border border-white/10 bg-surface px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-accent/50"
      />

      {/* Status filter */}
      <select
        value={status}
        onChange={(e) => onStatus(e.target.value as StatusFilter)}
        className={SELECT_CLS}
      >
        <option value="all">All statuses</option>
        <option value="success">Success</option>
        <option value="failed">Failed</option>
        <option value="running">Running</option>
        <option value="pending">Pending</option>
      </select>

      {/* Pipeline filter */}
      {pipelines.length > 1 && (
        <select
          value={pipelineId}
          onChange={(e) => onPipeline(e.target.value)}
          className={SELECT_CLS}
        >
          <option value="">All pipelines</option>
          {pipelines.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      )}

      <span className="ml-auto text-[10px] text-gray-600">
        {visible === total ? `${total} runs` : `${visible} / ${total} runs`}
      </span>
    </div>
  );
}

// ── Inner graph (needs ReactFlow context) ──────────────────────────────────────

function GraphInner({
  datasetId,
  datasetName,
  allRuns,
}: {
  datasetId: number;
  datasetName: string | null;
  allRuns: RunSummary[];
}) {
  const { fitView } = useReactFlow();
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get("highlight");

  const [status, setStatus] = useState<StatusFilter>("all");
  const [pipelineId, setPipelineId] = useState("");
  const [search, setSearch] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<number | null>(
    highlightId ? Number(highlightId) : null,
  );

  const pipelines = useMemo(() => uniquePipelineIds(allRuns), [allRuns]);

  const visibleRuns = useMemo(
    () => filterRuns(allRuns, status, pipelineId, search),
    [allRuns, status, pipelineId, search],
  );

  const { nodes: builtNodes, edges: builtEdges } = useMemo(
    () => buildWorkflowGraph(visibleRuns, datasetId, datasetName),
    [visibleRuns, datasetId, datasetName],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(builtNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(builtEdges);

  // Sync state when the filtered graph changes, then fit view
  useEffect(() => {
    setNodes(builtNodes);
    setEdges(builtEdges);
    // Two rAF frames ensure React has painted the new nodes before fitView measures them
    let raf1: number, raf2: number;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        fitView({ padding: 0.2, duration: 400 });
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builtNodes, builtEdges]);

  const selectedRun = useMemo(
    () => (selectedRunId != null ? allRuns.find((r) => r.id === selectedRunId) ?? null : null),
    [selectedRunId, allRuns],
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: { id: string }) => {
      if (node.id.startsWith("run-")) {
        const id = Number(node.id.replace("run-", ""));
        setSelectedRunId((prev) => (prev === id ? null : id));
      } else {
        setSelectedRunId(null);
      }
    },
    [],
  );

  // Mark selected node with highlight
  const decoratedNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        selected: selectedRunId != null && n.id === `run-${selectedRunId}`,
      })),
    [nodes, selectedRunId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilterBar
        status={status}
        pipelineId={pipelineId}
        search={search}
        pipelines={pipelines}
        total={allRuns.length}
        visible={visibleRuns.length}
        onStatus={setStatus}
        onPipeline={setPipelineId}
        onSearch={setSearch}
      />

      {/* React Flow requires an explicitly-sized container; calc avoids
          the flex-1 / overflow-y-auto height resolution issue. */}
      <div className="relative flex" style={{ height: "calc(100dvh - 108px)" }}>
        {/* React Flow canvas */}
        <div className={`relative transition-all duration-200 ${selectedRun ? "mr-[300px]" : ""}`} style={{ flex: 1, minWidth: 0 }}>
          {visibleRuns.length === 0 && allRuns.length === 0 ? (
            <EmptyState datasetId={datasetId} />
          ) : visibleRuns.length === 0 ? (
            <div className="flex items-center justify-center py-24 text-sm text-gray-500">
              No runs match the current filters.
            </div>
          ) : (
            <ReactFlow
              nodes={decoratedNodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={handleNodeClick}
              onPaneClick={() => setSelectedRunId(null)}
              onInit={(rf) => requestAnimationFrame(() => requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 400 })))}
              minZoom={0.1}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
              className="workflow-canvas-grid"
            >
              <Background
                variant={BackgroundVariant.Dots}
                color="rgba(148,163,184,0.08)"
                gap={28}
                size={1}
              />
              <Controls
                className="!bg-surface-raised !border-white/10 !rounded-lg !shadow-xl"
                showInteractive={false}
              />
              <MiniMap
                nodeColor={(n) => {
                  if (n.id.startsWith("dataset-")) return "#7c6af7";
                  const d = n.data as { run?: RunSummary };
                  const s = d.run?.status ?? "pending";
                  return s === "success" ? "#22c55e" : s === "failed" ? "#ef4444" : s === "running" ? "#f59e0b" : "#4b5563";
                }}
                className="!bg-surface-raised !border-white/10 !rounded-lg"
                maskColor="rgba(30,30,46,0.7)"
              />
            </ReactFlow>
          )}
        </div>

        {/* Side panel */}
        {selectedRun && (
          <div className="absolute right-0 top-0 h-full w-[296px] p-3">
            <RunPanel
              run={selectedRun}
              onClose={() => setSelectedRunId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

export default function WorkflowGraph() {
  const { id } = useParams<{ id: string }>();
  const datasetId = Number(id);
  const { data: dataset, isLoading: dsLoading } = useDataset(datasetId);
  const { data: allRuns = [], isLoading: runsLoading } = useRuns();

  const datasetRuns = useMemo(
    () => allRuns.filter((r) => r.dataset_id === datasetId),
    [allRuns, datasetId],
  );

  if (dsLoading || runsLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-gray-400 animate-pulse">Loading graph…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col text-gray-100" style={{ height: "100dvh" }}>
      {/* Page header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-white/5 bg-surface-raised px-5 py-3">
        <Link
          to={`/datasets/${datasetId}`}
          className="text-xs text-gray-500 hover:text-gray-200 transition-colors"
        >
          ← Dataset
        </Link>
        <span className="text-gray-700">/</span>
        <span className="rounded-full border border-accent/25 bg-accent/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-accent">
          Workflow Graph
        </span>
        <h1 className="text-sm font-semibold text-white truncate">
          {dataset?.name ?? `Dataset #${datasetId}`}
        </h1>
        <span className="ml-auto text-[10px] text-gray-600">
          {datasetRuns.length} run{datasetRuns.length !== 1 ? "s" : ""}
        </span>
      </header>

      {/* Graph (needs ReactFlowProvider so useReactFlow works inside) */}
      <ReactFlowProvider>
        <GraphInner
          datasetId={datasetId}
          datasetName={dataset?.name ?? null}
          allRuns={datasetRuns}
        />
      </ReactFlowProvider>
    </div>
  );
}
