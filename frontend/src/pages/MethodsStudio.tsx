/**
 * Methods & Citation Studio
 *
 * Generates publication-ready Methods sections, citation lists, software tables,
 * parameter appendices, and provenance exports from recorded run metadata.
 *
 * Routes:
 *   /datasets/:id/methods            — entire dataset history
 *   /datasets/:id/methods?run=42     — single run
 *   /runs/:runId/methods             — single run (via run-detail link)
 *
 * All content is derived exclusively from recorded provenance.
 * Missing values are reported as "Not recorded." — never fabricated.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { RunMetadata, Dataset } from "../api/client";
import { fetchRunResults } from "../api/client";
import { useDataset } from "../hooks/useDatasets";
import { useRuns } from "../hooks/useRuns";
import {
  buildSoftwareTable,
  buildParamAppendix,
  generateMethodsSection,
  findReproducibilityConcerns,
  buildProvenanceExport,
  provenanceToYAML,
  exportMarkdown,
  buildWorkflowSVG,
} from "../lib/methodsEngine";
import {
  getCitationsForPipelines,
  formatBibTeX,
  formatAPA,
  formatVancouver,
  formatRIS,
  formatCSLJSON,
  type Citation,
} from "../lib/citationRegistry";

// ── Utilities ─────────────────────────────────────────────────────────────────

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  });
}

function downloadText(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadSVG(svgContent: string, filename: string) {
  downloadText(filename, svgContent, "image/svg+xml");
}

function normalizeFunctionalConnectivityAtlasId(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (value === "schaefer_100_7") return "schaefer100_7";
  return value;
}

function atlasIdsFromRuns(runs: RunMetadata[]): string[] {
  const ids = runs
    .filter((run) => run.pipeline_id === "functional-connectivity")
    .map((run) =>
      normalizeFunctionalConnectivityAtlasId(
        run.params?.["atlas-name"] ?? run.params?.atlas ?? "schaefer100_7",
      ),
    )
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

async function downloadPNG(svgContent: string, filename: string) {
  const blob = new Blob([svgContent], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.width * 2;
    canvas.height = img.height * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(2, 2);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob((b) => {
      if (!b) return;
      const pngUrl = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = pngUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(pngUrl);
    }, "image/png");
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

// ── Shared UI ─────────────────────────────────────────────────────────────────

function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        copyToClipboard(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={`rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors ${className}`}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}

function SectionCard({
  title,
  children,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-surface-raised">
      <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Concern({
  level,
  message,
}: {
  level: "warning" | "info";
  message: string;
}) {
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${
        level === "warning"
          ? "border-amber-800/40 bg-amber-900/15 text-amber-200"
          : "border-blue-800/40 bg-blue-900/15 text-blue-200"
      }`}
    >
      <span className="mt-px shrink-0">{level === "warning" ? "⚠" : "ℹ"}</span>
      <span>{message}</span>
    </div>
  );
}

// ── Tab: Methods ──────────────────────────────────────────────────────────────

function MethodsTab({
  runs,
  dataset,
}: {
  runs: RunMetadata[];
  dataset: Dataset | null;
}) {
  const methodsText = useMemo(
    () => generateMethodsSection(runs, dataset),
    [runs, dataset],
  );
  const concerns = useMemo(() => findReproducibilityConcerns(runs), [runs]);

  return (
    <div className="space-y-4">
      <SectionCard
        title="Methods Section"
        actions={
          <>
            <CopyButton text={methodsText} label="Copy text" />
            <button
              onClick={() =>
                downloadText(
                  "methods.md",
                  `# Methods\n\n${methodsText}`,
                  "text/markdown",
                )
              }
              className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              Download .md
            </button>
          </>
        }
      >
        <div className="space-y-3">
          {methodsText.split("\n\n").map((para, i) => (
            <p key={i} className="text-sm leading-relaxed text-gray-200">
              {para}
            </p>
          ))}
        </div>
      </SectionCard>

      {concerns.length > 0 && (
        <SectionCard title="Reproducibility Notes">
          <div className="space-y-2">
            {concerns.map((c, i) => (
              <Concern key={i} level={c.level} message={c.message} />
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ── Tab: Citations ─────────────────────────────────────────────────────────────

type CitationFormat = "apa" | "vancouver" | "bibtex";

function CitationsTab({ runs }: { runs: RunMetadata[] }) {
  const [fmt, setFmt] = useState<CitationFormat>("apa");
  const pipelineIds = useMemo(
    () => [...new Set(runs.map((r) => r.pipeline_id))],
    [runs],
  );
  const citations = useMemo(
    () => getCitationsForPipelines(pipelineIds, atlasIdsFromRuns(runs)),
    [pipelineIds, runs],
  );

  const allBibTeX = useMemo(
    () => citations.map(formatBibTeX).join("\n\n"),
    [citations],
  );
  const allRIS = useMemo(() => formatRIS(citations), [citations]);
  const allCSL = useMemo(
    () => JSON.stringify(formatCSLJSON(citations), null, 2),
    [citations],
  );

  const formatCitation = (c: Citation, i: number) => {
    if (fmt === "bibtex") return formatBibTeX(c);
    if (fmt === "vancouver") return formatVancouver(c, i + 1);
    return formatAPA(c);
  };

  return (
    <div className="space-y-4">
      {/* Format selector + bulk actions */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">Format:</span>
        {(["apa", "vancouver", "bibtex"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFmt(f)}
            className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              fmt === f
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-white/10 bg-white/5 text-gray-400 hover:text-white"
            }`}
          >
            {f.toUpperCase()}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap gap-2">
          <CopyButton text={allBibTeX} label="Copy BibTeX" />
          <button
            onClick={() => downloadText("references.bib", allBibTeX)}
            className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            Export .bib
          </button>
          <button
            onClick={() => downloadText("references.ris", allRIS)}
            className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            Export RIS
          </button>
          <button
            onClick={() => downloadText("references.json", allCSL, "application/json")}
            className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            Export CSL-JSON
          </button>
        </div>
      </div>

      {citations.length === 0 ? (
        <div className="rounded-xl border border-white/8 bg-surface-raised px-5 py-8 text-center text-sm text-gray-500">
          No citations found for the pipelines in this selection.
        </div>
      ) : (
        <div className="space-y-3">
          {citations.map((c, i) => (
            <div
              key={c.key}
              className="rounded-xl border border-white/8 bg-surface-raised"
            >
              <div className="flex items-start justify-between gap-3 border-b border-white/5 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                    {c.tool}
                  </span>
                  {c.rrid && (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-gray-400">
                      RRID:{c.rrid}
                    </span>
                  )}
                  <a
                    href={`https://doi.org/${c.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-gray-500 hover:text-accent transition-colors"
                  >
                    doi:{c.doi}
                  </a>
                </div>
                <CopyButton text={formatCitation(c, i)} label="Copy" />
              </div>
              <div className="px-4 py-3">
                {fmt === "bibtex" ? (
                  <pre className="whitespace-pre-wrap font-mono text-xs text-gray-300 leading-relaxed overflow-x-auto">
                    {formatBibTeX(c)}
                  </pre>
                ) : (
                  <p className="text-xs leading-relaxed text-gray-300">
                    {formatCitation(c, i)}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tab: Software Table ───────────────────────────────────────────────────────

function SoftwareTableTab({ runs }: { runs: RunMetadata[] }) {
  const table = useMemo(() => buildSoftwareTable(runs), [runs]);
  const csvContent = useMemo(() => {
    const header = "Software,Version,Container,Execution,Citation Key";
    const rows = table.map(
      (r) =>
        `"${r.displayName}","${r.version}","${r.containerImage ?? "—"}","${r.executionType}","${r.citationKey}"`,
    );
    return [header, ...rows].join("\n");
  }, [table]);

  return (
    <SectionCard
      title="Software & Environment Table"
      actions={
        <>
          <CopyButton text={csvContent} label="Copy CSV" />
          <button
            onClick={() => downloadText("software-table.csv", csvContent, "text/csv")}
            className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            Export CSV
          </button>
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/8 text-left text-gray-500">
              <th className="pb-2 pr-4 font-medium">Software</th>
              <th className="pb-2 pr-4 font-medium">Version</th>
              <th className="pb-2 pr-4 font-medium">Container Image</th>
              <th className="pb-2 pr-4 font-medium">Execution</th>
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {table.map((row) => (
              <tr key={`${row.pipelineId}@${row.version}`} className="text-gray-300">
                <td className="py-2.5 pr-4 font-medium text-white">{row.displayName}</td>
                <td className="py-2.5 pr-4 font-mono">{row.version}</td>
                <td className="py-2.5 pr-4 font-mono text-gray-400 max-w-[240px] truncate">
                  {row.containerImage ?? <span className="italic text-gray-600">native / none</span>}
                </td>
                <td className="py-2.5 pr-4 capitalize">{row.executionType}</td>
                <td className="py-2.5">
                  {row.versionComplete ? (
                    <span className="rounded-full border border-green-700/50 bg-green-900/20 px-2 py-0.5 text-[10px] text-green-300">
                      Complete
                    </span>
                  ) : (
                    <span className="rounded-full border border-amber-700/50 bg-amber-900/20 px-2 py-0.5 text-[10px] text-amber-300">
                      Missing version
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {table.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-gray-600 italic">
                  No runs to display
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ── Tab: Parameters ───────────────────────────────────────────────────────────

function ParametersTab({ runs }: { runs: RunMetadata[] }) {
  const groups = useMemo(() => buildParamAppendix(runs), [runs]);
  const appendixText = useMemo(() => {
    if (groups.length === 0) return "No explicit parameters recorded.";
    return groups
      .map((g) => {
        const paramLines = Object.entries(g.params)
          .map(([k, v]) => `  --${k} ${v}`)
          .join("\n");
        return `${g.displayName} (Run${g.runIds.length > 1 ? "s" : ""} #${g.runIds.join(", #")}):\n${paramLines}`;
      })
      .join("\n\n");
  }, [groups]);

  return (
    <SectionCard
      title="Parameters Appendix"
      actions={<CopyButton text={appendixText} label="Copy" />}
    >
      {groups.length === 0 ? (
        <p className="text-sm text-gray-500 italic">
          No explicit parameters were recorded for these runs. Default pipeline
          parameters were used throughout.
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.pipelineId}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-semibold text-white">{g.displayName}</span>
                <span className="text-xs text-gray-500">
                  Run{g.runIds.length > 1 ? "s" : ""} #{g.runIds.join(", #")}
                </span>
              </div>
              <div className="rounded-lg border border-white/8 bg-surface px-4 py-3 font-mono text-xs text-gray-300 space-y-1">
                {Object.entries(g.params).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-accent">--{k}</span>{" "}
                    <span>{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ── Tab: Workflow Figure ──────────────────────────────────────────────────────

function WorkflowFigureTab({
  runs,
  datasetName,
}: {
  runs: RunMetadata[];
  datasetName: string;
}) {
  const svgContent = useMemo(
    () => buildWorkflowSVG(runs, datasetName),
    [runs, datasetName],
  );
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current && svgContent) {
      containerRef.current.innerHTML = svgContent;
    }
  }, [svgContent]);

  if (!svgContent) {
    return (
      <div className="rounded-xl border border-white/8 bg-surface-raised px-5 py-8 text-center text-sm text-gray-500">
        No runs available to generate a workflow figure.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => downloadSVG(svgContent, `${datasetName}-workflow.svg`)}
          className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
        >
          Download SVG
        </button>
        <button
          onClick={() => downloadPNG(svgContent, `${datasetName}-workflow.png`)}
          className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
        >
          Download PNG (2×)
        </button>
        <button
          onClick={() => downloadSVG(svgContent, `${datasetName}-workflow-print.svg`)}
          className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
        >
          Download PDF-ready SVG
        </button>
      </div>
      <div
        className="overflow-auto rounded-xl border border-white/8 bg-white p-4"
        style={{ minHeight: 200 }}
        ref={containerRef}
      />
    </div>
  );
}

// ── Tab: Provenance ───────────────────────────────────────────────────────────

function ProvenanceTab({
  runs,
  dataset,
}: {
  runs: RunMetadata[];
  dataset: Dataset | null;
}) {
  const [view, setView] = useState<"json" | "yaml">("json");

  const prov = useMemo(() => buildProvenanceExport(runs, dataset), [runs, dataset]);
  const jsonText = useMemo(() => JSON.stringify(prov, null, 2), [prov]);
  const yamlText = useMemo(() => provenanceToYAML(prov), [prov]);

  const displayText = view === "json" ? jsonText : yamlText;
  const filename = view === "json" ? "provenance.json" : "provenance.yaml";
  const mime = view === "json" ? "application/json" : "text/yaml";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Format:</span>
        {(["json", "yaml"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setView(f)}
            className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              view === f
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-white/10 bg-white/5 text-gray-400 hover:text-white"
            }`}
          >
            {f.toUpperCase()}
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          <CopyButton text={displayText} label="Copy" />
          <button
            onClick={() => downloadText(filename, displayText, mime)}
            className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            Download {filename}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-white/8 bg-surface">
        <pre className="overflow-x-auto p-4 text-xs text-gray-300 leading-relaxed max-h-[60vh] overflow-y-auto">
          {displayText}
        </pre>
      </div>
    </div>
  );
}

// ── Tab: Export ───────────────────────────────────────────────────────────────

function ExportTab({
  runs,
  dataset,
}: {
  runs: RunMetadata[];
  dataset: Dataset | null;
}) {
  const datasetName = dataset?.name ?? "dataset";
  const pipelineIds = useMemo(
    () => [...new Set(runs.map((r) => r.pipeline_id))],
    [runs],
  );
  const citations = useMemo(
    () => getCitationsForPipelines(pipelineIds, atlasIdsFromRuns(runs)),
    [pipelineIds, runs],
  );
  const softwareTable = useMemo(() => buildSoftwareTable(runs), [runs]);
  const paramGroups = useMemo(() => buildParamAppendix(runs), [runs]);
  const concerns = useMemo(() => findReproducibilityConcerns(runs), [runs]);
  const methodsSection = useMemo(
    () => generateMethodsSection(runs, dataset),
    [runs, dataset],
  );

  const markdown = useMemo(
    () =>
      exportMarkdown({
        methodsSection,
        citations,
        softwareTable,
        paramGroups,
        concerns,
        datasetName,
      }),
    [methodsSection, citations, softwareTable, paramGroups, concerns, datasetName],
  );

  const plainText = useMemo(() => {
    const allBib = citations.map(formatBibTeX).join("\n\n");
    const paramText =
      paramGroups.length > 0
        ? "\n\nPARAMETERS APPENDIX\n" +
          paramGroups
            .map(
              (g) =>
                `\n${g.displayName}:\n` +
                Object.entries(g.params)
                  .map(([k, v]) => `  --${k} ${v}`)
                  .join("\n"),
            )
            .join("\n")
        : "";
    return `METHODS\n\n${methodsSection}\n\nREFERENCES\n\n${allBib}${paramText}`;
  }, [methodsSection, citations, paramGroups]);

  const actions = [
    {
      label: "Copy Markdown",
      action: () => copyToClipboard(markdown),
    },
    {
      label: "Copy Plain Text",
      action: () => copyToClipboard(plainText),
    },
    {
      label: "Download Markdown",
      action: () => downloadText(`${datasetName}-methods.md`, markdown, "text/markdown"),
    },
    {
      label: "Download HTML",
      action: () => {
        const body = markdown
          .split("\n")
          .map((line) => {
            if (line.startsWith("## ")) return `<h2>${line.slice(3)}</h2>`;
            if (line.startsWith("# ")) return `<h1>${line.slice(2)}</h1>`;
            if (line.startsWith("| ")) return line; // leave table as-is for now
            if (line === "") return "<br>";
            return `<p>${line}</p>`;
          })
          .join("\n");
        const html = `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><title>Methods — ${datasetName}</title>\n<style>body{font-family:Georgia,serif;max-width:820px;margin:40px auto;padding:0 20px;line-height:1.7}h1,h2{font-family:system-ui,sans-serif}pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto;font-size:12px}</style></head>\n<body>${body}</body>\n</html>`;
        downloadText(`${datasetName}-methods.html`, html, "text/html");
      },
    },
    {
      label: "Download BibTeX",
      action: () =>
        downloadText(
          `${datasetName}-references.bib`,
          citations.map(formatBibTeX).join("\n\n"),
        ),
    },
    {
      label: "Download RIS",
      action: () =>
        downloadText(`${datasetName}-references.ris`, formatRIS(citations)),
    },
    {
      label: "Download CSL-JSON",
      action: () =>
        downloadText(
          `${datasetName}-references.json`,
          JSON.stringify(formatCSLJSON(citations), null, 2),
          "application/json",
        ),
    },
    {
      label: "Download Provenance JSON",
      action: () =>
        downloadText(
          `${datasetName}-provenance.json`,
          JSON.stringify(buildProvenanceExport(runs, dataset), null, 2),
          "application/json",
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <SectionCard title="Export Package">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {actions.map(({ label, action }) => (
            <button
              key={label}
              onClick={action}
              className="rounded-md border border-white/10 bg-white/5 px-3 py-2.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors text-left"
            >
              {label}
            </button>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Preview: Markdown">
        <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-gray-300 leading-relaxed max-h-[50vh] overflow-y-auto">
          {markdown}
        </pre>
      </SectionCard>
    </div>
  );
}

// ── Run metadata loader ────────────────────────────────────────────────────────

async function loadRunMetadata(runIds: number[]): Promise<RunMetadata[]> {
  const results = await Promise.all(
    runIds.map((id) =>
      fetchRunResults(id)
        .then((r) => r.metadata ?? null)
        .catch(() => null),
    ),
  );
  return results.filter(Boolean) as RunMetadata[];
}

// ── Tab nav ───────────────────────────────────────────────────────────────────

type TabId = "methods" | "citations" | "software" | "parameters" | "figure" | "provenance" | "export";

const TABS: { id: TabId; label: string }[] = [
  { id: "methods", label: "Methods" },
  { id: "citations", label: "Citations" },
  { id: "software", label: "Software Table" },
  { id: "parameters", label: "Parameters" },
  { id: "figure", label: "Workflow Figure" },
  { id: "provenance", label: "Provenance" },
  { id: "export", label: "Export" },
];

// ── Page root ─────────────────────────────────────────────────────────────────

export default function MethodsStudio() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const datasetId = Number(id);
  const singleRunId = searchParams.get("run");

  const { data: dataset, isLoading: dsLoading } = useDataset(datasetId);
  const { data: allRuns = [], isLoading: runsLoading } = useRuns();

  const [activeTab, setActiveTab] = useState<TabId>("methods");
  const [runMetadata, setRunMetadata] = useState<RunMetadata[]>([]);
  const [metaLoading, setMetaLoading] = useState(true);

  // Filter runs to this dataset (optionally to a single run)
  const datasetRuns = useMemo(() => {
    const filtered = allRuns.filter((r) => r.dataset_id === datasetId);
    if (singleRunId) return filtered.filter((r) => r.id === Number(singleRunId));
    return filtered;
  }, [allRuns, datasetId, singleRunId]);

  // Load RunMetadata for each run (needed for params, container_image, etc.)
  useEffect(() => {
    if (runsLoading || datasetRuns.length === 0) {
      if (!runsLoading) setMetaLoading(false);
      return;
    }
    setMetaLoading(true);
    loadRunMetadata(datasetRuns.map((r) => r.id)).then((metas) => {
      setRunMetadata(metas);
      setMetaLoading(false);
    });
  }, [datasetRuns, runsLoading]);

  const datasetName = dataset?.name ?? `Dataset #${datasetId}`;

  if (dsLoading || runsLoading || metaLoading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-gray-400 animate-pulse">Loading provenance data…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen text-gray-100">
      {/* Header */}
      <header className="shrink-0 border-b border-white/5 bg-surface-raised px-6 py-4">
        <nav className="mb-2 flex items-center gap-2 text-xs text-gray-500">
          <Link to="/datasets" className="hover:text-gray-300 transition-colors">
            Datasets
          </Link>
          <span>/</span>
          <Link to={`/datasets/${datasetId}`} className="hover:text-gray-300 transition-colors">
            {datasetName}
          </Link>
          <span>/</span>
          <span className="text-white">Methods Studio</span>
        </nav>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-white">Methods Studio</h1>
            <p className="mt-0.5 text-xs text-gray-500">
              {singleRunId
                ? `Single run #${singleRunId}`
                : `${datasetRuns.length} run${datasetRuns.length !== 1 ? "s" : ""} · ${datasetName}`}
              {" · "}
              {runMetadata.length > 0
                ? `${[...new Set(runMetadata.map((r) => r.pipeline_id))].length} pipelines`
                : "no metadata"}
            </p>
          </div>

          {/* Nav pills matching other dataset pages */}
          <nav className="flex flex-wrap gap-2">
            <Link
              to={`/datasets/${datasetId}/dashboard`}
              className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              Dashboard
            </Link>
            <Link
              to={`/datasets/${datasetId}/artifacts`}
              className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              Artifacts
            </Link>
            <Link
              to={`/datasets/${datasetId}/graph`}
              className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
            >
              Graph
            </Link>
          </nav>
        </div>

        {/* Tab nav */}
        <div className="mt-4 flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? "bg-accent/15 text-accent border border-accent/30"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 overflow-y-auto p-6">
        {runMetadata.length === 0 ? (
          <div className="rounded-xl border border-white/8 bg-surface-raised px-5 py-12 text-center">
            <p className="text-sm text-gray-400">
              No run metadata found for this selection.
            </p>
            <p className="mt-1 text-xs text-gray-600">
              Run a pipeline first to generate provenance data.
            </p>
            <Link
              to="/pipelines"
              className="mt-4 inline-block rounded-md bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-hover transition-colors"
            >
              Run first pipeline
            </Link>
          </div>
        ) : (
          <>
            {activeTab === "methods" && (
              <MethodsTab runs={runMetadata} dataset={dataset ?? null} />
            )}
            {activeTab === "citations" && <CitationsTab runs={runMetadata} />}
            {activeTab === "software" && <SoftwareTableTab runs={runMetadata} />}
            {activeTab === "parameters" && <ParametersTab runs={runMetadata} />}
            {activeTab === "figure" && (
              <WorkflowFigureTab runs={runMetadata} datasetName={datasetName} />
            )}
            {activeTab === "provenance" && (
              <ProvenanceTab runs={runMetadata} dataset={dataset ?? null} />
            )}
            {activeTab === "export" && (
              <ExportTab runs={runMetadata} dataset={dataset ?? null} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
