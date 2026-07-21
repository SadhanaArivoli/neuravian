/**
 * Artifact Explorer — /datasets/:id/artifacts
 *
 * Flat list of every resolved artifact from every successful run in a dataset.
 * Supports filtering, sorting, inline preview, and lineage inspection.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { DatasetArtifact } from "../api/client";
import NiivueViewer from "../components/domain/NiivueViewer";
import { useDatasetArtifacts, useDatasetDashboard } from "../hooks/useDatasets";
import {
  artifactFileUrl,
  buildArtifactLineage,
  DEFAULT_ARTIFACT_FILTERS,
  filterArtifacts,
  fmtBytes,
  fmtDatetime,
  resolvePreviewKind,
  timeAgo,
  uniqueArtifactPipelines,
  uniqueArtifactTypes,
  type ArtifactFilters,
  type ArtifactSortKey,
  type PreviewKind,
} from "../lib/dashboardStats";
import { parseConnectivityMatrixCsv } from "../lib/connectivityMatrix";
import { artifactIcon, WorkbenchIcons } from "../lib/iconRegistry";

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  success: "bg-green-500",
  failed: "bg-red-500",
  running: "bg-amber-500",
  pending: "bg-gray-500",
};

// ── Connectivity matrix mini-canvas ──────────────────────────────────────────

function MatrixPreview({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
fetch(url)
      .then((r) => r.text())
      .then((text) => {
        if (cancelled) return;
        const data = parseConnectivityMatrixCsv(text);
        const canvas = canvasRef.current;
        if (!canvas || !data) return;
        const n = data.labels.length;
        const cell = Math.max(1, Math.floor(280 / n));
        canvas.width = n * cell;
        canvas.height = n * cell;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const flat = data.values.flat();
        const max = Math.max(...flat.map(Math.abs)) || 1;
        // Blue–white–red diverging colormap (matches RunResults MatrixCanvas)
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const v = Math.max(-1, Math.min(1, data.values[i][j] / max));
            let r: number, g: number, b: number;
            if (v >= 0) { r = 255; g = Math.round(255 * (1 - v)); b = Math.round(255 * (1 - v)); }
            else { const t = 1 + v; r = Math.round(255 * t); g = Math.round(255 * t); b = 255; }
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.fillRect(j * cell, i * cell, cell, cell);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, [url]);

  if (error) return <p className="text-xs text-gray-500">Could not load matrix</p>;
  return (
    <canvas
      ref={canvasRef}
      className="max-w-full rounded border border-white/10"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

// ── Preview panel ─────────────────────────────────────────────────────────────

function PreviewPanel({
  artifact,
  onClose,
}: {
  artifact: DatasetArtifact;
  onClose: () => void;
}) {
  const kind: PreviewKind = resolvePreviewKind(artifact);
  const fileUrl = artifactFileUrl(artifact);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-white">{artifact.label}</p>
          <p className="text-xs text-gray-500">{artifact.type}</p>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-300"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {kind === "nifti" && (
          <NiivueViewer
            layers={[{ url: fileUrl, name: artifact.label }]}
            onClose={onClose}
          />
        )}
        {kind === "html" && (
          <iframe
            src={fileUrl}
            title={artifact.label}
            className="h-[min(75vh,900px)] min-h-[600px] w-full rounded border border-white/10 bg-[#090d18] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
            sandbox="allow-scripts allow-same-origin"
          />
        )}
        {kind === "connectivity_matrix" && (
          <MatrixPreview url={fileUrl} />
        )}
        {kind === "image" && (
          <img
            src={fileUrl}
            alt={artifact.label}
            className="max-w-full rounded border border-white/10"
          />
        )}
        {(kind === "tsv" || kind === "csv" || kind === "json") && (
          <TextPreview url={fileUrl} kind={kind} />
        )}
        {kind === "none" && (
          <div className="rounded-lg border border-white/10 bg-surface-overlay p-4">
            <p className="text-sm text-gray-400">No inline preview available for this artifact type.</p>
            <a
              href={fileUrl}
              download
              className="mt-3 inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
            >
              Download file
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function TextPreview({ url, kind }: { url: string; kind: "csv" | "tsv" | "json" }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then(setText)
      .catch(() => setText("Error loading file"));
  }, [url]);

  if (!text) return <p className="text-xs text-gray-500 animate-pulse">Loading…</p>;

  if (kind === "json") {
    try {
      const parsed = JSON.parse(text);
      return (
        <pre className="overflow-auto rounded bg-surface-overlay p-4 text-xs text-gray-300">
          {JSON.stringify(parsed, null, 2).slice(0, 8000)}
        </pre>
      );
    } catch {
      /* fall through to raw */
    }
  }

  // TSV or raw text — show first 40 lines
  const lines = text.split("\n").slice(0, 40);
  if (kind === "tsv") {
    const rows = lines.map((l) => l.split("\t"));
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={i === 0 ? "bg-surface-overlay font-semibold" : "border-t border-white/5"}>
                {row.map((cell, j) => (
                  <td key={j} className="px-2 py-1 text-gray-300">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <pre className="overflow-auto rounded bg-surface-overlay p-4 text-xs text-gray-300">
      {lines.join("\n")}
    </pre>
  );
}

// ── Lineage drawer ────────────────────────────────────────────────────────────

function LineageDrawer({
  artifact,
  dashboardRuns,
  datasetName,
  onClose,
}: {
  artifact: DatasetArtifact;
  dashboardRuns: import("../api/client").DashboardRecentRun[];
  datasetName: string | null;
  onClose: () => void;
}) {
  const steps = buildArtifactLineage(artifact, dashboardRuns, datasetName);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
        <p className="text-sm font-semibold text-white">Lineage</p>
        <button
          onClick={onClose}
          className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-300"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {artifact.source_run_id === null && steps.filter((s) => s.kind === "run").length === 1 && (
          <p className="mb-4 rounded border border-white/8 bg-surface-overlay p-3 text-xs text-gray-500">
            This artifact has no recorded upstream lineage. It was produced directly from the dataset.
          </p>
        )}
        <div className="space-y-0">
          {steps.map((step, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    step.kind === "dataset"
                      ? "bg-accent/20 text-accent"
                      : step.kind === "artifact"
                      ? "bg-green-900/40 text-green-400"
                      : "bg-surface-overlay text-gray-400"
                  }`}
                >
                  {step.kind === "dataset" ? "DS" : step.kind === "artifact" ? "AR" : "RN"}
                </div>
                {i < steps.length - 1 && (
                  <div className="mt-1 w-px flex-1 bg-white/10" style={{ minHeight: 24 }} />
                )}
              </div>
              <div className="pb-4">
                <p className="text-sm font-medium text-white">{step.label}</p>
                {step.kind === "run" && step.runId && (
                  <Link
                    to={`/runs/${step.runId}`}
                    className="text-xs text-accent hover:underline"
                  >
                    Open run →
                  </Link>
                )}
                {step.timestamp && (
                  <p className="text-xs text-gray-500">{fmtDatetime(step.timestamp)}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Artifact row ─────────────────────────────────────────────────────────────

// NIfTI artifact types that can be passed to the NIfTI Inspector
const NIFTI_INSPECTABLE_TYPES = new Set([
  "nifti_raw", "nifti_skull_stripped", "brain_mask", "nifti_defaced", "seed_connectivity_map_nii",
]);

// NIfTI artifact types that can be passed to Atlas ROI Extraction
const ATLAS_ROI_TYPES = new Set([
  "nifti_raw", "nifti_skull_stripped", "brain_mask", "nifti_defaced", "seed_connectivity_map_nii",
]);

function ArtifactRow({
  artifact,
  onPreview,
  onLineage,
  onInspect,
  onAnalyze,
  selected,
}: {
  artifact: DatasetArtifact;
  onPreview: (a: DatasetArtifact) => void;
  onLineage: (a: DatasetArtifact) => void;
  onInspect: (a: DatasetArtifact) => void;
  onAnalyze: (a: DatasetArtifact) => void;
  selected: boolean;
}) {
  const kind = resolvePreviewKind(artifact);
  const fileUrl = artifactFileUrl(artifact);
  const filename = artifact.path.split("/").pop() ?? artifact.path;
  const isInspectable = NIFTI_INSPECTABLE_TYPES.has(artifact.type) && !artifact.is_directory;
  const isAnalyzable = ATLAS_ROI_TYPES.has(artifact.type) && !artifact.is_directory;
  const ArtifactIcon = artifactIcon(artifact.type, artifact.path);

  return (
    <div
      className={`group flex items-start gap-3 border-b border-white/5 px-4 py-3 transition-colors hover:bg-white/3 ${
        selected ? "bg-accent/5" : ""
      }`}
    >
      {/* Type icon */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-surface-overlay text-violet-300 shadow-inner shadow-white/[0.03]">
        <ArtifactIcon className="h-5 w-5" aria-hidden="true" />
      </div>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-white">{artifact.label}</span>
          <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-xs text-gray-500">
            {artifact.type}
          </span>
          {artifact.is_directory && (
            <span className="rounded border border-amber-800/40 bg-amber-900/20 px-1.5 py-0.5 text-xs text-amber-400">
              dir
            </span>
          )}
        </div>
        <p className="truncate font-mono text-xs text-gray-500" title={filename}>
          {filename}
        </p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[artifact.run_status] ?? STATUS_DOT.pending}`} />
            <Link to={`/runs/${artifact.run_id}`} className="hover:text-accent">
              Run #{artifact.run_id}
            </Link>
          </span>
          <span>{artifact.pipeline_id}</span>
          {artifact.atlas_metadata?.atlas && (
            <span title={artifact.atlas_metadata.atlas}>
              {artifact.atlas_metadata.atlas}
              {artifact.atlas_metadata.n_rois
                ? ` · ${artifact.atlas_metadata.n_rois} ROIs`
                : ""}
            </span>
          )}
          <span>{fmtBytes(artifact.size_bytes)}</span>
          {artifact.run_finished_at && (
            <span title={fmtDatetime(artifact.run_finished_at)}>
              {timeAgo(artifact.run_finished_at)}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {isInspectable && (
          <button
            onClick={() => onInspect(artifact)}
            className="rounded px-2 py-1 text-xs text-emerald-700 border border-emerald-300 hover:bg-emerald-50 transition-colors"
            title="Inspect header, statistics, and QC warnings"
          >
            Inspect
          </button>
        )}
        {isAnalyzable && (
          <button
            onClick={() => onAnalyze(artifact)}
            className="rounded px-2 py-1 text-xs text-violet-700 border border-violet-300 hover:bg-violet-50 transition-colors"
            title="Extract per-ROI atlas statistics"
          >
            Analyze
          </button>
        )}
        {kind !== "none" && (
          <button
            onClick={() => onPreview(artifact)}
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-accent border border-accent/30 hover:bg-accent/10 transition-colors"
          >
            <WorkbenchIcons.viewer className="h-3.5 w-3.5" aria-hidden="true" />
            Preview
          </button>
        )}
        <a
          href={fileUrl}
          download={filename}
          className="inline-flex items-center rounded px-2 py-1 text-xs text-gray-400 border border-white/10 hover:bg-white/5 hover:text-gray-200 transition-colors"
          title="Download artifact"
          aria-label={`Download ${artifact.label}`}
        >
          <WorkbenchIcons.download className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
        <button
          onClick={() => onLineage(artifact)}
          className="rounded px-2 py-1 text-xs text-gray-400 border border-white/10 hover:bg-white/5 hover:text-gray-200 transition-colors"
          title="Lineage"
        >
          <GitBranch className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function FilterBar({
  filters,
  setFilters,
  types,
  pipelines,
  total,
  visible,
}: {
  filters: ArtifactFilters;
  setFilters: (f: ArtifactFilters) => void;
  types: string[];
  pipelines: string[];
  total: number;
  visible: number;
}) {
  const selectCls = "rounded-md border border-white/10 bg-surface-overlay px-2 py-1.5 text-xs text-gray-300 focus:border-accent/60 focus:outline-none";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/8 bg-surface px-4 py-3">
      <input
        type="search"
        aria-label="Search artifacts"
        placeholder="Search artifacts…"
        value={filters.search}
        onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        className="min-w-48 flex-1 rounded-md border border-white/10 bg-surface-overlay px-3 py-1.5 text-xs text-gray-300 placeholder-gray-600 focus:border-accent/60 focus:outline-none"
      />
      <select
        aria-label="Filter artifacts by type"
        value={filters.artifactType}
        onChange={(e) => setFilters({ ...filters, artifactType: e.target.value })}
        className={selectCls}
      >
        <option value="">All types</option>
        {types.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select
        aria-label="Filter artifacts by pipeline"
        value={filters.pipeline}
        onChange={(e) => setFilters({ ...filters, pipeline: e.target.value })}
        className={selectCls}
      >
        <option value="">All pipelines</option>
        {pipelines.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <select
        aria-label="Filter artifacts by file kind"
        value={filters.fileKind}
        onChange={(e) => setFilters({ ...filters, fileKind: e.target.value as ArtifactFilters["fileKind"] })}
        className={selectCls}
      >
        <option value="all">Files + dirs</option>
        <option value="file">Files only</option>
        <option value="directory">Directories</option>
      </select>
      <select
        aria-label="Sort artifacts"
        value={filters.sortBy}
        onChange={(e) => setFilters({ ...filters, sortBy: e.target.value as ArtifactSortKey })}
        className={selectCls}
      >
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="largest">Largest</option>
        <option value="smallest">Smallest</option>
        <option value="pipeline">Pipeline</option>
        <option value="type">Type</option>
      </select>
      <span className="ml-auto text-xs text-gray-500">
        {visible} / {total}
      </span>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-24 text-center">
      <svg viewBox="0 0 64 64" fill="none" className="mb-4 h-16 w-16 text-gray-700">
        <rect x="8" y="16" width="48" height="36" rx="4" stroke="currentColor" strokeWidth="2" />
        <path d="M20 28h24M20 36h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="48" cy="48" r="10" fill="#1e1e2e" stroke="currentColor" strokeWidth="2" />
        <path d="M44 48h8M48 44v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {hasFilters ? (
        <>
          <p className="text-sm font-medium text-gray-400">No artifacts match your filters</p>
          <p className="mt-1 text-xs text-gray-600">Try clearing the search or adjusting the filters</p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-gray-400">No artifacts yet</p>
          <p className="mt-1 text-xs text-gray-600">
            Run a pipeline to produce outputs for this dataset
          </p>
          <Link
            to="/pipelines"
            className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            Run Pipeline
          </Link>
        </>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ArtifactExplorer() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const datasetId = Number(id);

  const { data: artifacts = [], isLoading, isError } = useDatasetArtifacts(datasetId);
  const { data: dashboard } = useDatasetDashboard(datasetId);

  const [filters, setFilters] = useState<ArtifactFilters>(() => {
    // Allow pre-filtering to a specific run from Run Results page
    const runId = searchParams.get("run");
    return runId
      ? { ...DEFAULT_ARTIFACT_FILTERS, search: runId }
      : DEFAULT_ARTIFACT_FILTERS;
  });

  const [previewArtifact, setPreviewArtifact] = useState<DatasetArtifact | null>(null);
  const [lineageArtifact, setLineageArtifact] = useState<DatasetArtifact | null>(null);

  const sidePanel = previewArtifact ?? lineageArtifact;

  const types = useMemo(() => uniqueArtifactTypes(artifacts), [artifacts]);
  const pipelines = useMemo(() => uniqueArtifactPipelines(artifacts), [artifacts]);
  const visible = useMemo(() => filterArtifacts(artifacts, filters), [artifacts, filters]);

  const hasFilters =
    !!filters.search ||
    !!filters.artifactType ||
    !!filters.pipeline ||
    filters.fileKind !== "all";

  const handlePreview = useCallback((a: DatasetArtifact) => {
    setLineageArtifact(null);
    setPreviewArtifact(a);
  }, []);

  const handleLineage = useCallback((a: DatasetArtifact) => {
    setPreviewArtifact(null);
    setLineageArtifact(a);
  }, []);

  const handleInspect = useCallback((a: DatasetArtifact) => {
    // Derive container-internal path: output_dir + "/" + path
    const containerPath = a.output_dir.replace(/\/$/, "") + "/" + a.path;
    navigate("/pipelines", {
      state: {
        selectPipeline: "nifti-inspector",
        prefill: {
          runId: a.run_id,
          sourcePipelineId: a.pipeline_id,
          sourceDisplayName: a.pipeline_id,
          artifactType: a.type,
          artifactLabel: a.label,
          param: "input-file",
          path: containerPath,
          isDatasetSlot: false,
        },
      },
    });
  }, [navigate]);

  const handleAnalyze = useCallback((a: DatasetArtifact) => {
    const containerPath = a.output_dir.replace(/\/$/, "") + "/" + a.path;
    navigate("/pipelines", {
      state: {
        selectPipeline: "atlas-roi-extraction",
        prefill: {
          runId: a.run_id,
          sourcePipelineId: a.pipeline_id,
          sourceDisplayName: a.pipeline_id,
          artifactType: a.type,
          artifactLabel: a.label,
          param: "input-file",
          path: containerPath,
          isDatasetSlot: false,
        },
      },
    });
  }, [navigate]);

  const closeSidePanel = useCallback(() => {
    setPreviewArtifact(null);
    setLineageArtifact(null);
  }, []);

  const datasetName = dashboard?.dataset?.name ?? null;

  return (
    <div className="flex h-screen flex-col">
      {/* ── Header ── */}
      <div className="border-b border-white/8 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs text-gray-500">
              <Link to="/datasets" className="hover:text-gray-300">Datasets</Link>
              <span>/</span>
              <Link to={`/datasets/${datasetId}`} className="hover:text-gray-300">
                {datasetName ?? `Dataset ${datasetId}`}
              </Link>
              <span>/</span>
              <span className="text-gray-400">Artifacts</span>
            </div>
            <h1 className="text-lg font-bold">
              Artifact Explorer
              {artifacts.length > 0 && (
                <span className="ml-2 text-sm font-normal text-gray-500">
                  · {artifacts.length} total
                </span>
              )}
            </h1>
          </div>

          {/* Tab nav */}
          <nav className="flex gap-1 rounded-lg border border-white/8 bg-surface-raised p-1">
            {[
              { label: "Overview", to: `/datasets/${datasetId}` },
              { label: "Dashboard", to: `/datasets/${datasetId}/dashboard` },
              { label: "Artifacts", to: `/datasets/${datasetId}/artifacts` },
              { label: "Graph", to: `/datasets/${datasetId}/graph` },
              { label: "Reports", to: `/datasets/${datasetId}/reports` },
            ].map(({ label, to }) => {
              const active = label === "Artifacts";
              return (
                <Link
                  key={label}
                  to={to}
                  className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "bg-accent/20 text-accent"
                      : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <FilterBar
        filters={filters}
        setFilters={setFilters}
        types={types}
        pipelines={pipelines}
        total={artifacts.length}
        visible={visible.length}
      />

      {/* ── Body ── */}
      <div className="flex min-h-0 flex-1">
        {/* Artifact list */}
        <div className={`flex flex-col overflow-y-auto ${sidePanel ? "w-1/2" : "w-full"}`}>
          {isLoading && (
            <p className="animate-pulse p-8 text-sm text-gray-400">Loading artifacts…</p>
          )}
          {isError && (
            <p className="p-8 text-sm text-red-400">Failed to load artifacts.</p>
          )}
          {!isLoading && !isError && visible.length === 0 && (
            <EmptyState hasFilters={hasFilters} />
          )}
          {visible.map((a) => (
            <ArtifactRow
              key={`${a.run_id}:${a.path}`}
              artifact={a}
              onPreview={handlePreview}
              onLineage={handleLineage}
              onInspect={handleInspect}
              onAnalyze={handleAnalyze}
              selected={
                (previewArtifact?.run_id === a.run_id && previewArtifact?.path === a.path) ||
                (lineageArtifact?.run_id === a.run_id && lineageArtifact?.path === a.path)
              }
            />
          ))}
        </div>

        {/* Side panel */}
        {sidePanel && (
          <div className="w-1/2 border-l border-white/8 bg-surface-raised overflow-auto">
            {previewArtifact && (
              <PreviewPanel artifact={previewArtifact} onClose={closeSidePanel} />
            )}
            {lineageArtifact && (
              <LineageDrawer
                artifact={lineageArtifact}
                dashboardRuns={dashboard?.recent_runs ?? []}
                datasetName={datasetName}
                onClose={closeSidePanel}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
