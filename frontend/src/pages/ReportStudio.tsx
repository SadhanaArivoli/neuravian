import { useState, useEffect } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  generateReport,
  listReports,
  getReport,
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

function DownloadButtons({ datasetId, reportId }: { datasetId: number; reportId: number }) {
  const formats = [
    { fmt: "html" as const, label: "HTML", icon: "📄" },
    { fmt: "md" as const, label: "Markdown", icon: "📝" },
    { fmt: "json" as const, label: "JSON", icon: "🗂" },
    { fmt: "zip" as const, label: "Supplement ZIP", icon: "🗜" },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {formats.map(({ fmt, label, icon }) => (
        <a
          key={fmt}
          href={reportDownloadUrl(datasetId, reportId, fmt)}
          download
          className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-300 hover:border-white/25 hover:text-white transition-colors"
        >
          <span>{icon}</span> {label}
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
}: {
  report: ReportSummary;
  datasetId: number;
  active: boolean;
}) {
  const date = new Date(report.created_at).toLocaleString();
  return (
    <div className={`rounded-lg border p-4 transition-colors ${active ? "border-accent/60 bg-surface-raised" : "border-white/8 bg-surface-raised hover:border-white/15"}`}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-gray-200">Report #{report.id}</span>
            <StatusBadge status={report.status} />
          </div>
          <p className="text-xs text-gray-500">{date}</p>
          {report.finished_at && report.status === "ready" && (
            <p className="text-xs text-gray-600 mt-0.5">
              Finished {new Date(report.finished_at).toLocaleString()}
            </p>
          )}
          {report.error_message && (
            <p className="text-xs text-red-400 mt-1 truncate">{report.error_message}</p>
          )}
        </div>
        {report.status === "ready" && (
          <Link
            to={`/datasets/${datasetId}/reports/${report.id}`}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors"
          >
            View →
          </Link>
        )}
      </div>
      {report.status === "ready" && (
        <div className="mt-3 pt-3 border-t border-white/5">
          <DownloadButtons datasetId={datasetId} reportId={report.id} />
        </div>
      )}
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

  const { data: reports = [], refetch } = useQuery({
    queryKey: ["reports", datasetId],
    queryFn: () => listReports(datasetId),
    staleTime: 5000,
  });

  const { data: polled } = usePollingReport(datasetId, generatingId);

  // When a generating report becomes ready, refresh the list and stop polling
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
      qc.invalidateQueries({ queryKey: ["reports", datasetId] });
    },
  });

  const isGenerating = generatingId !== null || generate.isPending;

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold">Study Report Studio</h2>
          <p className="text-sm text-gray-400 mt-1">
            Generate a publication-ready report for this dataset.
          </p>
        </div>
        <button
          onClick={() => generate.mutate()}
          disabled={isGenerating}
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isGenerating ? "Generating…" : "+ Generate Report"}
        </button>
      </div>

      {isGenerating && generatingId && (
        <div className="mb-4 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-300">
          <span className="font-medium">Generating report #{generatingId}…</span>
          {" "}Aggregating runs, artifacts, methods, and figures. This takes a few seconds.
        </div>
      )}

      {reports.length === 0 && !isGenerating ? (
        <div className="rounded-lg border border-dashed border-white/10 p-10 text-center">
          <p className="text-3xl mb-3">📊</p>
          <p className="text-sm font-medium text-gray-300">No reports yet</p>
          <p className="text-xs text-gray-500 mt-1">
            Click "Generate Report" to create a publication-ready study report.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map((r) => (
            <ReportCard
              key={r.id}
              report={r}
              datasetId={datasetId}
              active={r.id === generatingId}
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
