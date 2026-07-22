import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { Download, FileCode, FileText, Printer, Archive } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getReport, reportDownloadUrl, reportViewUrl, type ReportSummary } from "../api/client";

type Tab = "overview" | "html" | "markdown" | "json" | "supplement";

function DownloadButton({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <a
      href={href}
      download
      className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-300 hover:border-white/25 hover:text-white transition-colors"
    >
      {icon ?? <Download className="h-3.5 w-3.5" />} {label}
    </a>
  );
}

function PrintButton() {
  return (
    <button
      onClick={() => {
        const iframe = document.querySelector<HTMLIFrameElement>("#report-iframe");
        if (iframe?.contentWindow) {
          iframe.contentWindow.print();
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-300 hover:border-white/25 hover:text-white transition-colors"
    >
      <Printer className="h-3.5 w-3.5" aria-hidden="true" /> Print / Save PDF
    </button>
  );
}

function OverviewTab({ report, datasetId }: { report: ReportSummary; datasetId: number }) {
  const date = new Date(report.created_at).toLocaleString();
  const finishedDate = report.finished_at ? new Date(report.finished_at).toLocaleString() : null;
  return (
    <div className="space-y-6 py-4">
      <div className="rounded-lg border border-white/8 bg-surface-raised divide-y divide-white/5">
        {[
          ["Report ID", `#${report.id}`],
          ["Dataset ID", `#${report.dataset_id}`],
          ["Status", report.status],
          ["Started", date],
          ["Completed", finishedDate ?? "—"],
        ].map(([label, value]) => (
          <div key={label} className="flex items-center justify-between px-4 py-2.5">
            <span className="text-xs text-gray-500">{label}</span>
            <span className="text-xs text-gray-300 font-mono">{value}</span>
          </div>
        ))}
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">Downloads</h3>
        <div className="flex flex-wrap gap-2">
          <DownloadButton href={reportDownloadUrl(datasetId, report.id, "html")} label="HTML" icon={<FileCode className="h-3.5 w-3.5" />} />
          {report.pdf_path && (
            <DownloadButton href={reportDownloadUrl(datasetId, report.id, "pdf")} label="PDF" icon={<Printer className="h-3.5 w-3.5" />} />
          )}
          <DownloadButton href={reportDownloadUrl(datasetId, report.id, "md")} label="Markdown" icon={<FileText className="h-3.5 w-3.5" />} />
          <DownloadButton href={reportDownloadUrl(datasetId, report.id, "json")} label="JSON" icon={<FileCode className="h-3.5 w-3.5" />} />
          <DownloadButton href={reportDownloadUrl(datasetId, report.id, "zip")} label="Supplement ZIP" icon={<Archive className="h-3.5 w-3.5" />} />
          <PrintButton />
        </div>
        {!report.pdf_path && (
          <p className="text-xs text-gray-600 mt-2">PDF unavailable — use Print / Save PDF from the Preview tab.</p>
        )}
      </div>

      <div className="rounded-lg border border-white/5 bg-surface-raised p-4">
        <p className="text-xs text-gray-500">
          This report was generated automatically by Neuravian. No AI-generated scientific
          interpretation is included. All values are derived exclusively from recorded
          pipeline outputs.
        </p>
      </div>
    </div>
  );
}

function HtmlTab({ datasetId, reportId }: { datasetId: number; reportId: number }) {
  const src = reportViewUrl(datasetId, reportId);
  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 200px)" }}>
      <div className="flex items-center justify-between py-2 mb-2">
        <p className="text-xs text-gray-500">Live HTML preview. Use Print / Save PDF to export.</p>
        <PrintButton />
      </div>
      <iframe
        id="report-iframe"
        src={src}
        className="flex-1 w-full rounded-lg border border-white/8 bg-[#090d18] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
        title="Study Report"
      />
    </div>
  );
}

function RawTextTab({
  datasetId,
  reportId,
  fmt,
  label,
}: {
  datasetId: number;
  reportId: number;
  fmt: "md" | "json";
  label: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const url = reportDownloadUrl(datasetId, reportId, fmt);

  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then(setText)
      .catch(() => setText("Failed to load content."));
  }, [url]);

  return (
    <div className="py-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500">{label}</p>
        <DownloadButton href={url} label={`Download ${fmt.toUpperCase()}`} />
      </div>
      {text === null ? (
        <p className="text-sm text-gray-500 animate-pulse">Loading…</p>
      ) : (
        <pre className="overflow-auto rounded-lg border border-white/8 bg-black/30 p-4 text-xs text-gray-300 leading-relaxed" style={{ maxHeight: "calc(100vh - 260px)" }}>
          {text}
        </pre>
      )}
    </div>
  );
}

function SupplementTab({ datasetId, reportId }: { datasetId: number; reportId: number }) {
  return (
    <div className="py-4 space-y-4">
      <p className="text-sm text-gray-400">
        The supplementary materials ZIP contains everything needed to reproduce and report this study.
      </p>
      <div className="rounded-lg border border-white/8 bg-surface-raised divide-y divide-white/5">
        {[
          ["study_report.html", "Self-contained HTML report with embedded figures"],
          ["study_report.md", "Markdown summary for README or preprint"],
          ["study_report.json", "Structured JSON data for programmatic access"],
          ["pipeline_parameters.tsv", "All run parameters in tabular format"],
          ["references.bib", "BibTeX citations for all software used"],
          ["provenance.json", "Full provenance record (run IDs, versions, timestamps)"],
        ].map(([name, desc]) => (
          <div key={name} className="flex items-start gap-3 px-4 py-2.5">
            <code className="text-xs text-accent shrink-0 mt-0.5">{name}</code>
            <span className="text-xs text-gray-500">{desc}</span>
          </div>
        ))}
      </div>
      <DownloadButton href={reportDownloadUrl(datasetId, reportId, "zip")} label="Download Supplement ZIP" icon="🗜" />
    </div>
  );
}

export default function ReportViewer() {
  const { id, reportId } = useParams<{ id: string; reportId: string }>();
  const datasetId = Number(id);
  const rId = Number(reportId);
  const [tab, setTab] = useState<Tab>("html");

  const { data: report, isLoading, error } = useQuery({
    queryKey: ["report", datasetId, rId],
    queryFn: () => getReport(datasetId, rId),
    staleTime: 30_000,
  });

  const tabs: { id: Tab; label: string }[] = [
    { id: "html", label: "Preview" },
    { id: "overview", label: "Overview" },
    { id: "markdown", label: "Markdown" },
    { id: "json", label: "JSON" },
    { id: "supplement", label: "Supplement" },
  ];

  if (isLoading) {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-400 animate-pulse">Loading report…</p>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="p-8">
        <p className="text-sm text-red-400">Failed to load report.</p>
        <Link to={`/datasets/${datasetId}/reports`} className="text-xs text-accent mt-2 inline-block">
          ← Back to reports
        </Link>
      </div>
    );
  }

  if (report.status !== "ready") {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-400">
          Report is not ready yet (status: <strong>{report.status}</strong>).
        </p>
        <Link to={`/datasets/${datasetId}/reports`} className="text-xs text-accent mt-2 inline-block">
          ← Back to reports
        </Link>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <Link to={`/datasets/${datasetId}/reports`} className="text-xs text-gray-500 hover:text-gray-300">
            ← Reports
          </Link>
          <h1 className="text-2xl font-semibold mt-1">Study Report #{report.id}</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Dataset #{report.dataset_id} · Generated {new Date(report.created_at).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/10 mb-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "text-white border-b-2 border-accent -mb-px"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "overview" && <OverviewTab report={report} datasetId={datasetId} />}
      {tab === "html" && <HtmlTab datasetId={datasetId} reportId={rId} />}
      {tab === "markdown" && (
        <RawTextTab datasetId={datasetId} reportId={rId} fmt="md" label="Markdown source" />
      )}
      {tab === "json" && (
        <RawTextTab datasetId={datasetId} reportId={rId} fmt="json" label="Structured JSON data" />
      )}
      {tab === "supplement" && <SupplementTab datasetId={datasetId} reportId={rId} />}
    </div>
  );
}
