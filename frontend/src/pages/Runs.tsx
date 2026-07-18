import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BarChart2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cancelRun, deleteRun, fetchQueue, retryRun, rerunRun } from "../api/client";
import type { RunSummary, RunStatus } from "../api/client";
import { useRuns } from "../hooks/useRuns";
import { EmptyState } from "../components/primitives/EmptyState";
import { useWorkspace } from "../context/WorkspaceContext";

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { dot: string; bg: string; text: string }> = {
  queued:      { dot: "bg-gray-400",   bg: "bg-gray-400/10",   text: "text-gray-300" },
  pending:     { dot: "bg-yellow-400", bg: "bg-yellow-400/10", text: "text-yellow-300" },
  running:     { dot: "bg-blue-400 animate-pulse", bg: "bg-blue-400/10", text: "text-blue-300" },
  success:     { dot: "bg-green-400",  bg: "bg-green-400/10",  text: "text-green-300" },
  failed:      { dot: "bg-red-400",    bg: "bg-red-400/10",    text: "text-red-300" },
  cancelled:   { dot: "bg-orange-400", bg: "bg-orange-400/10", text: "text-orange-300" },
  interrupted: { dot: "bg-amber-400",  bg: "bg-amber-400/10",  text: "text-amber-300" },
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

function parseUtc(iso: string): Date {
  return new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
}

function duration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const secs = Math.round(((end ? parseUtc(end) : new Date()).getTime() - parseUtc(start).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return parseUtc(iso).toLocaleString(undefined, {
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

// ── Confirmation dialog ───────────────────────────────────────────────────────

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  dangerous,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  dangerous?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-surface-raised p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-gray-100">{title}</h3>
        <p className="mt-2 text-sm text-gray-400">{message}</p>
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-white/15 bg-white/5 px-4 py-2 text-sm text-gray-300 hover:bg-white/10 transition-colors focus:outline-none"
          >
            Keep running
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors focus:outline-none ${
              dangerous
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-accent text-white hover:bg-accent-hover"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Queue banner ──────────────────────────────────────────────────────────────

function QueueBanner({ runningRunId, queuedCount }: { runningRunId: number | null; queuedCount: number }) {
  if (runningRunId === null && queuedCount === 0) return null;
  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm">
      <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse shrink-0" />
      <span className="text-blue-200">
        {runningRunId !== null && (
          <>
            Run{" "}
            <Link to={`/runs/${runningRunId}`} className="font-semibold text-blue-300 hover:underline">
              #{runningRunId}
            </Link>{" "}
            is executing.
          </>
        )}
        {queuedCount > 0 && (
          <span className={runningRunId !== null ? " " : ""}>
            {queuedCount} run{queuedCount !== 1 ? "s" : ""} waiting in queue.
          </span>
        )}
      </span>
    </div>
  );
}

// ── Action buttons ────────────────────────────────────────────────────────────

function RunActions({
  run,
  onCancel,
  onRetry,
  onRerun,
  onDelete,
}: {
  run: RunSummary;
  onCancel: (id: number) => void;
  onRetry: (id: number) => void;
  onRerun: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  const active = run.status === "queued" || run.status === "running" || run.status === "pending";
  const canRetry = run.status === "failed" || run.status === "cancelled" || run.status === "interrupted";
  const canRerun = run.status === "success";
  const canDelete = run.status === "success" || run.status === "failed" || run.status === "cancelled" || run.status === "interrupted";

  return (
    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {active && (
        <button
          type="button"
          onClick={() => onCancel(run.id)}
          className="rounded border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-xs text-red-300 hover:bg-red-500/20 transition-colors focus:outline-none"
        >
          Cancel
        </button>
      )}
      {canRetry && (
        <button
          type="button"
          onClick={() => onRetry(run.id)}
          className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300 hover:bg-amber-500/20 transition-colors focus:outline-none"
        >
          Retry
        </button>
      )}
      {canRerun && (
        <button
          type="button"
          onClick={() => onRerun(run.id)}
          className="rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs text-accent hover:bg-accent/20 transition-colors focus:outline-none"
        >
          Re-run
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          onClick={() => onDelete(run.id)}
          className="rounded border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-gray-500 hover:bg-white/10 hover:text-gray-300 transition-colors focus:outline-none"
          title="Delete run record"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const STATUS_OPTIONS: RunStatus[] = ["success", "failed", "running", "queued", "cancelled", "interrupted"];

export default function Runs() {
  const { selected, cloudProfiles } = useWorkspace();
  const { data: runs, isLoading, error } = useRuns();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  if (window.neuroforgeDesktop && selected.startsWith("cloud:")) {
    const profileId = selected.slice(6);
    const profile = cloudProfiles.find((p) => p.id === profileId);
    return (
      <div className="p-6 sm:p-8 max-w-screen-xl mx-auto">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-100">Runs</h1>
          <p className="text-xs text-gray-500 mt-0.5">Cloud workspace selected</p>
        </div>
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-6">
          <p className="text-sm font-medium text-cyan-200">
            Viewing cloud workspace: <span className="font-semibold">{profile?.name ?? profileId}</span>
          </p>
          <p className="mt-2 text-xs text-slate-400">
            Cloud runs are managed in the Workspace view, where you can browse artifacts,
            download files, and launch external viewers.
          </p>
          <Link
            to={`/workspaces?scope=${selected}&view=runs`}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-cyan-500/20 border border-cyan-400/30 px-4 py-2 text-sm font-medium text-cyan-200 hover:bg-cyan-500/30 transition-colors"
          >
            Open Cloud Runs in Workspace
          </Link>
        </div>
        <div className="mt-8">
          <h2 className="text-base font-semibold text-gray-400 mb-3">Local Runs</h2>
        </div>
      </div>
    );
  }

  const { data: queue } = useQuery({
    queryKey: ["run-queue"],
    queryFn: fetchQueue,
    refetchInterval: 3000,
  });

  const [search, setSearch] = useState("");
  const [activeStatuses, setActiveStatuses] = useState<Set<string>>(new Set());
  const [newestFirst, setNewestFirst] = useState(true);
  const [pendingCancel, setPendingCancel] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  async function handleCancel(runId: number) {
    setActionError(null);
    try {
      await cancelRun(runId);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      await queryClient.invalidateQueries({ queryKey: ["run-queue"] });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setPendingCancel(null);
    }
  }

  async function handleRetry(runId: number) {
    setActionError(null);
    try {
      const newRun = await retryRun(runId);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      await queryClient.invalidateQueries({ queryKey: ["run-queue"] });
      navigate(`/runs/${newRun.id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Retry failed");
    }
  }

  async function handleRerun(runId: number) {
    setActionError(null);
    try {
      const newRun = await rerunRun(runId);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      await queryClient.invalidateQueries({ queryKey: ["run-queue"] });
      navigate(`/runs/${newRun.id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Re-run failed");
    }
  }

  async function handleDelete(runId: number) {
    setActionError(null);
    try {
      await deleteRun(runId);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setPendingDelete(null);
    }
  }

  return (
    <div className="p-6 sm:p-8 max-w-screen-xl mx-auto">
      {/* Confirm dialogs */}
      {pendingCancel !== null && (
        <ConfirmDialog
          title="Cancel run?"
          message={`Stop run #${pendingCancel}? Logs and any partial output will be preserved.`}
          confirmLabel="Cancel run"
          dangerous
          onConfirm={() => handleCancel(pendingCancel)}
          onCancel={() => setPendingCancel(null)}
        />
      )}
      {pendingDelete !== null && (
        <ConfirmDialog
          title="Delete run record?"
          message={`Remove run #${pendingDelete} from the database? Output files on disk will not be deleted.`}
          confirmLabel="Delete record"
          dangerous
          onConfirm={() => handleDelete(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

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
        <div className="flex gap-2">
          {/* Link to report for the dataset of the most recent run */}
          {runs && runs.length > 0 && runs[0].dataset_id && (
            <Link
              to={`/datasets/${runs[0].dataset_id}/reports`}
              className="rounded-md border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              <BarChart2 className="mr-1.5 inline h-3.5 w-3.5" />Dataset Report
            </Link>
          )}
          <Link
            to="/pipelines"
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            + New run
          </Link>
        </div>
      </div>

      {/* Queue banner */}
      <QueueBanner
        runningRunId={queue?.running_run_id ?? null}
        queuedCount={queue?.queued.length ?? 0}
      />

      {/* Action error */}
      {actionError && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 flex items-center justify-between">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="text-red-400 hover:text-red-200 ml-4 text-lg leading-none">×</button>
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 space-y-3">
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
        <EmptyState
          title="No completed runs."
          description="Go to Pipelines, select a pipeline, and start your first run."
          action={
            <Link
              to="/pipelines"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
            >
              Browse Pipelines
            </Link>
          }
          hint="Tip: Use the Workflow Builder to chain multiple pipelines together before running."
        />
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
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide w-32">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide w-24">Duration</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide w-40">Started</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide w-40">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filtered.map((run) => {
                  const queueEntry = queue?.queued.find((q) => q.run_id === run.id);
                  return (
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
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-gray-200 group-hover:text-gray-100 truncate max-w-xs">
                              {run.pipeline_manifest_id}
                            </span>
                            {run.remote_host_id && (
                              <span className="shrink-0 rounded bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 text-xs text-violet-300 font-mono">
                                remote
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-gray-600 font-mono">{run.pipeline_version}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                        ds #{run.dataset_id}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-0.5">
                          <StatusBadge status={run.status} />
                          {queueEntry && (
                            <span className="text-xs text-gray-500">position {queueEntry.position}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                        {duration(run.started_at, run.finished_at)}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {formatDate(run.started_at ?? run.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <RunActions
                          run={run}
                          onCancel={(id) => setPendingCancel(id)}
                          onRetry={handleRetry}
                          onRerun={handleRerun}
                          onDelete={(id) => setPendingDelete(id)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="sm:hidden divide-y divide-white/5">
            {filtered.map((run) => (
              <div key={run.id} className="px-4 py-3.5 hover:bg-white/5 transition-colors">
                <div className="flex items-start gap-3">
                  <Link to={`/runs/${run.id}`} className="font-mono text-xs text-gray-500 pt-0.5 shrink-0">
                    #{run.id}
                  </Link>
                  <div className="min-w-0 flex-1">
                    <Link to={`/runs/${run.id}`} className="block">
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
                    </Link>
                    <div className="mt-2">
                      <RunActions
                        run={run}
                        onCancel={(id) => setPendingCancel(id)}
                        onRetry={handleRetry}
                        onRerun={handleRerun}
                        onDelete={(id) => setPendingDelete(id)}
                      />
                    </div>
                  </div>
                </div>
              </div>
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
