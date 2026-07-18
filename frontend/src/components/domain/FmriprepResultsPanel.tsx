import { useMemo, useState } from "react";
import type { RunResults } from "../../api/client";
import {
  classifyFmriprepDerivative,
  fmriprepDisplayName,
  fmriprepLayer,
  preferredBaseFor,
  type FmriprepDerivative,
} from "../../lib/fmriprepArtifacts";
import NiivueViewer, { type NiivueLayer } from "./NiivueViewer";
import OpenWithViewer from "./OpenWithViewer";
import { classifyNeuroArtifact } from "../../lib/neuroArtifactView";

const SECTIONS: FmriprepDerivative["section"][] = [
  "QC Report",
  "Anatomical",
  "Tissue Segmentation",
  "Spatial Normalization",
  "Functional References",
  "Preprocessed BOLD",
  "Confounds",
  "Transforms",
  "Other Files",
];

type WorkspaceTab = "report" | "viewer" | "outputs";

function bytes(value?: number) {
  if (value == null) return "size unavailable";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function entitySummary(file: FmriprepDerivative) {
  return [
    file.subject && `sub-${file.subject}`,
    file.session && `ses-${file.session}`,
    file.task && `task-${file.task}`,
    file.run && `run-${file.run}`,
    file.space ? `space-${file.space}` : "native space",
    file.descriptor && `desc-${file.descriptor}`,
    file.label && `label-${file.label}`,
  ].filter(Boolean).join(" · ");
}

export default function FmriprepResultsPanel({ runId, results }: { runId: number; results: RunResults }) {
  const [tab, setTab] = useState<WorkspaceTab>("report");
  const [query, setQuery] = useState("");
  const [space, setSpace] = useState("all");
  const [role, setRole] = useState("all");
  const [viewerLayers, setViewerLayers] = useState<NiivueLayer[] | null>(null);

  const files = useMemo(() => {
    const inventory = results.files?.length
      ? results.files
      : [...results.reports, ...(results.niftis ?? []), ...results.metrics];
    return inventory.map(classifyFmriprepDerivative);
  }, [results.files, results.metrics, results.niftis, results.reports]);
  const participantReports = new Set(results.reports.map((file) => file.path));
  const report = files.find((file) => file.role === "report" && participantReports.has(file.path));
  const viewable = files.filter((file) => file.visualizationMode !== "none" && file.visualizationMode !== "report" && file.visualizationMode !== "tabular");
  const spaces = [...new Set(viewable.map((file) => file.space ?? "native"))].sort();
  const roles = [...new Set(viewable.map((file) => file.role))].sort();
  const filtered = files.filter((file) => {
    const needle = query.trim().toLowerCase();
    return (!needle || `${file.path} ${fmriprepDisplayName(file)}`.toLowerCase().includes(needle))
      && (space === "all" || (file.space ?? "native") === space)
      && (role === "all" || file.role === role);
  });
  const viewerArtifacts = useMemo(
    () => files.map((file) => classifyNeuroArtifact(file, "fmriprep")),
    [files],
  );

  function openViewer(file: FmriprepDerivative) {
    const base = file.preferredBase ? preferredBaseFor(file, files) : null;
    const ordered = base ? [base, file] : [file];
    setViewerLayers(ordered.map((item) => fmriprepLayer(item, runId)));
  }

  const reportUrl = report ? `/api/runs/${runId}/files/${report.path}` : null;

  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-white/10 bg-slate-950/60" data-testid="fmriprep-results-workspace">
      <div className="border-b border-white/10 bg-gradient-to-r from-violet-500/10 to-cyan-500/5 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-300">fMRIPrep scientific workspace</p>
            <h3 className="mt-1 text-base font-semibold text-white">Quality control and derivative inspection</h3>
            <p className="mt-1 max-w-3xl text-xs text-slate-400">The official fMRIPrep report is the primary QC record. The interactive viewer is an exploratory companion and does not replace official reportlets.</p>
          </div>
          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-medium text-emerald-200">Run #{runId} · original derivatives</span>
        </div>
        <div className="mt-4 flex gap-1" role="tablist" aria-label="fMRIPrep result views">
          {([ ["report", "Official QC Report"], ["viewer", "Interactive Viewer"], ["outputs", "All Outputs"] ] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === id ? "bg-violet-500/20 text-violet-100 ring-1 ring-violet-400/30" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}>{label}</button>
          ))}
        </div>
      </div>

      {tab === "report" && (
        <div className="p-3">
          {reportUrl ? <>
            <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2">
              <div className="min-w-0"><div className="text-xs font-medium text-slate-200">Official fMRIPrep participant report</div><div className="truncate font-mono text-[10px] text-slate-500">{report?.path} · {bytes(report?.size)}</div></div>
              <div className="flex shrink-0 gap-2"><a href={reportUrl} target="_blank" rel="noopener noreferrer" className="rounded border border-white/10 px-2 py-1 text-xs text-slate-300 hover:text-white">Open report</a><a href={reportUrl} download className="rounded bg-violet-500/20 px-2 py-1 text-xs text-violet-200">Download HTML</a></div>
            </div>
            <iframe src={reportUrl} title="Official fMRIPrep participant report" sandbox="allow-scripts allow-same-origin allow-popups" className="w-full rounded-lg border border-white/10 bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400" style={{ height: "76vh" }} />
          </> : <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">No participant report was found in this run output.</div>}
        </div>
      )}

      {tab === "viewer" && (
        <div className="p-4">
          <div className="mb-3 rounded-lg border border-cyan-400/15 bg-cyan-400/[0.05] px-3 py-2 text-xs text-cyan-100">Select a derivative to inspect it in the shared NeuroForge viewer. Compatible masks, segmentations, and probability maps are automatically paired only with an entity- and space-matched base image; no implicit resampling is performed.</div>
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <input aria-label="Search fMRIPrep outputs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search filename or BIDS entity…" className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white placeholder:text-slate-600" />
            <select aria-label="Filter by space" value={space} onChange={(event) => setSpace(event.target.value)} className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white"><option value="all">All spaces</option>{spaces.map((value) => <option key={value} value={value}>{value === "native" ? "Native space" : value}</option>)}</select>
            <select aria-label="Filter by derivative type" value={role} onChange={(event) => setRole(event.target.value)} className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white"><option value="all">All derivative types</option>{roles.map((value) => <option key={value} value={value}>{value.replace(/-/g, " ")}</option>)}</select>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {SECTIONS.filter((section) => filtered.some((file) => file.section === section && viewable.includes(file))).map((section) => (
              <div key={section} className="rounded-lg border border-white/8 bg-white/[0.025] p-3">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">{section}</h4>
                <div className="space-y-2">{filtered.filter((file) => file.section === section && viewable.includes(file)).map((file) => (
                  <button key={file.path} type="button" onClick={() => openViewer(file)} className="block w-full rounded-md border border-white/8 bg-slate-950/60 px-3 py-2 text-left transition-colors hover:border-violet-400/30 hover:bg-violet-500/[0.06]">
                    <span className="block text-xs font-medium text-slate-100">{fmriprepDisplayName(file)}</span>
                    <span className="mt-0.5 block text-[10px] text-slate-500">{entitySummary(file) || file.role.replace(/-/g, " ")} · {bytes(file.size)}</span>
                    <span className="mt-1 block truncate font-mono text-[9px] text-slate-600" title={file.path}>{file.path}</span>
                  </button>
                ))}</div>
              </div>
            ))}
          </div>
          {!filtered.some((file) => viewable.includes(file)) && <p className="py-8 text-center text-sm text-slate-500">No viewable derivatives match these filters.</p>}
        </div>
      )}

      {tab === "outputs" && (
        <div className="p-4">
          <div className="space-y-4">{SECTIONS.map((section) => {
            const sectionFiles = filtered.filter((file) => file.section === section);
            if (!sectionFiles.length) return null;
            return <details key={section} open={section !== "Other Files"} className="rounded-lg border border-white/8 bg-white/[0.025]"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-300">{section} <span className="font-normal text-slate-600">({sectionFiles.length})</span></summary><div className="border-t border-white/8">{sectionFiles.map((file) => {
              const artifact = viewerArtifacts.find((candidate) => candidate.path === file.path);
              return <div key={file.path} className="flex items-center justify-between gap-3 border-b border-white/5 px-3 py-2 last:border-0"><div className="min-w-0"><div className="text-xs text-slate-200">{fmriprepDisplayName(file)}</div><div className="truncate font-mono text-[10px] text-slate-600">{file.path} · {bytes(file.size)}</div></div><div className="flex shrink-0 items-start gap-1">{viewable.includes(file) && artifact && <OpenWithViewer runId={runId} artifact={artifact} candidates={viewerArtifacts} onOpenNeuroForge={() => openViewer(file)} />}<a href={`/api/runs/${runId}/files/${file.path}`} target="_blank" rel="noopener noreferrer" className="rounded border border-white/10 px-2 py-1 text-[10px] text-slate-300">Open</a></div></div>;
            })}</div></details>;
          })}</div>
        </div>
      )}

      {viewerLayers && <NiivueViewer layers={viewerLayers} onClose={() => setViewerLayers(null)} />}
    </section>
  );
}
