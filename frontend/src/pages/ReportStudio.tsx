import { useState, useEffect } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { ArrowRight, BarChart2, FileText, FileCode, Archive, RotateCcw, Trash2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  generateReport,
  listReports,
  getReport,
  deleteReport,
  retryReport,
  reportDownloadUrl,
  type ReportSummary,
} from "../api/client";

// ── Status polling hook ────────────────────────────────────────────────────────

function usePollingReport(datasetId: number, reportId: number | null) {
  return useQuery({
    queryKey: ["report", datasetId, reportId],
    queryFn: () => getReport(datasetId, reportId!),
    enabled: reportId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "generating" ? 1500 : false;
    },
    staleTime: 0,
  });
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ReportSummary["status"] }) {
  const colors: Record<string, string> = {
    generating: "bg-blue-500/15 text-blue-300",
    ready: "bg-green-500/15 text-green-300",
    failed: "bg-red-500/15 text-red-300",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${colors[status] ?? "bg-white/10 text-gray-400"}`}>
      {status === "generating" && (
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3V0a12 12 0 100 24V20l-3-3 3-3v-4a8 8 0 01-8-8z"/>
        </svg>
      )}
      {status}
    </span>
  );
}

// ── Download buttons ──────────────────────────────────────────────────────────

function DownloadButtons({ datasetId, reportId, hasPdf }: { datasetId: number; reportId: number; hasPdf: boolean }) {
  const formats: { fmt: "html" | "md" | "json" | "zip" | "pdf"; label: string; icon: React.ReactNode; available?: boolean }[] = [
    { fmt: "html", label: "HTML", icon: <FileCode className="h-3.5 w-3.5" /> },
    { fmt: "pdf", label: "PDF", icon: <FileText className="h-3.5 w-3.5" />, available: hasPdf },
    { fmt: "md", label: "Markdown", icon: <FileText className="h-3.5 w-3.5" /> },
    { fmt: "json", label: "JSON", icon: <FileCode className="h-3.5 w-3.5" /> },
    { fmt: "zip", label: "Supplement ZIP", icon: <Archive className="h-3.5 w-3.5" /> },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {formats.filter(f => f.available !== false).map(({ fmt, label, icon }) => (
        <a
          key={fmt}
          href={reportDownloadUrl(datasetId, reportId, fmt)}
          download
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-300 hover:border-white/25 hover:text-white transition-colors"
        >
          {icon} {label}
        </a>
      ))}
    </div>
  );
}

// ── Report card ───────────────────────────────────────────────────────────────

function ReportCard({
  report,
  datasetId,
  active,
  selected,
  onSelect,
  onDeleted,
  onRetried,
}: {
  report: ReportSummary;
  datasetId: number;
  active: boolean;
  selected: boolean;
  onSelect: (id: number) => void;
  onDeleted: () => void;
  onRetried: (id: number) => void;
}) {
  const date = new Date(report.created_at).toLocaleString();

  const del = useMutation({
    mutationFn: () => deleteReport(datasetId, report.id),
    onSuccess: onDeleted,
  });

  const retry = useMutation({
    mutationFn: () => retryReport(datasetId, report.id),
    onSuccess: (data) => onRetried(data.report_id),
  });

  return (
    <div className={`rounded-lg border p-4 transition-colors ${active ? "border-accent/60 bg-surface-raised" : "border-white/8 bg-surface-raised hover:border-white/15"}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-start gap-3">
          {/* Compare checkbox — only for ready reports */}
          {report.status === "ready" && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onSelect(report.id)}
              title="Select for comparison"
              className="mt-1 h-3.5 w-3.5 rounded accent-accent cursor-pointer shrink-0"
            />
          )}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium text-gray-200">Report #{report.id}</span>
              <StatusBadge status={report.status} />
            </div>
            <p className="text-xs text-gray-500">{date}</p>
            {report.finished_at && report.status === "ready" && (
              <p className="text-xs text-gray-600 mt-0.5">
                Finished {new Date(report.finished_at).toLocaleString()}
                {report.pdf_path && <span className="ml-2 text-green-500/70">· PDF ✓</span>}
              </p>
            )}
            {report.error_message && (
              <details className="mt-1">
                <summary className="text-xs text-red-400 cursor-pointer select-none">
                  Error details ▸
                </summary>
                <pre className="mt-1 text-xs text-red-300/70 bg-red-900/10 rounded p-2 overflow-auto max-h-24 whitespace-pre-wrap">
                  {report.error_message}
                </pre>
              </details>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {report.status === "failed" && (
            <>
              <button
                onClick={() => retry.mutate()}
                disabled={retry.isPending}
                className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-300 hover:bg-blue-500/20 disabled:opacity-50 transition-colors"
              >
                {retry.isPending ? "Retrying…" : <><RotateCcw className="mr-1 inline h-3 w-3" aria-hidden="true" />Retry</>}
              </button>
              <button
                onClick={() => del.mutate()}
                disabled={del.isPending}
                className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50 transition-colors"
              >
                {del.isPending ? "Deleting…" : <><Trash2 className="mr-1 inline h-3 w-3" aria-hidden="true" />Delete</>}
              </button>
            </>
          )}
          {report.status === "ready" && (
            <Link
              to={`/datasets/${datasetId}/reports/${report.id}`}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors"
            >
              View <ArrowRight className="ml-1 inline h-3 w-3" aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>
      {report.status === "ready" && (
        <div className="mt-3 pt-3 border-t border-white/5">
          <DownloadButtons datasetId={datasetId} reportId={report.id} hasPdf={!!report.pdf_path} />
        </div>
      )}
    </div>
  );
}

// ── Filter tabs ───────────────────────────────────────────────────────────────

type Filter = "all" | "ready" | "generating" | "failed";

function FilterTabs({ value, onChange, counts }: {
  value: Filter;
  onChange: (f: Filter) => void;
  counts: Record<Filter, number>;
}) {
  const tabs: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "ready", label: "Ready" },
    { id: "generating", label: "Generating" },
    { id: "failed", label: "Failed" },
  ];
  return (
    <div className="flex gap-1 border-b border-white/8 mb-4">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-4 py-2 text-xs font-medium transition-colors flex items-center gap-1.5 ${
            value === t.id
              ? "text-white border-b-2 border-accent -mb-px"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          {t.label}
          {counts[t.id] > 0 && (
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
              value === t.id ? "bg-accent/20 text-accent" : "bg-white/8 text-gray-500"
            }`}>
              {counts[t.id]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportStudio() {
  const { id } = useParams<{ id: string }>();
  const datasetId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [generatingId, setGeneratingId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("ready");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const { data: reports = [], refetch } = useQuery({
    queryKey: ["reports", datasetId],
    queryFn: () => listReports(datasetId),
    staleTime: 5000,
  });

  const { data: polled } = usePollingReport(datasetId, generatingId);

  useEffect(() => {
    if (polled?.status === "ready" || polled?.status === "failed") {
      setGeneratingId(null);
      refetch();
      if (polled.status === "ready") {
        navigate(`/datasets/${datasetId}/reports/${polled.id}`);
      }
    }
  }, [polled?.status, polled?.id, datasetId, navigate, refetch]);

  const generate = useMutation({
    mutationFn: () => generateReport(datasetId),
    onSuccess: (data) => {
      setGeneratingId(data.report_id);
      setFilter("generating");
      qc.invalidateQueries({ queryKey: ["reports", datasetId] });
    },
  });

  const isGenerating = generatingId !== null || generate.isPending;

  const counts: Record<Filter, number> = {
    all: reports.length,
    ready: reports.filter((r) => r.status === "ready").length,
    generating: reports.filter((r) => r.status === "generating").length,
    failed: reports.filter((r) => r.status === "failed").length,
  };

  const visible = reports.filter((r) => filter === "all" || r.status === filter);

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= 2) next.clear();
        next.add(id);
      }
      return next;
    });
  };

  const [selA, selB] = Array.from(selected).sort((a, b) => a - b);
  const canCompare = selected.size === 2;

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Study Report Studio</h1>
          <p className="text-sm text-gray-400 mt-1">
            Generate a reproducible report draft for this dataset.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {canCompare && (
            <Link
              to={`/datasets/${datasetId}/reports/compare?a=${selA}&b=${selB}`}
              className="rounded-md border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-sm font-medium text-blue-300 hover:bg-blue-500/20 transition-colors"
            >
              Compare #{selA} vs #{selB}
            </Link>
          )}
          <button
            onClick={() => generate.mutate()}
            disabled={isGenerating}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isGenerating ? "Generating…" : "+ Generate Report"}
          </button>
        </div>
      </div>

      {isGenerating && generatingId && (
        <div className="mb-4 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-300">
          <span className="font-medium">Generating report #{generatingId}…</span>
          {" "}Aggregating runs, artifacts, methods, figures, and PDF. This takes 20–60 s.
        </div>
      )}

      {canCompare && (
        <div className="mb-4 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-2.5 text-xs text-blue-300 flex items-center justify-between">
          <span>2 reports selected for comparison.</span>
          <button onClick={() => setSelected(new Set())} className="text-blue-400 hover:text-blue-200">
            Clear selection
          </button>
        </div>
      )}
      {selected.size === 1 && (
        <div className="mb-4 rounded-lg border border-white/8 px-4 py-2.5 text-xs text-gray-500">
          Select one more ready report to compare.
        </div>
      )}

      {reports.length > 0 && (
        <FilterTabs value={filter} onChange={setFilter} counts={counts} />
      )}

      {visible.length === 0 && !isGenerating ? (
        <div className="rounded-lg border border-dashed border-white/10 p-10 text-center">
          <BarChart2 className="mx-auto mb-3 h-8 w-8 text-gray-600" />
          <p className="text-sm font-medium text-gray-300">
            {reports.length === 0 ? "No reports yet" : `No ${filter} reports`}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {reports.length === 0
              ? 'Click "Generate Report" to create a study report draft from recorded runs.'
              : `Switch to "All" to see reports with other statuses.`}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((r) => (
            <ReportCard
              key={r.id}
              report={r}
              datasetId={datasetId}
              active={r.id === generatingId}
              selected={selected.has(r.id)}
              onSelect={toggleSelect}
              onDeleted={() => {
                qc.invalidateQueries({ queryKey: ["reports", datasetId] });
              }}
              onRetried={(newId) => {
                setGeneratingId(newId);
                setFilter("generating");
                qc.invalidateQueries({ queryKey: ["reports", datasetId] });
              }}
            />
          ))}
        </div>
      )}

      <div className="mt-8 rounded-lg border border-white/5 bg-surface-raised p-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">What's included</h3>
        <ul className="text-xs text-gray-400 space-y-1.5">
          {[
            "Dataset summary (subjects, sessions, modalities, BIDS status)",
            "Pipeline summary table (versions, runtimes, artifact counts)",
            "All figures from successful runs (embedded)",
            "Artifact inventory across all analyses",
            "Auto-generated methods prose for each pipeline",
            "Software versions and APA/BibTeX citations",
            "Reproducibility checklist",
            "PDF export via headless Chromium (same layout as HTML)",
            "Supplement ZIP (parameters TSV, BibTeX, provenance JSON)",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2">
              <span className="text-green-400 mt-0.5">✓</span>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
