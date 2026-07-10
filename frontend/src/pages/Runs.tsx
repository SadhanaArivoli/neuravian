import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useRuns } from "../hooks/useRuns";
import type { RunSummary } from "../api/client";

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { dot: string; bg: string; text: string }> = {
  pending:  { dot: "bg-yellow-400",  bg: "bg-yellow-400/10",  text: "text-yellow-300" },
  running:  { dot: "bg-blue-400 animate-pulse", bg: "bg-blue-400/10", text: "text-blue-300" },
  success:  { dot: "bg-green-400",   bg: "bg-green-400/10",   text: "text-green-300" },
  failed:   { dot: "bg-red-400",     bg: "bg-red-400/10",     text: "text-red-300" },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? { dot: "bg-gray-500", bg: "bg-gray-500/10", text: "text-gray-400" };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${s.bg} ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${s.dot}`} />
      {status}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function duration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const secs = Math.round(((end ? new Date(end) : new Date()).getTime() - new Date(start).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── Filter chip ───────────────────────────────────────────────────────────────

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
        active
          ? "border-accent/60 bg-accent/20 text-gray-100"
          : "border-white/15 bg-white/5 text-gray-400 hover:border-white/30 hover:text-gray-200"
      }`}
    >
      {label}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = ["success", "failed", "running", "pending"] as const;

export default function Runs() {
  const { data: runs, isLoading, error } = useRuns();

  const [search, setSearch] = useState("");
  const [activeStatuses, setActiveStatuses] = useState<Set<string>>(new Set());
  const [newestFirst, setNewestFirst] = useState(true);

  function toggleStatus(s: string) {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  }

  const filtered: RunSummary[] = useMemo(() => {
    if (!runs) return [];
    const q = search.trim().toLowerCase();
    let result = runs.filter((r) => {
      if (activeStatuses.size > 0 && !activeStatuses.has(r.status)) return false;
      if (q && !r.pipeline_manifest_id.toLowerCase().includes(q)) return false;
      return true;
    });
    if (!newestFirst) result = [...result].reverse();
    return result;
  }, [runs, search, activeStatuses, newestFirst]);

  const filtersActive = search.trim() !== "" || activeStatuses.size > 0;

  return (
    <div className="p-6 sm:p-8 max-w-screen-xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Runs</h1>
          {runs && (
            <p className="text-xs text-gray-500 mt-0.5">
              {runs.length} run{runs.length !== 1 ? "s" : ""} total
            </p>
          )}
        </div>
        <Link
          to="/pipelines"
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
        >
          + New run
        </Link>
      </div>

      {/* Filters */}
      <div className="mb-4 space-y-3">
        {/* Search */}
        <div className="relative max-w-sm">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500"
          >
            <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clipRule="evenodd" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by pipeline…"
            className="w-full rounded-md border border-white/15 bg-surface-raised pl-8 pr-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-500 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/50"
          />
        </div>

        {/* Status chips + sort */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 shrink-0">Status:</span>
          {STATUS_OPTIONS.map((s) => (
            <FilterChip key={s} label={s} active={activeStatuses.has(s)} onClick={() => toggleStatus(s)} />
          ))}
          <div className="ml-auto flex items-center gap-2">
            {filtersActive && (
              <button
                type="button"
                onClick={() => { setSearch(""); setActiveStatuses(new Set()); }}
                className="text-xs text-accent hover:text-accent-hover focus:outline-none"
              >
                Clear filters
              </button>
            )}
            <button
              type="button"
              onClick={() => setNewestFirst((v) => !v)}
              className="flex items-center gap-1 rounded border border-white/15 bg-white/5 px-2.5 py-1 text-xs text-gray-400 hover:border-white/30 hover:text-gray-200 transition-colors focus:outline-none"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                <path d="M8.75 2.75a.75.75 0 0 0-1.5 0v8.69L5.03 9.22a.75.75 0 0 0-1.06 1.06l3.5 3.5a.75.75 0 0 0 1.06 0l3.5-3.5a.75.75 0 0 0-1.06-1.06L8.75 11.44V2.75Z" />
              </svg>
              {newestFirst ? "Newest first" : "Oldest first"}
            </button>
          </div>
        </div>
      </div>

      {/* Loading / error */}
      {isLoading && <p className="text-sm text-gray-500">Loading run history…</p>}
      {error && <p className="text-sm text-red-400">{(error as Error).message}</p>}

      {/* Empty — no runs at all */}
      {!isLoading && !error && runs?.length === 0 && (
        <div className="rounded-lg border border-white/10 bg-surface-raised px-6 py-10 text-center">
          <p className="text-sm text-gray-400">No runs yet.</p>
          <p className="text-xs text-gray-500 mt-1">
            Go to{" "}
            <Link to="/pipelines" className="text-accent hover:text-accent-hover underline-offset-2 hover:underline">
              Pipelines
            </Link>
            , select a pipeline, and start your first run.
          </p>
        </div>
      )}

      {/* Empty — filtered */}
      {!isLoading && !error && runs && runs.length > 0 && filtered.length === 0 && (
        <div className="rounded-lg border border-white/10 bg-surface-raised px-6 py-8 text-center">
          <p className="text-sm text-gray-400">No runs match these filters.</p>
          <button
            type="button"
            onClick={() => { setSearch(""); setActiveStatuses(new Set()); }}
            className="mt-2 text-xs text-accent hover:text-accent-hover focus:outline-none"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Table */}
      {filtered.length > 0 && (
        <div className="rounded-lg border border-white/10 overflow-hidden">
          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white/5 border-b border-white/10">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide w-16">#</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">Pipeline</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide w-28">Dataset</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide w-28">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide w-24">Duration</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide w-44">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filtered.map((run) => (
                  <tr key={run.id} className="group hover:bg-white/5 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        to={`/runs/${run.id}`}
                        className="font-mono text-sm font-semibold text-accent hover:text-accent-hover"
                      >
                        #{run.id}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link to={`/runs/${run.id}`} className="block min-w-0">
                        <span className="font-medium text-gray-200 group-hover:text-gray-100 truncate block max-w-xs">
                          {run.pipeline_manifest_id}
                        </span>
                        <span className="text-xs text-gray-600 font-mono">{run.pipeline_version}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                      ds #{run.dataset_id}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                      {duration(run.started_at, run.finished_at)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {formatDate(run.started_at ?? run.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="sm:hidden divide-y divide-white/5">
            {filtered.map((run) => (
              <Link
                key={run.id}
                to={`/runs/${run.id}`}
                className="flex items-start gap-3 px-4 py-3.5 hover:bg-white/5 transition-colors"
              >
                <span className="font-mono text-xs text-gray-500 pt-0.5 shrink-0">#{run.id}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-gray-200 truncate">
                      {run.pipeline_manifest_id}
                    </span>
                    <StatusBadge status={run.status} />
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-500">
                    <span>ds #{run.dataset_id}</span>
                    <span>·</span>
                    <span>{duration(run.started_at, run.finished_at)}</span>
                    <span>·</span>
                    <span>{formatDate(run.started_at ?? run.created_at)}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Count footer */}
      {filtered.length > 0 && runs && filtered.length < runs.length && (
        <p className="mt-3 text-xs text-center text-gray-500">
          Showing {filtered.length} of {runs.length} runs
        </p>
      )}
    </div>
  );
}
