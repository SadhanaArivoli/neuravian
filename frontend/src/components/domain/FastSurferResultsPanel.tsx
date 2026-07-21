import { useMemo, useState } from "react";
import type { RunResults } from "../../api/client";
import {
  classifyNeuroArtifact,
  type ArtifactSection,
  type ArtifactViewModel,
} from "../../lib/neuroArtifactView";
import NiivueViewer, { type NiivueLayer } from "./NiivueViewer";
import NeuroSurfaceViewer, { type SurfaceLayer } from "./NeuroSurfaceViewer";
import FreeSurferStatsViewer from "./FreeSurferStatsViewer";
import OpenWithViewer from "./OpenWithViewer";

const SECTIONS: ArtifactSection[] = [
  "Conformed Anatomy",
  "Brain and Tissue Segmentations",
  "Cortical Parcellations",
  "Cerebellar Segmentation",
  "Hypothalamic Segmentation",
  "Surfaces",
  "Labels and Annotations",
  "Statistics",
  "Transforms",
  "Logs",
  "Raw Inventory",
];

const PRESETS = [
  ["Aseg over anatomy", /(^|[._])aseg(\.|_|$)/i],
  ["Aparc + aseg", /aparc.*aseg/i],
  ["White-matter parcellation", /wmparc/i],
  ["Cortical ribbon", /ribbon/i],
  ["Cerebellar segmentation", /cereb/i],
  ["Hypothalamic segmentation", /hypothalamus(?!_mask)/i],
] as const;

function bytes(value?: number) {
  if (value == null) return "size unavailable";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function displayName(artifact: ArtifactViewModel) {
  if (artifact.role === "structural") return /orig_nu/i.test(artifact.name) ? "Bias-corrected conformed anatomy" : "Conformed anatomy";
  if (/aparc/i.test(artifact.name)) return "Cortical and subcortical parcellation";
  if (/aseg/i.test(artifact.name)) return "Subcortical segmentation";
  if (/cereb/i.test(artifact.name)) return "Cerebellar segmentation";
  if (/hypothalamus_mask/i.test(artifact.name)) return "Hypothalamic processing mask";
  if (/hypothal/i.test(artifact.name)) return "Hypothalamic segmentation";
  if (artifact.role === "segmentation-statistics") return "Segmentation statistics";
  if (artifact.role === "execution-log") return "Execution log";
  return artifact.name;
}

function baseFor(artifact: ArtifactViewModel, candidates: ArtifactViewModel[]) {
  if (!artifact.canOverlay) return null;
  return candidates.find((candidate) => candidate.role === "structural" && /orig_nu\.mgz$/i.test(candidate.name))
    ?? candidates.find((candidate) => candidate.role === "structural" && /(^|\/)orig\.mgz$/i.test(candidate.path))
    ?? candidates.find((candidate) => candidate.role === "structural")
    ?? null;
}

function layerFor(artifact: ArtifactViewModel, runId: number): NiivueLayer {
  const isSegmentation = artifact.role === "discrete-segmentation" || artifact.role === "binary-mask";
  return {
    url: `/api/runs/${runId}/files/${artifact.path}`,
    name: artifact.name,
    pipelineId: "fastsurfer",
    artifactType: artifact.role === "structural" ? "nifti_skull_stripped"
      : artifact.role === "binary-mask" ? "brain_mask"
      : artifact.role === "probability-map" ? "fmriprep_probseg"
      : isSegmentation ? "fmriprep_dseg" : undefined,
    isSegmentation,
    opacity: isSegmentation ? 0.7 : 1,
    metadata: { role: artifact.role, space: artifact.space, format: artifact.format },
  };
}

export default function FastSurferResultsPanel({ runId, results }: { runId: number; results: RunResults }) {
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<ArtifactSection | "all">("all");
  const [viewerLayers, setViewerLayers] = useState<NiivueLayer[] | null>(null);
  const [surfaceLayer, setSurfaceLayer] = useState<SurfaceLayer | null>(null);
  const [statsPath, setStatsPath] = useState<string | null>(null);
  const artifacts = useMemo(() => (results.files ?? results.niftis ?? [])
    .map((file) => classifyNeuroArtifact(file, "fastsurfer")), [results.files, results.niftis]);
  const filtered = artifacts.filter((artifact) => {
    const needle = query.trim().toLowerCase();
    return (!needle || `${artifact.path} ${displayName(artifact)} ${artifact.role}`.toLowerCase().includes(needle))
      && (section === "all" || artifact.section === section);
  });

  function openVolume(artifact: ArtifactViewModel) {
    const base = baseFor(artifact, artifacts);
    setViewerLayers((base ? [base, artifact] : [artifact]).map((item) => layerFor(item, runId)));
  }

  function openBuiltIn(artifact: ArtifactViewModel) {
    if (artifact.kind === "volume") openVolume(artifact);
    else if (artifact.kind === "surface") {
      setSurfaceLayer({ url: `/api/runs/${runId}/files/${artifact.path}`, name: artifact.name, hemisphere: artifact.hemisphere });
    } else if (artifact.kind === "statistics") setStatsPath(artifact.path);
  }

  return (
    <section className="mb-4 overflow-hidden rounded-xl border border-white/10 bg-slate-950/60" data-testid="fastsurfer-results-workspace">
      <header className="border-b border-white/10 bg-gradient-to-r from-violet-500/10 to-cyan-500/5 px-4 py-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-300">FastSurfer scientific workspace</p>
        <h3 className="mt-1 text-base font-semibold text-white">Segmentation, surface, and statistics inspection</h3>
        <p className="mt-1 max-w-3xl text-xs text-slate-400">Outputs are classified by scientific role. Compatible segmentation presets use conformed anatomy without changing or resampling either artifact.</p>
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="FastSurfer viewer presets">
          {PRESETS.map(([label, pattern]) => {
            const target = artifacts.find((artifact) => artifact.kind === "volume" && pattern.test(artifact.name));
            return <button key={label} type="button" disabled={!target} onClick={() => target && openVolume(target)} className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] text-slate-200 transition-colors hover:border-violet-400/30 hover:bg-violet-500/10 disabled:cursor-not-allowed disabled:opacity-35">{label}</button>;
          })}
        </div>
      </header>

      <div className="p-4">
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <input aria-label="Search FastSurfer outputs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search filename, role, or region…" className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white placeholder:text-slate-600" />
          <select aria-label="Filter FastSurfer output group" value={section} onChange={(event) => setSection(event.target.value as ArtifactSection | "all")} className="rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white"><option value="all">All output groups</option>{SECTIONS.filter((candidate) => artifacts.some((artifact) => artifact.section === candidate)).map((candidate) => <option key={candidate}>{candidate}</option>)}</select>
        </div>
        <div className="space-y-3">
          {SECTIONS.map((group) => {
            const groupArtifacts = filtered.filter((artifact) => artifact.section === group);
            if (!groupArtifacts.length) return null;
            return <details key={group} open={group !== "Raw Inventory"} className="rounded-lg border border-white/8 bg-white/[0.025]"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-slate-300">{group} <span className="font-normal text-slate-600">({groupArtifacts.length})</span></summary><div className="grid gap-px border-t border-white/8 bg-white/5 lg:grid-cols-2">{groupArtifacts.map((artifact) => <article key={artifact.path} className="bg-slate-950/95 px-3 py-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h4 className="text-xs font-medium text-slate-100">{displayName(artifact)}</h4><p className="mt-0.5 truncate font-mono text-[9px] text-slate-500" title={artifact.path}>{artifact.path}</p><p className="mt-1 text-[10px] text-slate-500">{artifact.format} · {artifact.role.replace(/-/g, " ")} · {bytes(artifact.size)}{artifact.hemisphere ? ` · ${artifact.hemisphere} hemisphere` : ""}</p></div><div className="flex shrink-0 items-start gap-1">{artifact.canView && <OpenWithViewer runId={runId} artifact={artifact} candidates={artifacts} onOpenNeuroForge={() => openBuiltIn(artifact)} />}<a href={`/api/runs/${runId}/files/${artifact.path}`} download className="rounded border border-white/10 px-2 py-1 text-[10px] text-slate-300">Download</a></div></div>{artifact.unsupportedReason && <p className="mt-2 text-[9px] text-amber-300/80">{artifact.unsupportedReason}</p>}</article>)}</div></details>;
          })}
          {!filtered.length && <p className="py-8 text-center text-sm text-slate-500">No FastSurfer artifacts match these filters.</p>}
        </div>
      </div>
      {viewerLayers && <NiivueViewer layers={viewerLayers} onClose={() => setViewerLayers(null)} />}
      {surfaceLayer && <NeuroSurfaceViewer surface={surfaceLayer} onClose={() => setSurfaceLayer(null)} />}
      {statsPath && <FreeSurferStatsViewer runId={runId} path={statsPath} onClose={() => setStatsPath(null)} />}
    </section>
  );
}
