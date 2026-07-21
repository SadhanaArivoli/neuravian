import { useState, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useDataset, useDatasetScans, useDatasetDashboard } from "../hooks/useDatasets";
import { useRuns } from "../hooks/useRuns";
import type { DatasetScan, RunSummary } from "../api/client";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const PIPELINE_LABELS: Record<string, string> = {
  mriqc: "MRIQC",
  fmriprep: "fMRIPrep",
  fastsurfer: "FastSurfer",
  freesurfer: "FreeSurfer",
  pydeface: "pydeface",
  fsl: "FSL",
};

function pipelineLabel(id: string): string {
  return PIPELINE_LABELS[id] ?? id;
}

function statusColor(status: string): string {
  switch (status) {
    case "success": return "text-green-400";
    case "failed": return "text-red-400";
    case "running": return "text-blue-400";
    case "queued": return "text-yellow-400";
    default: return "text-gray-500";
  }
}

function statusDot(status: string): string {
  switch (status) {
    case "success": return "bg-green-400";
    case "failed": return "bg-red-400";
    case "running": return "bg-blue-400 animate-pulse";
    case "queued": return "bg-yellow-400";
    default: return "bg-gray-600";
  }
}

// ── Subject row derived from scans + runs ─────────────────────────────────────

interface SubjectRow {
  subject: string;
  sessions: string[];
  datatypes: string[];
  suffixes: string[];
  pipelines: string[];
  latestStatus: string | null;
}

function buildSubjectRows(
  scans: DatasetScan[],
  runs: RunSummary[],
  datasetId: number,
): SubjectRow[] {
  const bySubject = new Map<string, { sessions: Set<string>; datatypes: Set<string>; suffixes: Set<string> }>();
  for (const scan of scans) {
    if (!bySubject.has(scan.subject)) {
      bySubject.set(scan.subject, { sessions: new Set(), datatypes: new Set(), suffixes: new Set() });
    }
    const row = bySubject.get(scan.subject)!;
    if (scan.session) row.sessions.add(scan.session);
    if (scan.datatype) row.datatypes.add(scan.datatype);
    row.suffixes.add(scan.suffix);
  }

  // Runs don't have per-subject status, so we surface dataset-level pipeline completion
  const datasetRuns = runs.filter((r) => r.dataset_id === datasetId);
  const pipelineIds = [...new Set(datasetRuns.map((r) => r.pipeline_manifest_id))];
  // Most recent run per pipeline
  const latestByPipeline = new Map<string, RunSummary>();
  for (const run of datasetRuns) {
    const existing = latestByPipeline.get(run.pipeline_manifest_id);
    if (!existing || run.id > existing.id) latestByPipeline.set(run.pipeline_manifest_id, run);
  }

  return [...bySubject.entries()].map(([subject, { sessions, datatypes, suffixes }]) => ({
    subject,
    sessions: [...sessions].sort(),
    datatypes: [...datatypes].sort(),
    suffixes: [...suffixes].sort(),
    pipelines: pipelineIds,
    latestStatus: null,
  }));
}

// ── Derivatives section ───────────────────────────────────────────────────────

interface DerivativeRow {
  pipeline: string;
  label: string;
  runCount: number;
  latestRun: RunSummary | null;
  successCount: number;
  failedCount: number;
  storageBytes: number;
}

function buildDerivatives(
  runs: RunSummary[],
  datasetId: number,
  storageByPipeline: Record<string, number>,
): DerivativeRow[] {
  const datasetRuns = runs.filter((r) => r.dataset_id === datasetId);
  const byPipeline = new Map<string, RunSummary[]>();
  for (const run of datasetRuns) {
    if (!byPipeline.has(run.pipeline_manifest_id)) byPipeline.set(run.pipeline_manifest_id, []);
    byPipeline.get(run.pipeline_manifest_id)!.push(run);
  }
  return [...byPipeline.entries()].map(([pipeline, pRuns]) => {
    const sorted = [...pRuns].sort((a, b) => b.id - a.id);
    return {
      pipeline,
      label: pipelineLabel(pipeline),
      runCount: pRuns.length,
      latestRun: sorted[0] ?? null,
      successCount: pRuns.filter((r) => r.status === "success").length,
      failedCount: pRuns.filter((r) => r.status === "failed").length,
      storageBytes: storageByPipeline[pipeline] ?? 0,
    };
  });
}

// ── Quick action button ───────────────────────────────────────────────────────

interface QuickActionProps {
  label: string;
  pipelineId: string;
  datasetId: number;
  datasetPath: string;
}

function QuickAction({ label, pipelineId, datasetId, datasetPath }: QuickActionProps) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() =>
        navigate("/pipelines", {
          state: {
            selectPipeline: pipelineId,
            prefill: {
              datasetId,
              datasetPath,
              isDatasetSlot: true,
              artifactType: "bids_dataset",
              artifactLabel: "BIDS Dataset",
            },
          },
        })
      }
      className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
    >
      {label}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DatasetDetail() {
  const { id } = useParams<{ id: string }>();
  const datasetId = Number(id);
  const navigate = useNavigate();

  const { data: dataset, isLoading: datasetLoading, isError: datasetError } = useDataset(datasetId);
  const { data: scansData, isLoading: scansLoading } = useDatasetScans(datasetId);
  const { data: dashboard } = useDatasetDashboard(datasetId);
  const { data: allRuns } = useRuns();

  const [subjectSearch, setSubjectSearch] = useState("");
  const [subjectSort, setSubjectSort] = useState<"subject" | "sessions" | "datatypes">("subject");
  const [subjectSortAsc, setSubjectSortAsc] = useState(true);
  const [modalityFilter, setModalityFilter] = useState<string>("all");

  const runs = allRuns ?? [];
  const scans = scansData?.scans ?? [];

  const subjectRows = useMemo(
    () => buildSubjectRows(scans, runs, datasetId),
    [scans, runs, datasetId],
  );

  const allModalities = useMemo(() => {
    const s = new Set<string>();
    for (const scan of scans) if (scan.datatype) s.add(scan.datatype);
    return [...s].sort();
  }, [scans]);

  const filteredSubjects = useMemo(() => {
    let rows = subjectRows;
    if (subjectSearch) {
      const q = subjectSearch.toLowerCase();
      rows = rows.filter((r) => r.subject.toLowerCase().includes(q));
    }
    if (modalityFilter !== "all") {
      rows = rows.filter((r) => r.datatypes.includes(modalityFilter));
    }
    rows = [...rows].sort((a, b) => {
      let cmp = 0;
      if (subjectSort === "subject") cmp = a.subject.localeCompare(b.subject);
      else if (subjectSort === "sessions") cmp = a.sessions.length - b.sessions.length;
      else if (subjectSort === "datatypes") cmp = a.datatypes.length - b.datatypes.length;
      return subjectSortAsc ? cmp : -cmp;
    });
    return rows;
  }, [subjectRows, subjectSearch, modalityFilter, subjectSort, subjectSortAsc]);

  const derivatives = useMemo(
    () => buildDerivatives(runs, datasetId, dashboard?.storage.by_pipeline ?? {}),
    [runs, datasetId, dashboard],
  );

  const datasetRuns = runs.filter((r) => r.dataset_id === datasetId);

  function toggleSort(col: typeof subjectSort) {
    if (subjectSort === col) setSubjectSortAsc((v) => !v);
    else { setSubjectSort(col); setSubjectSortAsc(true); }
  }

  function SortIndicator({ col }: { col: typeof subjectSort }) {
    if (subjectSort !== col) return <span className="text-gray-700 ml-1">↕</span>;
    return <span className="text-accent ml-1">{subjectSortAsc ? "↑" : "↓"}</span>;
  }

  if (datasetLoading) {
    return <div className="p-8"><p className="text-sm text-gray-400 animate-pulse">Loading…</p></div>;
  }

  if (datasetError || !dataset) {
    return (
      <div className="p-8">
        <p className="text-sm text-red-400">Dataset not found.</p>
        <Link to="/datasets" className="mt-2 text-xs text-accent hover:underline block">← Back to datasets</Link>
      </div>
    );
  }

  const meta = dataset.indexed_metadata;
  const isValid = dataset.validation_status === "valid";
  const totalSize = dashboard?.storage.total_bytes ?? 0;
  const pipelineRunCounts = dashboard?.run_stats.pipeline_run_counts ?? {};

  return (
    <div className="p-6 lg:p-8 max-w-6xl space-y-8">
      {/* Breadcrumb */}
      <Link to="/datasets" className="text-xs text-gray-500 hover:text-gray-300 block">← Datasets</Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold mb-1">{dataset.name ?? dataset.path}</h2>
          <p className="text-xs text-gray-500 font-mono truncate max-w-xl">{dataset.path}</p>
        </div>
        <nav className="flex flex-wrap gap-2">
          <Link to={`/datasets/${datasetId}/dashboard`} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors">
            Dashboard
          </Link>
          <Link to={`/datasets/${datasetId}/artifacts`} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors">
            Artifacts
          </Link>
          <Link to={`/datasets/${datasetId}/graph`} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors">
            Analysis Graph
          </Link>
          <Link to={`/datasets/${datasetId}/methods`} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors">
            Methods
          </Link>
          <Link to={`/datasets/${datasetId}/reports`} className="flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent hover:border-accent/60 hover:bg-accent/15 transition-colors">
            Study Report
          </Link>
        </nav>
      </div>

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Overview</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="BIDS Valid">
            <span className={isValid ? "text-green-400 font-semibold" : "text-yellow-400 font-semibold"}>
              {isValid ? "Valid" : dataset.validation_status === "invalid" ? "Invalid" : "Not checked"}
            </span>
            {dataset.bids_version && (
              <span className="text-gray-500 text-xs block">{dataset.bids_version}</span>
            )}
          </StatCard>
          <StatCard label="Subjects">
            <span className="text-2xl font-mono font-semibold tabular-nums">
              {dataset.subject_count ?? meta?.subjects.length ?? "—"}
            </span>
          </StatCard>
          <StatCard label="Sessions">
            <span className="text-2xl font-mono font-semibold tabular-nums">
              {meta?.sessions.length === 0 ? "1 (no sessions)" : (meta?.sessions.length ?? "—")}
            </span>
          </StatCard>
          <StatCard label="Modalities">
            <div className="flex flex-wrap gap-1 mt-1">
              {(meta?.datatypes ?? []).map((d) => (
                <span key={d} className="rounded bg-white/10 px-1.5 py-0.5 text-xs font-mono">{d}</span>
              ))}
              {!meta?.datatypes.length && <span className="text-gray-500">—</span>}
            </div>
          </StatCard>
          <StatCard label="Total Size">
            <span className="text-xl font-mono font-semibold">{fmtBytes(totalSize)}</span>
          </StatCard>
          <StatCard label="Last Modified">
            <span className="text-sm">{fmtDate(dataset.updated_at)}</span>
          </StatCard>
        </div>

        {/* Pipeline processing status bar */}
        {Object.keys(pipelineRunCounts).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(pipelineRunCounts).map(([pid, count]) => (
              <span key={pid} className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-300">
                <span>{pipelineLabel(pid)}</span>
                <span className="text-gray-500">{count} run{count !== 1 ? "s" : ""}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── Quick Actions ─────────────────────────────────────────────────── */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Quick Actions</h3>
        <div className="flex flex-wrap gap-2">
          <QuickAction label="Launch MRIQC" pipelineId="mriqc" datasetId={datasetId} datasetPath={dataset.path} />
          <QuickAction label="Launch fMRIPrep" pipelineId="fmriprep" datasetId={datasetId} datasetPath={dataset.path} />
          <QuickAction label="Launch FastSurfer" pipelineId="fastsurfer" datasetId={datasetId} datasetPath={dataset.path} />
          <QuickAction label="Launch FreeSurfer" pipelineId="freesurfer" datasetId={datasetId} datasetPath={dataset.path} />
          <QuickAction label="Launch pydeface" pipelineId="pydeface" datasetId={datasetId} datasetPath={dataset.path} />
          {window.neuroforgeDesktop && (
            <button
              onClick={() => {
                const el = document.createElement("a");
                el.href = `file://${dataset.path}`;
                el.click();
              }}
              className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              Reveal in Finder
            </button>
          )}
        </div>
      </section>

      {/* ── Subjects ─────────────────────────────────────────────────────── */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Subjects
            {!scansLoading && <span className="ml-2 text-gray-600 normal-case font-normal">{filteredSubjects.length} shown</span>}
          </h3>
          <div className="flex gap-2">
            <input
              type="text"
              aria-label="Search subjects"
              placeholder="Search subjects…"
              value={subjectSearch}
              onChange={(e) => setSubjectSearch(e.target.value)}
              className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-accent/50 w-48"
            />
            <select
              aria-label="Filter subjects by modality"
              value={modalityFilter}
              onChange={(e) => setModalityFilter(e.target.value)}
              className="rounded-md border border-white/10 bg-[#1a1a2e] px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-accent/50"
            >
              <option value="all">All modalities</option>
              {allModalities.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        {scansLoading ? (
          <p className="text-xs text-gray-500 animate-pulse">Loading subjects…</p>
        ) : filteredSubjects.length === 0 ? (
          <p className="text-xs text-gray-500">No subjects found.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/10 text-gray-500">
                  <th
                    className="text-left px-4 py-2.5 font-medium cursor-pointer hover:text-gray-300 select-none"
                    onClick={() => toggleSort("subject")}
                  >
                    Subject <SortIndicator col="subject" />
                  </th>
                  <th
                    className="text-left px-4 py-2.5 font-medium cursor-pointer hover:text-gray-300 select-none"
                    onClick={() => toggleSort("sessions")}
                  >
                    Sessions <SortIndicator col="sessions" />
                  </th>
                  <th
                    className="text-left px-4 py-2.5 font-medium cursor-pointer hover:text-gray-300 select-none"
                    onClick={() => toggleSort("datatypes")}
                  >
                    Modalities <SortIndicator col="datatypes" />
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium">Suffixes</th>
                </tr>
              </thead>
              <tbody>
                {filteredSubjects.map((row, i) => (
                  <tr
                    key={row.subject}
                    className={`border-b border-white/5 hover:bg-white/5 ${i % 2 === 0 ? "" : "bg-white/[0.02]"}`}
                  >
                    <td className="px-4 py-2.5 font-mono font-medium text-gray-200">sub-{row.subject}</td>
                    <td className="px-4 py-2.5 text-gray-400">
                      {row.sessions.length === 0 ? (
                        <span className="text-gray-600">—</span>
                      ) : (
                        <span>{row.sessions.length} ({row.sessions.slice(0, 3).join(", ")}{row.sessions.length > 3 ? "…" : ""})</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {row.datatypes.map((d) => (
                          <span key={d} className="rounded bg-white/10 px-1.5 py-0.5 text-xs font-mono">{d}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500 font-mono">{row.suffixes.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Derivatives ──────────────────────────────────────────────────── */}
      {derivatives.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Derivatives</h3>
          <div className="space-y-2">
            {derivatives.map((deriv) => (
              <div
                key={deriv.pipeline}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/[0.07] transition-colors cursor-pointer"
                onClick={() => navigate(`/runs?pipeline=${deriv.pipeline}&dataset=${datasetId}`)}
              >
                <div className="flex items-center gap-3">
                  {deriv.latestRun && (
                    <div className={`h-2 w-2 rounded-full flex-shrink-0 ${statusDot(deriv.latestRun.status)}`} />
                  )}
                  <span className="font-medium text-sm text-gray-200">{deriv.label}</span>
                  {deriv.latestRun && (
                    <span className={`text-xs ${statusColor(deriv.latestRun.status)}`}>
                      {deriv.latestRun.status}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-6 text-xs text-gray-500">
                  <span>{deriv.runCount} run{deriv.runCount !== 1 ? "s" : ""}</span>
                  {deriv.successCount > 0 && <span className="text-green-500">{deriv.successCount} passed</span>}
                  {deriv.failedCount > 0 && <span className="text-red-500">{deriv.failedCount} failed</span>}
                  {deriv.storageBytes > 0 && <span>{fmtBytes(deriv.storageBytes)}</span>}
                  {deriv.latestRun?.finished_at && (
                    <span>Last: {fmtDate(deriv.latestRun.finished_at)}</span>
                  )}
                  <span className="text-gray-600 text-xs">View runs →</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Recent Runs ──────────────────────────────────────────────────── */}
      {datasetRuns.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Recent Runs</h3>
            <Link to="/runs" className="text-xs text-accent hover:underline">View all →</Link>
          </div>
          <div className="space-y-1.5">
            {[...datasetRuns].sort((a, b) => b.id - a.id).slice(0, 6).map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between rounded-md border border-white/8 bg-white/[0.03] px-4 py-2.5 hover:bg-white/[0.06] transition-colors cursor-pointer"
                onClick={() => navigate(`/runs/${run.id}`)}
              >
                <div className="flex items-center gap-3">
                  <div className={`h-2 w-2 rounded-full flex-shrink-0 ${statusDot(run.status)}`} />
                  <span className="text-xs font-medium text-gray-300">
                    {pipelineLabel(run.pipeline_manifest_id)}
                  </span>
                  <span className="text-xs text-gray-600 font-mono">#{run.id}</span>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span className={statusColor(run.status)}>{run.status}</span>
                  <span>{fmtDate(run.finished_at ?? run.started_at ?? run.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Validation issues ────────────────────────────────────────────── */}
      {dataset.validation_issues && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Validation Issues</h3>
          {dataset.validation_issues.errors.length > 0 && (
            <div className="mb-2 space-y-1">
              {dataset.validation_issues.errors.map((e, i) => (
                <div key={i} className="flex gap-2 rounded-md bg-red-900/20 border border-red-800/30 px-3 py-2 text-xs text-red-300">
                  <span className="font-semibold shrink-0">Error</span>
                  <span>{e.message}</span>
                </div>
              ))}
            </div>
          )}
          {dataset.validation_issues.warnings.length > 0 && (
            <div className="space-y-1">
              {dataset.validation_issues.warnings.slice(0, 5).map((w, i) => (
                <div key={i} className="flex gap-2 rounded-md bg-yellow-900/20 border border-yellow-800/30 px-3 py-2 text-xs text-yellow-300">
                  <span className="font-semibold shrink-0">Warn</span>
                  <span>{w.message}</span>
                </div>
              ))}
              {dataset.validation_issues.warnings.length > 5 && (
                <p className="text-xs text-gray-500 px-1">
                  +{dataset.validation_issues.warnings.length - 5} more warnings
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-4 py-3">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      {children}
    </div>
  );
}
