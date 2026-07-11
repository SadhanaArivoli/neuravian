/**
 * Project Dashboard — /datasets/:id/dashboard
 *
 * Aggregated view of a dataset: run counts, runtimes, storage,
 * recent activity, and quick actions. All data from backend aggregation.
 */

import { Link, useParams } from "react-router-dom";
import { useDatasetDashboard } from "../hooks/useDatasets";
import {
  fmtBytes,
  fmtDatetime,
  fmtSeconds,
  pipelineRuntimeBars,
  pipelineStorageBars,
  timeAgo,
  toUtc,
  type ChartBar,
} from "../lib/dashboardStats";

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-white/8 bg-surface-raised p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p
        className={`mt-1 text-2xl font-bold tabular-nums ${accent ? "text-accent" : "text-white"}`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  success: "text-green-400 bg-green-900/30 border-green-800/40",
  failed: "text-red-400 bg-red-900/30 border-red-800/40",
  running: "text-amber-400 bg-amber-900/30 border-amber-800/40",
  pending: "text-gray-400 bg-white/5 border-white/10",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-semibold ${STATUS_COLOR[status] ?? STATUS_COLOR.pending}`}
    >
      {status}
    </span>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">
      {title}
    </h2>
  );
}

/** Horizontal bar chart using CSS flex — no charting library needed. */
function BarChart({ bars, formatValue }: { bars: ChartBar[]; formatValue: (v: number) => string }) {
  if (!bars.length) return <p className="text-xs text-gray-500">No data</p>;
  const max = Math.max(...bars.map((b) => b.value));
  return (
    <div className="space-y-2">
      {bars.map((bar) => (
        <div key={bar.label} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate text-right text-xs text-gray-400">
            {bar.label}
          </span>
          <div className="flex-1 rounded-full bg-white/5 h-2">
            <div
              className="h-2 rounded-full transition-all duration-500"
              style={{
                width: `${(bar.value / max) * 100}%`,
                backgroundColor: bar.color,
              }}
            />
          </div>
          <span className="w-16 shrink-0 text-right text-xs tabular-nums text-gray-400">
            {formatValue(bar.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Donut-style run status ring using SVG. */
function StatusDonut({
  success,
  failed,
  running,
  pending,
}: {
  success: number;
  failed: number;
  running: number;
  pending: number;
}) {
  const total = success + failed + running + pending;
  if (total === 0) return <p className="text-xs text-gray-500">No runs yet</p>;

  const segments = [
    { value: success, color: "#22c55e", label: "Success" },
    { value: failed, color: "#ef4444", label: "Failed" },
    { value: running, color: "#f59e0b", label: "Running" },
    { value: pending, color: "rgba(255,255,255,0.15)", label: "Pending" },
  ].filter((s) => s.value > 0);

  const r = 40;
  const cx = 56;
  const cy = 56;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const arcs = segments.map((seg) => {
    const pct = seg.value / total;
    const arc = {
      ...seg,
      strokeDasharray: `${pct * circumference} ${circumference}`,
      strokeDashoffset: -offset * circumference,
    };
    offset += pct;
    return arc;
  });

  return (
    <div className="flex items-center gap-6">
      <svg width={112} height={112} viewBox="0 0 112 112">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={12} />
        {arcs.map((arc) => (
          <circle
            key={arc.label}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={arc.color}
            strokeWidth={12}
            strokeDasharray={arc.strokeDasharray}
            strokeDashoffset={arc.strokeDashoffset}
            strokeLinecap="butt"
            style={{ transform: "rotate(-90deg)", transformOrigin: `${cx}px ${cy}px` }}
          />
        ))}
        <text x={cx} y={cy - 6} textAnchor="middle" fill="white" fontSize={18} fontWeight="bold">
          {total}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" fill="#6b7280" fontSize={10}>
          runs
        </text>
      </svg>
      <div className="space-y-1.5">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: seg.color }} />
            <span className="text-gray-400">
              {seg.label}: <span className="font-semibold text-white">{seg.value}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DatasetDashboard() {
  const { id } = useParams<{ id: string }>();
  const datasetId = Number(id);
  const { data, isLoading, isError } = useDatasetDashboard(datasetId);

  if (isLoading) {
    return (
      <div className="p-8">
        <p className="animate-pulse text-sm text-gray-400">Loading dashboard…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-8">
        <p className="text-sm text-red-400">Failed to load dashboard.</p>
        <Link to={`/datasets/${datasetId}`} className="mt-2 block text-xs text-accent hover:underline">
          ← Back to dataset
        </Link>
      </div>
    );
  }

  const { dataset, run_counts, run_stats, runtime_stats, storage, recent_runs } = data;
  const meta = dataset.indexed_metadata;
  const runtimeBars = pipelineRuntimeBars(runtime_stats.by_pipeline);
  const storageBars = pipelineStorageBars(storage.by_pipeline);

  return (
    <div className="min-h-full p-6 lg:p-8">
      {/* ── Header ── */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs text-gray-500">
            <Link to="/datasets" className="hover:text-gray-300">Datasets</Link>
            <span>/</span>
            <Link to={`/datasets/${datasetId}`} className="hover:text-gray-300">
              {dataset.name ?? dataset.path}
            </Link>
            <span>/</span>
            <span className="text-gray-400">Dashboard</span>
          </div>
          <h1 className="text-2xl font-bold">{dataset.name ?? dataset.path}</h1>
          <p className="mt-0.5 font-mono text-xs text-gray-500">{dataset.path}</p>
        </div>

        {/* Tab nav */}
        <nav className="flex gap-1 rounded-lg border border-white/8 bg-surface-raised p-1">
          {[
            { label: "Overview", to: `/datasets/${datasetId}` },
            { label: "Dashboard", to: `/datasets/${datasetId}/dashboard` },
            { label: "Artifacts", to: `/datasets/${datasetId}/artifacts` },
            { label: "Graph", to: `/datasets/${datasetId}/graph` },
          ].map(({ label, to }) => {
            const active = label === "Dashboard";
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

      {/* ── Dataset summary ── */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Subjects" value={meta?.subjects?.length ?? "—"} />
        <StatCard label="Sessions" value={meta?.sessions?.length || "—"} />
        <StatCard label="Files" value={meta?.file_count ?? "—"} />
        <StatCard label="BIDS" value={dataset.validation_status} accent={dataset.validation_status === "valid"} />
        <StatCard label="Registered" value={toUtc(dataset.created_at).toLocaleDateString()} />
        <StatCard label="Version" value={dataset.bids_version ?? "—"} />
      </div>

      {/* ── Run summary ── */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-white/8 bg-surface-raised p-5">
          <SectionHeader title="Run Status" />
          <StatusDonut
            success={run_counts.success}
            failed={run_counts.failed}
            running={run_counts.running}
            pending={run_counts.pending}
          />
          <div className="mt-4 grid grid-cols-2 gap-2 border-t border-white/8 pt-4">
            <div>
              <p className="text-xs text-gray-500">Success rate</p>
              <p className="text-lg font-bold text-green-400">{run_counts.success_rate}%</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Most used pipeline</p>
              <p className="truncate text-sm font-medium text-white">
                {run_stats.most_common_pipeline ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Last run</p>
              <p className="text-sm font-medium text-white">
                {run_stats.most_recent_finished_at
                  ? timeAgo(run_stats.most_recent_finished_at)
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Last status</p>
              <div className="mt-0.5">
                {run_stats.most_recent_run_status ? (
                  <StatusPill status={run_stats.most_recent_run_status} />
                ) : (
                  <span className="text-sm text-gray-500">—</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Pipeline breakdown */}
        <div className="rounded-lg border border-white/8 bg-surface-raised p-5">
          <SectionHeader title="Runs by Pipeline" />
          <div className="space-y-2">
            {Object.entries(run_stats.pipeline_run_counts).length === 0 ? (
              <p className="text-xs text-gray-500">No runs</p>
            ) : (
              Object.entries(run_stats.pipeline_run_counts)
                .sort((a, b) => b[1] - a[1])
                .map(([pipeline, count]) => {
                  const pct = Math.round((count / run_counts.total) * 100);
                  return (
                    <div key={pipeline} className="flex items-center gap-3">
                      <span className="w-36 shrink-0 truncate text-right text-xs text-gray-400">
                        {pipeline}
                      </span>
                      <div className="flex-1 rounded-full bg-white/5 h-2">
                        <div
                          className="h-2 rounded-full bg-accent/60 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-gray-400">
                        {count}
                      </span>
                    </div>
                  );
                })
            )}
          </div>
        </div>
      </div>

      {/* ── Runtime + Storage ── */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Runtime */}
        <div className="rounded-lg border border-white/8 bg-surface-raised p-5">
          <SectionHeader title="Runtime" />
          <div className="mb-4 grid grid-cols-2 gap-3">
            <StatCard
              label="Total compute"
              value={runtime_stats.total_seconds > 0 ? fmtSeconds(runtime_stats.total_seconds) : "—"}
            />
            <StatCard
              label="Median runtime"
              value={runtime_stats.median_seconds != null ? fmtSeconds(runtime_stats.median_seconds) : "—"}
            />
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-gray-500">Slowest run</p>
              {runtime_stats.slowest_run_id ? (
                <Link
                  to={`/runs/${runtime_stats.slowest_run_id}`}
                  className="text-sm font-medium text-accent hover:underline"
                >
                  #{runtime_stats.slowest_run_id} ·{" "}
                  {runtime_stats.slowest_run_seconds != null
                    ? fmtSeconds(runtime_stats.slowest_run_seconds)
                    : ""}
                </Link>
              ) : (
                <span className="text-sm text-gray-500">—</span>
              )}
            </div>
            <div>
              <p className="text-xs text-gray-500">Fastest successful</p>
              {runtime_stats.fastest_run_id ? (
                <Link
                  to={`/runs/${runtime_stats.fastest_run_id}`}
                  className="text-sm font-medium text-accent hover:underline"
                >
                  #{runtime_stats.fastest_run_id} ·{" "}
                  {runtime_stats.fastest_run_seconds != null
                    ? fmtSeconds(runtime_stats.fastest_run_seconds)
                    : ""}
                </Link>
              ) : (
                <span className="text-sm text-gray-500">—</span>
              )}
            </div>
          </div>
          <div className="border-t border-white/8 pt-4">
            <p className="mb-2 text-xs text-gray-500">By pipeline</p>
            <BarChart bars={runtimeBars} formatValue={fmtSeconds} />
          </div>
        </div>

        {/* Storage */}
        <div className="rounded-lg border border-white/8 bg-surface-raised p-5">
          <SectionHeader title="Storage" />
          <div className="mb-4 grid grid-cols-2 gap-3">
            <StatCard
              label="Total derivatives"
              value={storage.total_bytes > 0 ? fmtBytes(storage.total_bytes) : "—"}
            />
            <StatCard
              label="Artifacts"
              value={storage.artifact_count}
              sub="resolved outputs"
            />
          </div>
          <div className="mb-4">
            <p className="text-xs text-gray-500">Largest run</p>
            {storage.largest_run_id ? (
              <Link
                to={`/runs/${storage.largest_run_id}`}
                className="text-sm font-medium text-accent hover:underline"
              >
                #{storage.largest_run_id} · {fmtBytes(storage.largest_run_bytes)}
              </Link>
            ) : (
              <span className="text-sm text-gray-500">—</span>
            )}
          </div>
          <div className="border-t border-white/8 pt-4">
            <p className="mb-2 text-xs text-gray-500">By pipeline</p>
            <BarChart bars={storageBars} formatValue={fmtBytes} />
          </div>
        </div>
      </div>

      {/* ── Recent activity ── */}
      <div className="mb-6 rounded-lg border border-white/8 bg-surface-raised p-5">
        <div className="mb-4 flex items-center justify-between">
          <SectionHeader title="Recent Runs" />
          <Link to="/runs" className="text-xs text-accent hover:underline">
            All runs →
          </Link>
        </div>
        {recent_runs.length === 0 ? (
          <p className="text-sm text-gray-500">No runs yet for this dataset.</p>
        ) : (
          <div className="divide-y divide-white/5">
            {recent_runs.map((run) => (
              <div key={run.id} className="flex items-center gap-3 py-2.5">
                <StatusPill status={run.status} />
                <Link
                  to={`/runs/${run.id}`}
                  className="text-sm font-medium text-white hover:text-accent"
                >
                  #{run.id}
                </Link>
                <span className="flex-1 truncate text-sm text-gray-400">
                  {run.pipeline_manifest_id}
                </span>
                <span className="shrink-0 text-xs text-gray-500">
                  {run.finished_at ? timeAgo(run.finished_at) : fmtDatetime(run.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Quick actions ── */}
      <div className="rounded-lg border border-white/8 bg-surface-raised p-5">
        <SectionHeader title="Quick Actions" />
        <div className="flex flex-wrap gap-3">
          <Link
            to="/pipelines"
            className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
              <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2Z" />
            </svg>
            Run Pipeline
          </Link>
          <Link
            to={`/datasets/${datasetId}/artifacts`}
            className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <path d="M2 3h12M2 8h8M2 13h5" strokeLinecap="round" />
            </svg>
            Artifact Explorer
          </Link>
          <Link
            to={`/datasets/${datasetId}/graph`}
            className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <circle cx="8" cy="3" r="2" /><circle cx="3" cy="13" r="2" /><circle cx="13" cy="13" r="2" />
              <line x1="8" y1="5" x2="5" y2="11" /><line x1="8" y1="5" x2="11" y2="11" />
            </svg>
            Analysis Graph
          </Link>
          <Link
            to={`/datasets/${datasetId}/methods`}
            className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <path d="M2 4h12M2 8h9M2 12h6" strokeLinecap="round" />
            </svg>
            Methods Studio
          </Link>
          <Link
            to="/compare"
            className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <rect x="1" y="2" width="6" height="12" rx="1" /><rect x="9" y="2" width="6" height="12" rx="1" />
            </svg>
            Compare Results
          </Link>
          <Link
            to="/workflows/new"
            className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
              <path d="M2 8h3l2-4 2 8 2-4h3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Workflow Builder
          </Link>
        </div>
      </div>
    </div>
  );
}
