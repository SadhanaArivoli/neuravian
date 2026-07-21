/**
 * Pipeline Comparison Studio
 *
 * Compares outputs from two different pipelines (anatomical family) or two
 * runs of the same connectivity pipeline on different data (connectivity family).
 * Route: /compare?a=<runId>&b=<runId>
 *
 * Comparison families:
 *   anatomical   – brain masks / skull-stripped NIfTI (SynthStrip vs BrainChop etc.)
 *   connectivity – Pearson correlation matrices from functional-connectivity
 *
 * Candidate eligibility (three tiers, from comparisonEligibility.ts):
 *   verified   – shared source_run_id (same ancestor)
 *   unverified – same dataset_id only
 *   ineligible – different datasets
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Niivue } from "@niivue/niivue";
import { useRuns } from "../hooks/useRuns";
import { useRunResults } from "../hooks/useRuns";
import { fetchPipeline, fetchRunFile, fetchRunTextFile } from "../api/client";
import type { RunMetadata, RunResults, RunSummary } from "../api/client";
import NiivuePanel from "../components/domain/NiivuePanel";
import type { NiivueLayer } from "../components/domain/NiivuePanel";
import {
  classifyEligibility,
  detectComparisonFamily,
  detectRunFamily,
  sortByEligibility,
  geometriesCompatible,
  checkAlffCompatibility,
  checkRehoCompatibility,
  computeMapDifferenceStats,
  type ComparisonFamily,
  type DiceStats,
  type NiftiGeometry,
} from "../lib/comparisonEligibility";
import {
  canonicalAtlasId,
  checkMatrixCompatibility,
  connectivityMatrixDifference,
  connectivityMatrixRange,
  parseConnectivityMatrixCsv,
  type ConnectivityMatrixData,
  type ConnectivityMetadata,
  type MatrixCompatibilityResult,
} from "../lib/connectivityMatrix";
import {
  compareRoiStatistics,
  normalizeRoiStatisticsJson,
  parseRoiStatisticsCsv,
  type RoiStatisticsComparison,
} from "../lib/roiStatistics";
import { parseNiftiHeader, DATATYPE_LABELS, differenceNiftiBlobUrl, loadFloat32Nifti } from "../lib/niftiHeader";
import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type AnatomicalViewMode = "sidebyside" | "linked" | "maskoverlay" | "difference";
type MatrixViewMode = "sidebyside" | "difference" | "summary";

interface RunOption {
  run: RunSummary;
  producedTypes: string[];
}

interface DiceState {
  status: "idle" | "loading" | "done" | "incompatible" | "error";
  stats?: DiceStats;
  message?: string;
}

interface ConnectivityCompareState {
  status: "idle" | "loading" | "done" | "error";
  message?: string;
  a?: ConnectivityMatrixData;
  b?: ConnectivityMatrixData;
  metaA?: ConnectivityMetadata;
  metaB?: ConnectivityMetadata;
  compatibility?: MatrixCompatibilityResult;
  frobenius?: number;
  minDiff?: number;
  maxDiff?: number;
  largestAbsDiff?: number;
  roiComparison?: RoiStatisticsComparison;
}

interface AlffMetadata {
  tr: number; nyquist_frequency: number; frequency_band: [number, number]; confound_strategy: string;
  normalization: string; detrending: string; mask_voxel_count: number; runtime_seconds: number;
  alff_statistics: Record<string, number>; falff_statistics: Record<string, number>; warnings: string[];
}

interface RehoMetadata {
  tr: number; neighborhood: number; neighborhood_label: string; confound_strategy: string;
  detrending: string; z_normalize: boolean; mask_voxel_count: number; valid_voxel_count: number;
  excluded_edge_voxels: number; reho_statistics: Record<string, number>; warnings: string[]; runtime_seconds: number;
}

function RehoComparisonPanel({runIdA,runIdB,resultsA,resultsB,labelA,labelB}:{runIdA:number;runIdB:number;resultsA:RunResults;resultsB:RunResults;labelA:string;labelB:string}) {
  const [state,setState]=useState<{loading:boolean;error?:string;metaA?:RehoMetadata;metaB?:RehoMetadata;stats?:ReturnType<typeof computeMapDifferenceStats>;differenceUrl?:string}>({loading:true});
  useEffect(()=>{ let cancelled=false; let objectUrl:string|undefined;
    setState({loading:true});
    Promise.all([
      fetchRunFile<RehoMetadata>(runIdA,"reho_metadata.json"), fetchRunFile<RehoMetadata>(runIdB,"reho_metadata.json")
    ]).then(async ([metaA,metaB])=>{
      const compatibility=checkRehoCompatibility(metaA,metaB);
      if(!compatibility.compatible) throw new Error(`Comparison blocked: incompatible ${compatibility.differences.join(", ")}.`);
      const pathA=resultsA.niftis?.find(f=>f.name==="reho_map.nii.gz")?.path;
      const pathB=resultsB.niftis?.find(f=>f.name==="reho_map.nii.gz")?.path;
      if(!pathA||!pathB) throw new Error("Both runs must contain reho_map.nii.gz");
      const [mapA,mapB]=await Promise.all([loadFloat32Nifti(`/api/runs/${runIdA}/files/${pathA}`),loadFloat32Nifti(`/api/runs/${runIdB}/files/${pathB}`)]);
      if(!geometriesCompatible(mapA.header,mapB.header)) throw new Error("Comparison blocked: incompatible image geometry.");
      const stats=computeMapDifferenceStats(mapA.values,mapB.values); objectUrl=differenceNiftiBlobUrl(mapA.bytes,mapA.header.voxOffset,stats.difference);
      if(!cancelled)setState({loading:false,metaA,metaB,stats,differenceUrl:objectUrl});
    }).catch(e=>{if(!cancelled)setState({loading:false,error:e instanceof Error?e.message:String(e)})});
    return()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl)};
  },[runIdA,runIdB,resultsA,resultsB]);
  if(state.loading)return <div className="text-xs text-gray-500">Loading ReHo comparison…</div>;
  if(state.error)return <div className="rounded border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">{state.error}</div>;
  const a=state.metaA!,b=state.metaB!,s=state.stats!;
  const rows:[[string,string,string],...Array<[string,string,string]>]=[
    ["Neighborhood",a.neighborhood_label,b.neighborhood_label],
    ["TR",`${a.tr} s`,`${b.tr} s`],
    ["Confound strategy",a.confound_strategy,b.confound_strategy],
    ["Detrending",a.detrending,b.detrending],
    ["Z-normalize",String(a.z_normalize),String(b.z_normalize)],
    ["Mask voxels",String(a.mask_voxel_count),String(b.mask_voxel_count)],
    ["Valid voxels",String(a.valid_voxel_count),String(b.valid_voxel_count)],
  ];
  const bins=Array.from({length:31},()=>0); let maxD=1e-12; for(const v of s.difference)maxD=Math.max(maxD,Math.abs(v)); for(const v of s.difference){const i=Math.min(30,Math.max(0,Math.floor(((v+maxD)/(2*maxD))*31)));bins[i]++} const peak=Math.max(...bins,1);
  return <div className="space-y-4">
    <SectionHeading>Regional Homogeneity (ReHo) comparison</SectionHeading>
    <p className="text-xs text-gray-500">Descriptive voxelwise KCC map comparison only; no inferential statistics are performed.</p>
    <table className="w-full text-xs"><thead><tr className="border-b border-white/10"><th className="p-2 text-left">Setting</th><th className="p-2 text-left">{labelA}</th><th className="p-2 text-left">{labelB}</th><th>Compatible</th></tr></thead><tbody>{rows.map(([k,x,y])=>{const diff=x!==y;return<tr key={k} className="border-b border-white/5"><td className="p-2 text-gray-400">{k}</td><td className={`p-2 font-mono ${diff?"text-amber-300 font-semibold":""}`}>{x}</td><td className={`p-2 font-mono ${diff?"text-amber-300 font-semibold":""}`}>{y}</td><td className="text-center">{diff?<span className="text-amber-400">≠</span>:<span className="text-green-400">✓</span>}</td></tr>})}</tbody></table>
    <div className="grid grid-cols-5 gap-2">{[["Map correlation",s.correlation?.toFixed(6)??"—"],["Mean |difference|",s.meanAbsoluteDifference.toPrecision(6)],["RMSE",s.rmse.toPrecision(6)],["Max |difference|",s.maximumAbsoluteDifference.toPrecision(6)],["Voxels",String(s.voxelCount)]].map(([k,v])=><div key={k} className="rounded border border-white/10 bg-surface-overlay p-3"><div className="text-[11px] text-gray-500">{k}</div><div className="font-mono text-sm">{v}</div></div>)}</div>
    <div className="grid grid-cols-2 gap-3"><div className="h-[420px] overflow-hidden rounded border border-white/10">{state.differenceUrl&&<NiivuePanel label="ReHo difference (B − A)" mapType="difference" layers={[{url:state.differenceUrl,name:"Difference",colormap:"blue2red"}]}/>}</div><div className="rounded border border-white/10 bg-surface-overlay p-4"><div className="mb-3 text-xs text-gray-400">Difference histogram (B − A)</div><svg viewBox="0 0 310 180" className="h-[340px] w-full" aria-label="Difference histogram">{bins.map((v,i)=><rect key={i} x={i*10} y={170-(v/peak)*155} width="8" height={(v/peak)*155} fill="#818cf8"/>)}<line x1="155" y1="5" x2="155" y2="170" stroke="#f59e0b"/></svg></div></div>
    <p className="text-xs text-gray-500">Reference: Zang et al. (2004). Regional homogeneity approach to fMRI data analysis. NeuroImage 22(1):394–400.</p>
  </div>;
}

function AlffFalffComparisonPanel({runIdA,runIdB,resultsA,resultsB,labelA,labelB}:{runIdA:number;runIdB:number;resultsA:RunResults;resultsB:RunResults;labelA:string;labelB:string}) {
  const [measure,setMeasure]=useState<"alff"|"falff">("alff");
  const [state,setState]=useState<{loading:boolean;error?:string;metaA?:AlffMetadata;metaB?:AlffMetadata;stats?:ReturnType<typeof computeMapDifferenceStats>;differenceUrl?:string}>({loading:true});
  useEffect(()=>{ let cancelled=false; let objectUrl:string|undefined;
    setState({loading:true});
    Promise.all([
      fetchRunFile<AlffMetadata>(runIdA,"alff_falff_metadata.json"), fetchRunFile<AlffMetadata>(runIdB,"alff_falff_metadata.json")
    ]).then(async ([metaA,metaB])=>{
      const compatibility=checkAlffCompatibility(metaA,metaB);
      if(!compatibility.compatible) throw new Error(`Comparison blocked: incompatible ${compatibility.differences.join(", ")}.`);
      const fileName=measure === "alff" ? "alff_map.nii.gz" : "falff_map.nii.gz";
      const pathA=resultsA.niftis?.find(f=>f.name===fileName)?.path; const pathB=resultsB.niftis?.find(f=>f.name===fileName)?.path;
      if(!pathA||!pathB) throw new Error(`Both runs must contain ${fileName}`);
      const [mapA,mapB]=await Promise.all([loadFloat32Nifti(`/api/runs/${runIdA}/files/${pathA}`),loadFloat32Nifti(`/api/runs/${runIdB}/files/${pathB}`)]);
      if(!geometriesCompatible(mapA.header,mapB.header)) throw new Error("Comparison blocked: incompatible image geometry.");
      const stats=computeMapDifferenceStats(mapA.values,mapB.values); objectUrl=differenceNiftiBlobUrl(mapA.bytes,mapA.header.voxOffset,stats.difference);
      if(!cancelled)setState({loading:false,metaA,metaB,stats,differenceUrl:objectUrl});
    }).catch(e=>{if(!cancelled)setState({loading:false,error:e instanceof Error?e.message:String(e)})});
    return()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl)};
  },[runIdA,runIdB,measure,resultsA,resultsB]);
  if(state.loading)return <div className="text-xs text-gray-500">Loading ALFF/fALFF comparison…</div>;
  if(state.error)return <div className="rounded border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">{state.error}</div>;
  const a=state.metaA!,b=state.metaB!,s=state.stats!;
  const rows:[[string,string,string],...Array<[string,string,string]>]=[
    ["Frequency band",`${a.frequency_band[0]}–${a.frequency_band[1]} Hz`,`${b.frequency_band[0]}–${b.frequency_band[1]} Hz`],
    ["TR",`${a.tr} s`,`${b.tr} s`],["Nyquist",`${a.nyquist_frequency} Hz`,`${b.nyquist_frequency} Hz`],
    ["Confound strategy",a.confound_strategy,b.confound_strategy],["Normalization",a.normalization,b.normalization],
    ["Detrending",a.detrending,b.detrending],["Mask voxels",String(a.mask_voxel_count),String(b.mask_voxel_count)]
  ];
  const bins=Array.from({length:31},()=>0); let max=1e-12; for(const v of s.difference)max=Math.max(max,Math.abs(v)); for(const v of s.difference){const i=Math.min(30,Math.max(0,Math.floor(((v+max)/(2*max))*31)));bins[i]++} const peak=Math.max(...bins,1);
  return <div className="space-y-4">
    <div className="flex items-center gap-2"><SectionHeading>ALFF / fALFF comparison</SectionHeading><select aria-label="Measure" value={measure} onChange={e=>setMeasure(e.target.value as "alff"|"falff")} className="rounded border border-white/20 bg-surface-raised px-2 py-1 text-xs"><option value="alff">ALFF vs ALFF</option><option value="falff">fALFF vs fALFF</option></select></div>
    <p className="text-xs text-gray-500">Descriptive voxelwise comparison only; no inferential statistics are performed.</p>
    <table className="w-full text-xs"><thead><tr className="border-b border-white/10"><th className="p-2 text-left">Setting</th><th className="p-2 text-left">{labelA}</th><th className="p-2 text-left">{labelB}</th><th>Compatible</th></tr></thead><tbody>{rows.map(([k,x,y])=><tr key={k} className="border-b border-white/5"><td className="p-2 text-gray-400">{k}</td><td className="p-2 font-mono">{x}</td><td className="p-2 font-mono">{y}</td><td className="text-center text-green-400">✓</td></tr>)}</tbody></table>
    <div className="grid grid-cols-5 gap-2">{[["Map correlation",s.correlation?.toFixed(6)??"—"],["Mean |difference|",s.meanAbsoluteDifference.toPrecision(6)],["RMSE",s.rmse.toPrecision(6)],["Maximum |difference|",s.maximumAbsoluteDifference.toPrecision(6)],["Voxels",String(s.voxelCount)]].map(([k,v])=><div key={k} className="rounded border border-white/10 bg-surface-overlay p-3"><div className="text-[11px] text-gray-500">{k}</div><div className="font-mono text-sm">{v}</div></div>)}</div>
    <div className="grid grid-cols-2 gap-3"><div className="h-[420px] overflow-hidden rounded border border-white/10">{state.differenceUrl&&<NiivuePanel label={`${measure.toUpperCase()} difference (B − A)`} mapType="difference" layers={[{url:state.differenceUrl,name:"Difference",colormap:"blue2red"}]}/>}</div><div className="rounded border border-white/10 bg-surface-overlay p-4"><div className="mb-3 text-xs text-gray-400">Difference histogram (B − A)</div><svg viewBox="0 0 310 180" className="h-[340px] w-full" aria-label="Difference histogram">{bins.map((v,i)=><rect key={i} x={i*10} y={170-(v/peak)*155} width="8" height={(v/peak)*155} fill="#818cf8"/>)}<line x1="155" y1="5" x2="155" y2="170" stroke="#f59e0b"/></svg></div></div>
  </div>;
}

function formatAtlasBadge(meta: ConnectivityMetadata | undefined, fallback: string): string {
  if (!meta) return fallback;
  const roi = meta.n_rois ? ` · ${meta.n_rois} ROIs` : "";
  return `${meta.atlas ?? meta.atlas_id ?? fallback}${roi}`;
}

async function loadRoiStatistics(runId: number, results: RunResults) {
  const jsonFile = results.roi_statistics?.find((file) => file.path.endsWith(".json"));
  if (jsonFile) {
    return normalizeRoiStatisticsJson(await fetchRunFile<unknown>(runId, jsonFile.path));
  }
  const csvFile = results.roi_statistics?.find((file) => file.path.endsWith(".csv"));
  if (csvFile) {
    return parseRoiStatisticsCsv(await fetchRunTextFile(runId, csvFile.path));
  }
  return [];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRuntime(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

const PROFILE_LABEL: Record<string, { label: string; cls: string }> = {
  "local-ok":     { label: "Local OK",          cls: "bg-green-100 text-green-700 border border-green-200" },
  "local-slow":   { label: "Slow locally",      cls: "bg-amber-100 text-amber-700 border border-amber-200" },
  "local-unsafe": { label: "Cloud recommended", cls: "bg-red-100 text-red-700 border border-red-200" },
};


// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-gray-100 mb-3">{children}</h2>;
}

function DiffCell({ a, b, render }: { a: unknown; b: unknown; render: (v: unknown) => React.ReactNode }) {
  const differs = String(a) !== String(b);
  return (
    <>
      <td className={`px-3 py-2 text-xs font-mono ${differs ? "text-amber-300 font-semibold" : "text-gray-200"}`}>
        {render(a)}
      </td>
      <td className={`px-3 py-2 text-xs font-mono ${differs ? "text-amber-300 font-semibold" : "text-gray-200"}`}>
        {render(b)}
      </td>
    </>
  );
}

// ── MetadataComparison ────────────────────────────────────────────────────────

interface MetaRow {
  label: string;
  getA: (m: RunMetadata) => unknown;
  render?: (v: unknown) => React.ReactNode;
}

const META_ROWS: MetaRow[] = [
  { label: "Pipeline", getA: (m) => m.pipeline_display_name ?? m.pipeline_id },
  { label: "Version", getA: (m) => m.pipeline_version },
  { label: "Execution", getA: (m) => m.execution_type },
  { label: "Container", getA: (m) => m.container_image ?? "—" },
  {
    label: "Compute profile",
    getA: (m) => m.compute_profile ?? "—",
    render: (v) => {
      const badge = PROFILE_LABEL[v as string];
      return badge ? (
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
          {badge.label}
        </span>
      ) : String(v);
    },
  },
  {
    label: "Runtime",
    getA: (m) => m.runtime_seconds,
    render: (v) => formatRuntime(v as number | null),
  },
  { label: "Status", getA: (m) => m.status },
];

function MetadataComparison({ metaA, metaB, labelA, labelB }: {
  metaA: RunMetadata;
  metaB: RunMetadata;
  labelA: string;
  labelB: string;
}) {
  return (
    <div>
      <SectionHeading>Metadata comparison</SectionHeading>
      <div className="rounded-lg border border-white/10 overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-white/5 border-b border-white/10">
              <th className="px-3 py-2 text-xs font-medium text-gray-400 w-32">Field</th>
              <th className="px-3 py-2 text-xs font-medium text-gray-400">{labelA}</th>
              <th className="px-3 py-2 text-xs font-medium text-gray-400">{labelB}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {META_ROWS.map((row) => {
              const a = row.getA(metaA);
              const b = row.getA(metaB);
              const differs = String(a) !== String(b);
              const render = row.render ?? ((v) => String(v));
              return (
                <tr key={row.label} className={differs ? "bg-amber-500/5" : ""}>
                  <td className="px-3 py-2 text-xs text-gray-400 align-top">{row.label}</td>
                  <DiffCell a={a} b={b} render={render} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {metaA.runtime_seconds !== null && metaB.runtime_seconds !== null && (
        <RuntimeBar
          labelA={labelA}
          labelB={labelB}
          runtimeA={metaA.runtime_seconds}
          runtimeB={metaB.runtime_seconds}
        />
      )}
    </div>
  );
}

// ── RuntimeBar ────────────────────────────────────────────────────────────────

function RuntimeBar({ labelA, labelB, runtimeA, runtimeB }: {
  labelA: string; labelB: string; runtimeA: number; runtimeB: number;
}) {
  const max = Math.max(runtimeA, runtimeB);
  const pctA = max > 0 ? (runtimeA / max) * 100 : 0;
  const pctB = max > 0 ? (runtimeB / max) * 100 : 0;
  const faster = runtimeA <= runtimeB ? "A" : "B";
  const speedup = max > 0 ? (Math.max(runtimeA, runtimeB) / Math.min(runtimeA, runtimeB)).toFixed(1) : "1.0";

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-surface-raised px-4 py-3">
      <p className="text-xs text-gray-400 mb-3">Runtime comparison</p>
      <div className="space-y-2">
        {[
          { label: labelA, pct: pctA, runtime: runtimeA, color: "bg-blue-500" },
          { label: labelB, pct: pctB, runtime: runtimeB, color: "bg-violet-500" },
        ].map(({ label, pct, runtime, color }) => (
          <div key={label} className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-24 truncate shrink-0" title={label}>{label}</span>
            <div className="flex-1 bg-white/10 rounded-full h-2 overflow-hidden">
              <div className={`${color} h-full rounded-full transition-all`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-gray-300 font-mono w-14 text-right shrink-0">
              {formatRuntime(runtime)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-500">
        {faster === "A" ? labelA : labelB} was {speedup}× faster
      </p>
    </div>
  );
}

// ── GeometryTable ─────────────────────────────────────────────────────────────

interface GeomState {
  status: "idle" | "loading" | "done" | "error";
  geomA?: NiftiGeometry;
  geomB?: NiftiGeometry;
  error?: string;
}

function GeometryTable({ geomState, labelA, labelB }: {
  geomState: GeomState;
  labelA: string;
  labelB: string;
}) {
  if (geomState.status === "idle") return null;
  if (geomState.status === "loading") {
    return (
      <div className="text-xs text-gray-500 flex items-center gap-2">
        <div className="h-3 w-3 rounded-full border border-blue-500 border-t-transparent animate-spin" />
        Parsing NIfTI headers…
      </div>
    );
  }
  if (geomState.status === "error") {
    return (
      <div className="text-xs text-red-400">Could not parse geometry: {geomState.error}</div>
    );
  }
  if (!geomState.geomA || !geomState.geomB) return null;

  const gA = geomState.geomA;
  const gB = geomState.geomB;
  const compatible = geometriesCompatible(gA, gB);

  const rows: Array<{ label: string; vA: string; vB: string }> = [
    {
      label: "Dimensions",
      vA: gA.dims.join(" × "),
      vB: gB.dims.join(" × "),
    },
    {
      label: "Voxel spacing (mm)",
      vA: gA.pixdim.map((v) => v.toFixed(4)).join(" × "),
      vB: gB.pixdim.map((v) => v.toFixed(4)).join(" × "),
    },
    {
      label: "Datatype",
      vA: DATATYPE_LABELS[gA.datatype] ?? `code ${gA.datatype}`,
      vB: DATATYPE_LABELS[gB.datatype] ?? `code ${gB.datatype}`,
    },
    {
      label: "qform / sform",
      vA: `${gA.qformCode} / ${gA.sformCode}`,
      vB: `${gB.qformCode} / ${gB.sformCode}`,
    },
  ];

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <SectionHeading>Artifact geometry</SectionHeading>
        <span className={`mb-3 text-xs px-2 py-0.5 rounded-full font-medium ${
          compatible
            ? "bg-green-500/10 text-green-400 border border-green-500/20"
            : "bg-red-500/10 text-red-400 border border-red-500/20"
        }`}>
          {compatible ? "Compatible" : "Geometry mismatch"}
        </span>
      </div>
      <div className="rounded-lg border border-white/10 overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-white/5 border-b border-white/10">
              <th className="px-3 py-2 text-xs font-medium text-gray-400 w-36">Field</th>
              <th className="px-3 py-2 text-xs font-medium text-gray-400">{labelA}</th>
              <th className="px-3 py-2 text-xs font-medium text-gray-400">{labelB}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map(({ label, vA, vB }) => {
              const differs = vA !== vB;
              return (
                <tr key={label} className={differs ? "bg-amber-500/5" : ""}>
                  <td className="px-3 py-2 text-xs text-gray-400">{label}</td>
                  <td className={`px-3 py-2 text-xs font-mono ${differs ? "text-amber-300 font-semibold" : "text-gray-200"}`}>{vA}</td>
                  <td className={`px-3 py-2 text-xs font-mono ${differs ? "text-amber-300 font-semibold" : "text-gray-200"}`}>{vB}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!compatible && (
        <p className="mt-2 text-xs text-amber-400">
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />Voxel-wise Difference and Dice are disabled — masks must share the same dimensions and voxel spacing.
        </p>
      )}
    </div>
  );
}

// ── DicePanel ─────────────────────────────────────────────────────────────────

function DicePanel({ diceState }: { diceState: DiceState }) {
  if (diceState.status === "idle") return null;

  if (diceState.status === "loading") {
    return (
      <div className="rounded-lg border border-white/10 bg-surface-raised px-4 py-3">
        <p className="text-xs text-gray-400 mb-2">Dice coefficient</p>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <div className="h-3 w-3 rounded-full border border-blue-500 border-t-transparent animate-spin shrink-0" />
          {diceState.message ?? "Computing…"}
        </div>
      </div>
    );
  }

  if (diceState.status === "incompatible") {
    return (
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-300">
        Dice unavailable: {diceState.message}
      </div>
    );
  }

  if (diceState.status === "error") {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-300">
        Dice error: {diceState.message}
      </div>
    );
  }

  const s = diceState.stats!;
  const dicePct = (s.dice * 100).toFixed(1);

  return (
    <div className="rounded-lg border border-white/10 bg-surface-raised px-4 py-3">
      <p className="text-xs text-gray-400 mb-3">Dice coefficient (mask overlap)</p>
      <div className="flex items-center gap-4 mb-3">
        <span className="text-3xl font-bold font-mono text-gray-100">{dicePct}%</span>
        <div className="flex-1 bg-white/10 rounded-full h-2.5 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500"
            style={{ width: `${dicePct}%` }}
          />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Intersection", value: s.intersection.toLocaleString(), color: "text-green-400" },
          { label: "A only", value: s.aOnly.toLocaleString(), color: "text-blue-400" },
          { label: "B only", value: s.bOnly.toLocaleString(), color: "text-violet-400" },
          { label: "Total foreground", value: s.totalForeground.toLocaleString(), color: "text-gray-300" },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded bg-white/5 px-3 py-2">
            <div className="text-[10px] text-gray-500 mb-0.5">{label}</div>
            <div className={`text-xs font-mono font-semibold ${color}`}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── MatrixHeatmap ─────────────────────────────────────────────────────────────

function MatrixHeatmap({
  matrix,
  mode,
  otherMatrix,
}: {
  matrix: ConnectivityMatrixData;
  mode: "matrix" | "diff";
  otherMatrix?: ConnectivityMatrixData;
}) {
  const MAX_CELLS = 40;
  const size = Math.min(matrix.values.length, MAX_CELLS);

  return (
    <div
      className="grid overflow-hidden rounded border border-white/10"
      style={{
        gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
        width: "100%",
        aspectRatio: "1",
      }}
    >
      {matrix.values.slice(0, size).map((row, y) =>
        row.slice(0, size).map((value, x) => {
          const scaled = Math.max(-1, Math.min(1, value));
          // Blue-white-red diverging (matches blue2red NiiVue colormap)
          let r: number, g: number, b: number;
          if (scaled >= 0) {
            r = 255; g = Math.round(255 * (1 - scaled)); b = Math.round(255 * (1 - scaled));
          } else {
            const pos = 1 + scaled;
            r = Math.round(255 * pos); g = Math.round(255 * pos); b = 255;
          }
          const color = `rgb(${r},${g},${b})`;

          const labelY = matrix.labels[y] ?? `ROI ${y + 1}`;
          const labelX = matrix.labels[x] ?? `ROI ${x + 1}`;
          let title: string;
          if (mode === "diff") {
            title = `${labelY} × ${labelX}\nΔ = ${value.toFixed(4)}`;
          } else {
            title = `${labelY} × ${labelX}: ${value.toFixed(4)}`;
            if (otherMatrix) {
              const other = otherMatrix.values[y]?.[x];
              if (other !== undefined) {
                title += `\nOther: ${other.toFixed(4)}\nΔ = ${(value - other).toFixed(4)}`;
              }
            }
          }

          return (
            <div
              key={`${y}-${x}`}
              title={title}
              style={{ backgroundColor: color }}
            />
          );
        }),
      )}
    </div>
  );
}

// ── ConnectivityComparisonPanel ───────────────────────────────────────────────

function ConnectivityComparisonPanel({
  state,
  labelA,
  labelB,
  matrixViewMode,
  onMatrixViewModeChange,
}: {
  state: ConnectivityCompareState;
  labelA: string;
  labelB: string;
  matrixViewMode: MatrixViewMode;
  onMatrixViewModeChange: (mode: MatrixViewMode) => void;
}) {
  if (state.status === "idle") return null;

  if (state.status === "loading") {
    return (
      <div className="rounded-lg border border-white/10 bg-surface-raised px-4 py-3 text-xs text-gray-400 flex items-center gap-2">
        <div className="h-3 w-3 rounded-full border border-blue-500 border-t-transparent animate-spin shrink-0" />
        Loading connectivity matrices…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-300">
        Connectivity comparison unavailable: {state.message}
      </div>
    );
  }

  if (!state.a || !state.b) return null;

  const compat = state.compatibility;
  const rangeA = connectivityMatrixRange(state.a);
  const rangeB = connectivityMatrixRange(state.b);

  const canDiff = compat?.compatible !== false;
  const diffMatrix: ConnectivityMatrixData | null = canDiff
    ? {
        labels: state.a.labels,
        values: state.a.values.map((row, y) =>
          row.map((value, x) => value - (state.b!.values[y]?.[x] ?? 0)),
        ),
      }
    : null;

  const MATRIX_VIEW_MODES: Array<{ mode: MatrixViewMode; label: string }> = [
    { mode: "sidebyside", label: "Side by side" },
    { mode: "difference", label: "Difference" },
    { mode: "summary", label: "Summary" },
  ];

  return (
    <div className="space-y-4">
      {/* Header: mode badge + view switcher */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SectionHeading>Connectivity matrix comparison</SectionHeading>
          {compat && (
            <span
              className={`mb-3 text-xs px-2 py-0.5 rounded-full font-medium ${
                compat.compatible
                  ? compat.mode === "same-source"
                    ? "bg-blue-500/10 text-blue-300 border border-blue-500/20"
                    : "bg-green-500/10 text-green-400 border border-green-500/20"
                  : "bg-red-500/10 text-red-400 border border-red-500/20"
              }`}
            >
              {compat.compatible
                ? compat.mode === "same-source"
                  ? "Same-source comparison"
                  : "Cross-subject comparison"
                : `Incompatible: ${compat.reason}`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-surface-raised p-1 mb-3">
          {MATRIX_VIEW_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              disabled={!canDiff && mode === "difference"}
              onClick={() => onMatrixViewModeChange(mode)}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                matrixViewMode === mode
                  ? "bg-blue-600 text-white shadow-sm"
                  : !canDiff && mode === "difference"
                    ? "text-gray-600 cursor-not-allowed"
                    : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Confound strategy mismatch warning (FC runs with different strategies) */}
      {state.metaA?.confound_strategy && state.metaB?.confound_strategy &&
       state.metaA.confound_strategy !== state.metaB.confound_strategy && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />
          <strong>Confound strategy mismatch:</strong>{" "}
          {labelA} used <code className="bg-amber-500/10 px-1 rounded">{state.metaA.confound_strategy}</code> and{" "}
          {labelB} used <code className="bg-amber-500/10 px-1 rounded">{state.metaB.confound_strategy}</code>.
          Strategies that include global signal regression (GSR) substantially change correlation sign and magnitude.
          Difference values here reflect both biology and preprocessing variation — interpret with caution.
        </div>
      )}

      {/* Cross-subject warning */}
      {compat?.mode === "cross-subject" && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />Cross-subject comparison: these matrices are from different source BOLD files.
          Connectivity values reflect different subjects/sessions. Differences may reflect
          biology, not pipeline variation.
        </div>
      )}

      {compat && !compat.compatible && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2 text-xs text-red-300">
          Matrix difference is disabled because these runs are not directly comparable:
          {" "}{compat.reason}. Atlas metadata is still shown side by side below.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-200">
          <span className="text-gray-400">{labelA}</span>
          <div className="mt-1 font-mono text-blue-100">{formatAtlasBadge(state.metaA, "Atlas not recorded")}</div>
        </div>
        <div className="rounded border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-xs text-violet-200">
          <span className="text-gray-400">{labelB}</span>
          <div className="mt-1 font-mono text-violet-100">{formatAtlasBadge(state.metaB, "Atlas not recorded")}</div>
        </div>
      </div>

      {/* Heatmaps */}
      {matrixViewMode === "sidebyside" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 bg-surface-raised p-3">
            <p className="mb-2 text-xs font-medium text-blue-300">{labelA}</p>
            <MatrixHeatmap matrix={state.a} mode="matrix" otherMatrix={state.b} />
          </div>
          <div className="rounded-lg border border-white/10 bg-surface-raised p-3">
            <p className="mb-2 text-xs font-medium text-violet-300">{labelB}</p>
            <MatrixHeatmap matrix={state.b} mode="matrix" otherMatrix={state.a} />
          </div>
        </div>
      )}

      {matrixViewMode === "difference" && diffMatrix && (
        <div className="rounded-lg border border-white/10 bg-surface-raised p-3">
          <p className="mb-1 text-xs font-medium text-gray-300">
            Difference heatmap — {labelA} minus {labelB}
          </p>
          <p className="mb-3 text-[10px] text-gray-500">
            Blue = A &lt; B · Red = A &gt; B · White = near-zero difference
          </p>
          <MatrixHeatmap matrix={diffMatrix} mode="diff" />
        </div>
      )}

      {/* Metrics grid */}
      {matrixViewMode !== "summary" && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: "Dimensions", value: `${rangeA.rows}×${rangeA.cols}` },
            { label: "Atlas", value: state.metaA?.atlas_id ?? "—", title: state.metaA?.atlas },
            { label: "A range", value: `${rangeA.min.toFixed(3)} → ${rangeA.max.toFixed(3)}` },
            { label: "B range", value: `${rangeB.min.toFixed(3)} → ${rangeB.max.toFixed(3)}` },
            { label: "Frobenius diff", value: canDiff ? state.frobenius?.toFixed(4) ?? "—" : "not comparable", title: "||A - B||_F (entry-wise Euclidean distance)" },
            { label: "Max |Δ|", value: canDiff ? state.largestAbsDiff?.toFixed(4) ?? "—" : "not comparable", title: "Largest single-entry absolute difference" },
          ].map(({ label, value, title }) => (
            <div key={label} title={title} className="rounded border border-white/10 bg-white/5 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
              <div className="font-mono text-xs font-semibold text-gray-200 truncate" title={value}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {state.roiComparison && (
        <div className="rounded-lg border border-white/10 bg-surface-raised p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-gray-100">ROI statistics comparison</h3>
              <p className="text-xs text-gray-500">
                Mean signal differences only; no statistical hypothesis testing is performed.
              </p>
            </div>
            <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-xs text-cyan-300">
              {state.roiComparison.count} matched ROIs
            </span>
          </div>
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded border border-white/10 bg-white/5 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Mean Δ signal</div>
              <div className="font-mono text-sm font-semibold text-gray-200">
                {state.roiComparison.meanDifference.toFixed(4)}
              </div>
            </div>
            <div className="rounded border border-white/10 bg-white/5 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Mean |Δ| signal</div>
              <div className="font-mono text-sm font-semibold text-amber-300">
                {state.roiComparison.meanAbsoluteDifference.toFixed(4)}
              </div>
            </div>
          </div>
          <div className="overflow-x-auto rounded border border-white/10">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-white/5 text-gray-400">
                <tr>
                  <th className="px-3 py-2 font-medium">ROI</th>
                  <th className="px-3 py-2 font-medium">Network</th>
                  <th className="px-3 py-2 font-medium">{labelA} mean</th>
                  <th className="px-3 py-2 font-medium">{labelB} mean</th>
                  <th className="px-3 py-2 font-medium">Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-gray-300">
                {state.roiComparison.largestDifferences.slice(0, 6).map((row) => (
                  <tr key={`${row.roi_number}-${row.roi_label}`}>
                    <td className="max-w-[280px] truncate px-3 py-2" title={row.roi_label}>
                      {row.roi_number}. {row.roi_label}
                    </td>
                    <td className="px-3 py-2">{row.network ?? "—"}</td>
                    <td className="px-3 py-2 font-mono">{row.mean_a.toFixed(4)}</td>
                    <td className="px-3 py-2 font-mono">{row.mean_b.toFixed(4)}</td>
                    <td className="px-3 py-2 font-mono text-amber-300">{row.difference.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Summary panel */}
      {matrixViewMode === "summary" && (
        <div className="rounded-lg border border-white/10 bg-surface-raised p-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {/* Run A summary */}
            <div className="rounded border border-blue-500/20 bg-blue-500/5 p-3">
              <p className="text-xs font-medium text-blue-300 mb-2">{labelA}</p>
              <dl className="space-y-1 text-xs">
                {[
                  ["Atlas", state.metaA?.atlas ?? "—"],
                  ["Subject", state.metaA?.subject ?? "—"],
                  ["Task", state.metaA?.task ?? "—"],
                  ["ROIs", String(state.metaA?.n_rois ?? rangeA.rows)],
                  ["Volumes", String(state.metaA?.n_volumes ?? "—")],
                  ["r range", `${state.metaA?.correlation_min?.toFixed(3) ?? rangeA.min.toFixed(3)} → ${state.metaA?.correlation_max?.toFixed(3) ?? rangeA.max.toFixed(3)}`],
                  ["Mean r (off-diag)", state.metaA?.correlation_mean?.toFixed(4) ?? "—"],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="text-gray-500 w-28 shrink-0">{k}</dt>
                    <dd className="text-gray-200 font-mono">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
            {/* Run B summary */}
            <div className="rounded border border-violet-500/20 bg-violet-500/5 p-3">
              <p className="text-xs font-medium text-violet-300 mb-2">{labelB}</p>
              <dl className="space-y-1 text-xs">
                {[
                  ["Atlas", state.metaB?.atlas ?? "—"],
                  ["Subject", state.metaB?.subject ?? "—"],
                  ["Task", state.metaB?.task ?? "—"],
                  ["ROIs", String(state.metaB?.n_rois ?? rangeB.rows)],
                  ["Volumes", String(state.metaB?.n_volumes ?? "—")],
                  ["r range", `${state.metaB?.correlation_min?.toFixed(3) ?? rangeB.min.toFixed(3)} → ${state.metaB?.correlation_max?.toFixed(3) ?? rangeB.max.toFixed(3)}`],
                  ["Mean r (off-diag)", state.metaB?.correlation_mean?.toFixed(4) ?? "—"],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="text-gray-500 w-28 shrink-0">{k}</dt>
                    <dd className="text-gray-200 font-mono">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          {/* Difference stats */}
          {canDiff && (
            <div>
              <p className="text-xs text-gray-400 mb-2">Difference statistics (A − B)</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Frobenius norm", value: state.frobenius?.toFixed(4) ?? "—", color: "text-gray-200", title: "||A - B||_F" },
                  { label: "Max |Δ|", value: state.largestAbsDiff?.toFixed(4) ?? "—", color: "text-amber-300", title: "Largest single-entry absolute difference" },
                  { label: "Min Δ", value: state.minDiff?.toFixed(4) ?? "—", color: "text-blue-300" },
                  { label: "Max Δ", value: state.maxDiff?.toFixed(4) ?? "—", color: "text-violet-300" },
                ].map(({ label, value, color, title }) => (
                  <div key={label} title={title} className="rounded border border-white/10 bg-white/5 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
                    <div className={`font-mono text-sm font-semibold ${color}`}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── SeedConnectivityComparisonPanel ──────────────────────────────────────────

interface SeedConnMeta {
  atlas_id?: string;
  atlas?: string;
  atlas_citation?: string;
  seed_roi_index?: number;
  seed_label?: string;
  z_min?: number;
  z_max?: number;
  z_mean?: number;
  n_volumes?: number;
  correlation_method?: string;
  nilearn_version?: string;
}

function SeedConnectivityComparisonPanel({
  runIdA,
  runIdB,
  resultsA,
  resultsB,
  labelA,
  labelB,
}: {
  runIdA: number;
  runIdB: number;
  resultsA: RunResults;
  resultsB: RunResults;
  labelA: string;
  labelB: string;
}) {
  const [metaA, setMetaA] = useState<SeedConnMeta | null>(null);
  const [metaB, setMetaB] = useState<SeedConnMeta | null>(null);

  const metaPathA = (resultsA.connectivity_metadata ?? [])[0]?.path;
  const metaPathB = (resultsB.connectivity_metadata ?? [])[0]?.path;
  const imgA = (resultsA.images ?? []).find((f) => f.name.includes("seed_connectivity_map"))?.path
    ?? (resultsA.images ?? [])[0]?.path;
  const imgB = (resultsB.images ?? []).find((f) => f.name.includes("seed_connectivity_map"))?.path
    ?? (resultsB.images ?? [])[0]?.path;

  useEffect(() => {
    if (!metaPathA) return;
    let c = false;
    fetchRunFile<SeedConnMeta>(runIdA, metaPathA).then((d) => { if (!c) setMetaA(d); }).catch(() => {});
    return () => { c = true; };
  }, [runIdA, metaPathA]);

  useEffect(() => {
    if (!metaPathB) return;
    let c = false;
    fetchRunFile<SeedConnMeta>(runIdB, metaPathB).then((d) => { if (!c) setMetaB(d); }).catch(() => {});
    return () => { c = true; };
  }, [runIdB, metaPathB]);

  // Compatibility check — use canonical atlas IDs so aliases (e.g. schaefer_100_7 vs schaefer100_7) are treated as equal
  const sameAtlas = !metaA || !metaB ||
    canonicalAtlasId(metaA.atlas_id) === canonicalAtlasId(metaB.atlas_id);
  const sameSeed = !metaA || !metaB || metaA.seed_roi_index === metaB.seed_roi_index;
  const compatible = sameAtlas && sameSeed;

  return (
    <div className="space-y-4">
      <SectionHeading>Seed connectivity map comparison</SectionHeading>

      {metaA && metaB && !compatible && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-300">
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />Incompatible runs:{" "}
          {!sameAtlas && `different atlases (${metaA.atlas_id ?? "?"} vs ${metaB.atlas_id ?? "?"})`}
          {!sameAtlas && !sameSeed && " · "}
          {!sameSeed && `different seed ROIs (#${metaA.seed_roi_index ?? "?"} vs #${metaB.seed_roi_index ?? "?"})`}.{" "}
          Voxelwise comparison is not meaningful without the same atlas and seed.
        </div>
      )}

      {metaA && metaB && compatible && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-blue-300 font-medium">
            Same atlas · Same seed
          </span>
          <span className="text-gray-500">
            Seed: {metaA.seed_label ?? `ROI #${metaA.seed_roi_index}`}
          </span>
        </div>
      )}

      {/* Side-by-side maps */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { id: runIdA, img: imgA, meta: metaA, label: labelA },
          { id: runIdB, img: imgB, meta: metaB, label: labelB },
        ].map(({ id, img, meta, label }) => (
          <div key={id} className="rounded-lg border border-white/10 bg-surface-raised p-3">
            <p className="mb-2 text-xs font-medium text-gray-300 truncate">{label}</p>
            {img ? (
              <img
                src={`/api/runs/${id}/files/${img}`}
                alt={`Seed connectivity map — ${label}`}
                className="w-full rounded border border-white/10 object-contain max-h-64"
              />
            ) : (
              <div className="rounded border border-white/10 bg-surface-overlay px-3 py-4 text-xs text-gray-500 text-center">
                Map PNG not found
              </div>
            )}
            {meta && (
              <div className="mt-2 grid grid-cols-3 gap-1">
                {[
                  ["Min z", meta.z_min?.toFixed(3)],
                  ["Max z", meta.z_max?.toFixed(3)],
                  ["Mean z", meta.z_mean?.toFixed(3)],
                ].map(([key, val]) => (
                  <div key={key} className="rounded bg-surface-overlay px-2 py-1">
                    <div className="text-[10px] text-gray-500">{key}</div>
                    <div className="text-xs font-mono font-semibold text-gray-200">{val ?? "—"}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── GroupFCComparisonPanel ─────────────────────────────────────────────────────

interface GroupFCSummaryForComp {
  n_runs?: number;
  atlas?: string;
  atlas_id?: string;
  canonical_atlas_id?: string;
  n_rois?: number;
  correlation_method?: string;
  nilearn_version?: string;
  mean_z_min?: number;
  mean_z_max?: number;
  mean_z_mean?: number;
  mean_z_std?: number;
  std_z_max?: number;
  // Fisher-z milestone fields
  fisher_z_applied?: boolean;
  aggregation_space?: string;
  confound_strategy?: string;
}

function GroupFCComparisonPanel({
  runIdA,
  runIdB,
  resultsA,
  resultsB,
  labelA,
  labelB,
}: {
  runIdA: number;
  runIdB: number;
  resultsA: RunResults;
  resultsB: RunResults;
  labelA: string;
  labelB: string;
}) {
  const summaryA = resultsA.group_summary as GroupFCSummaryForComp | null | undefined;
  const summaryB = resultsB.group_summary as GroupFCSummaryForComp | null | undefined;

  const [matA, setMatA] = useState<ConnectivityMatrixData | null>(null);
  const [matB, setMatB] = useState<ConnectivityMatrixData | null>(null);
  const [matError, setMatError] = useState<string | null>(null);

  const meanPathA = (resultsA.connectivity_matrices ?? []).find((f) => f.name.includes("mean"))?.path;
  const meanPathB = (resultsB.connectivity_matrices ?? []).find((f) => f.name.includes("mean"))?.path;
  const meanImgA = (resultsA.images ?? []).find((f) => f.name.includes("mean") && f.name.includes("heatmap"))?.path;
  const meanImgB = (resultsB.images ?? []).find((f) => f.name.includes("mean") && f.name.includes("heatmap"))?.path;

  useEffect(() => {
    if (!meanPathA) return;
    let cancelled = false;
    fetchRunTextFile(runIdA, meanPathA)
      .then((text) => { if (!cancelled) { const parsed = parseConnectivityMatrixCsv(text); setMatA(parsed); } })
      .catch((e) => { if (!cancelled) setMatError(String(e)); });
    return () => { cancelled = true; };
  }, [runIdA, meanPathA]);

  useEffect(() => {
    if (!meanPathB) return;
    let cancelled = false;
    fetchRunTextFile(runIdB, meanPathB)
      .then((text) => { if (!cancelled) { const parsed = parseConnectivityMatrixCsv(text); setMatB(parsed); } })
      .catch((e) => { if (!cancelled) setMatError(String(e)); });
    return () => { cancelled = true; };
  }, [runIdB, meanPathB]);

  const sameAtlas =
    !summaryA || !summaryB ||
    canonicalAtlasId(summaryA.atlas_id, summaryA.canonical_atlas_id) ===
    canonicalAtlasId(summaryB.atlas_id, summaryB.canonical_atlas_id);
  const sameRoiCount =
    !summaryA || !summaryB || summaryA.n_rois === summaryB.n_rois;
  const sameStrategy =
    !summaryA?.confound_strategy || !summaryB?.confound_strategy ||
    summaryA.confound_strategy === summaryB.confound_strategy;
  const sameFisherZ =
    !summaryA || !summaryB ||
    (summaryA.fisher_z_applied ?? false) === (summaryB.fisher_z_applied ?? false);
  const compatible = sameAtlas && sameRoiCount;

  // Compute Frobenius norm and max abs diff if both matrices loaded
  const diffStats = matA && matB && matA.values.length === matB.values.length
    ? (() => {
        let frobenius = 0;
        let maxAbsDiff = 0;
        for (let y = 0; y < matA.values.length; y++) {
          for (let x = 0; x < matA.values[y].length; x++) {
            const d = matA.values[y][x] - (matB.values[y]?.[x] ?? 0);
            frobenius += d * d;
            if (Math.abs(d) > maxAbsDiff) maxAbsDiff = Math.abs(d);
          }
        }
        return { frobenius: Math.sqrt(frobenius), maxAbsDiff };
      })()
    : null;

  const diffMatrix: ConnectivityMatrixData | null =
    matA && matB && matA.values.length === matB.values.length
      ? {
          labels: matA.labels,
          values: matA.values.map((row, y) =>
            row.map((v, x) => v - (matB.values[y]?.[x] ?? 0)),
          ),
        }
      : null;

  return (
    <div className="space-y-4">
      <SectionHeading>Group connectivity comparison</SectionHeading>

      {summaryA && summaryB && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {compatible ? (
            <span className="rounded-full bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-blue-300 font-medium">
              Same atlas · Same ROI count
            </span>
          ) : (
            <span className="rounded-full bg-red-500/10 border border-red-500/20 px-2 py-0.5 text-red-300 font-medium">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Incompatible:{" "}
              {!sameAtlas && `different atlases (${summaryA.atlas_id ?? "?"} vs ${summaryB.atlas_id ?? "?"})`}
              {!sameAtlas && !sameRoiCount && " · "}
              {!sameRoiCount && `different ROI counts (${summaryA.n_rois ?? "?"} vs ${summaryB.n_rois ?? "?"})`}
            </span>
          )}
          {compatible && summaryA.atlas && (
            <span className="text-gray-500">{summaryA.atlas}</span>
          )}
          {!sameStrategy && summaryA?.confound_strategy && summaryB?.confound_strategy && (
            <span className="rounded-full bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-amber-300 font-medium">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              Confound strategy mismatch: {summaryA.confound_strategy} vs {summaryB.confound_strategy}
            </span>
          )}
          {!sameFisherZ && (
            <span className="rounded-full bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-amber-300 font-medium">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              Aggregation method mismatch: one run uses Fisher r-to-z, the other uses legacy raw r. Difference values are not meaningful.
            </span>
          )}
        </div>
      )}

      {/* Summary stats table */}
      {summaryA && summaryB && (
        <div className="rounded-lg border border-white/10 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-white/5 border-b border-white/10">
                <th className="px-3 py-2 text-gray-400">Metric</th>
                <th className="px-3 py-2 text-gray-400">{labelA}</th>
                <th className="px-3 py-2 text-gray-400">{labelB}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {[
                ["Runs aggregated", summaryA.n_runs, summaryB.n_runs],
                ["Atlas", summaryA.atlas_id, summaryB.atlas_id],
                ["ROI count", summaryA.n_rois, summaryB.n_rois],
                ["Mean z min", summaryA.mean_z_min?.toFixed(4), summaryB.mean_z_min?.toFixed(4)],
                ["Mean z max", summaryA.mean_z_max?.toFixed(4), summaryB.mean_z_max?.toFixed(4)],
                ["Mean z avg", summaryA.mean_z_mean?.toFixed(4), summaryB.mean_z_mean?.toFixed(4)],
                ["Max std", summaryA.std_z_max?.toFixed(4), summaryB.std_z_max?.toFixed(4)],
              ].map(([label, vA, vB]) => {
                const differs = String(vA) !== String(vB);
                return (
                  <tr key={label as string} className={differs ? "bg-amber-500/5" : ""}>
                    <td className="px-3 py-2 text-gray-400">{label}</td>
                    <td className={`px-3 py-2 font-mono ${differs ? "text-amber-300 font-semibold" : "text-gray-200"}`}>{String(vA ?? "—")}</td>
                    <td className={`px-3 py-2 font-mono ${differs ? "text-amber-300 font-semibold" : "text-gray-200"}`}>{String(vB ?? "—")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Difference statistics */}
      {diffStats && compatible && (
        <div className="grid grid-cols-2 gap-3">
          {[
            ["Frobenius norm", diffStats.frobenius.toFixed(4)],
            ["Largest |diff|", diffStats.maxAbsDiff.toFixed(4)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-white/10 bg-surface-raised px-3 py-2">
              <div className="text-xs text-gray-500">{label}</div>
              <div className="font-mono text-sm font-semibold text-gray-200">{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Difference heatmap */}
      {diffMatrix && compatible && (
        <div>
          <p className="mb-2 text-xs font-medium text-gray-400">Difference matrix (A − B)</p>
          <MatrixHeatmap matrix={diffMatrix} mode="diff" />
        </div>
      )}

      {matError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-300">
          Could not load mean matrices: {matError}
        </div>
      )}

      {/* Side-by-side mean heatmap PNGs */}
      {(meanImgA || meanImgB) && (
        <div className="grid grid-cols-2 gap-3">
          {[
            { id: runIdA, img: meanImgA, label: labelA },
            { id: runIdB, img: meanImgB, label: labelB },
          ].map(({ id, img, label }) => (
            <div key={id} className="rounded-lg border border-white/10 bg-surface-raised p-3">
              <p className="mb-2 text-xs font-medium text-gray-300 truncate">{label} — mean</p>
              {img ? (
                <img
                  src={`/api/runs/${id}/files/${img}`}
                  alt={`Group mean connectivity — ${label}`}
                  className="w-full rounded border border-white/10 object-contain max-h-64"
                />
              ) : (
                <div className="rounded border border-white/10 bg-surface-overlay px-3 py-4 text-xs text-gray-500 text-center">
                  Heatmap not found
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── NiftiInspectorComparisonPanel ─────────────────────────────────────────────

interface NiftiInspResult {
  header?: {
    dimensions?: number[];
    n_volumes?: number;
    voxel_spacing_mm?: number[];
    tr_seconds?: number | null;
    datatype?: string;
    bitpix?: number;
    endianness?: string;
    orientation?: string;
    qform_code?: number;
    sform_code?: number;
    header_version?: string;
    voxel_count?: number;
  };
  stats?: {
    min?: number | null;
    max?: number | null;
    mean?: number | null;
    std?: number | null;
    dynamic_range?: number | null;
    nonzero_pct?: number;
    nan_count?: number;
  };
  warnings?: Array<{ code: string; severity: string; message: string }>;
  provenance?: { nibabel_version?: string; header_hash?: string };
  input_file?: string;
}

function NiftiInspectorComparisonPanel({
  runIdA,
  runIdB,
  labelA,
  labelB,
}: {
  runIdA: number;
  runIdB: number;
  labelA: string;
  labelB: string;
}) {
  const [inspA, setInspA] = useState<NiftiInspResult | null>(null);
  const [inspB, setInspB] = useState<NiftiInspResult | null>(null);
  const [errA, setErrA] = useState<string | null>(null);
  const [errB, setErrB] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${runIdA}/files/nifti_inspector.json`)
      .then((r) => r.json())
      .then((d: NiftiInspResult) => { if (!cancelled) setInspA(d); })
      .catch((e) => { if (!cancelled) setErrA(String(e)); });
    return () => { cancelled = true; };
  }, [runIdA]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${runIdB}/files/nifti_inspector.json`)
      .then((r) => r.json())
      .then((d: NiftiInspResult) => { if (!cancelled) setInspB(d); })
      .catch((e) => { if (!cancelled) setErrB(String(e)); });
    return () => { cancelled = true; };
  }, [runIdB]);

  if (errA || errB) return (
    <div className="rounded border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
      Could not load inspection results: {errA ?? errB}
    </div>
  );

  const fmt = (v: number | null | undefined, dec = 3) =>
    v == null ? "—" : Number.isFinite(v) ? v.toFixed(dec) : String(v);

  const hA = inspA?.header;
  const hB = inspB?.header;
  const sA = inspA?.stats;
  const sB = inspB?.stats;

  // Compatibility checks
  const sameDims = hA && hB && JSON.stringify(hA.dimensions) === JSON.stringify(hB.dimensions);
  const sameSpacing = hA && hB && hA.voxel_spacing_mm && hB.voxel_spacing_mm &&
    hA.voxel_spacing_mm.every((v, i) => Math.abs(v - (hB.voxel_spacing_mm![i] ?? 0)) < 0.001);
  const sameDatatype = hA && hB && hA.datatype === hB.datatype;
  const sameOrientation = hA && hB && hA.orientation === hB.orientation;

  function badge(ok: boolean | undefined, label: string) {
    if (ok == null) return null;
    return (
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium border ${
        ok ? "bg-blue-500/10 border-blue-500/20 text-blue-300"
           : "bg-amber-500/10 border-amber-500/20 text-amber-300"
      }`}>
        {ok ? "✓" : "≠"} {label}
      </span>
    );
  }

  const rows: Array<{ label: string; a: string; b: string; match?: boolean }> = [];
  if (hA || hB) {
    rows.push(
      { label: "Dimensions", a: hA?.dimensions?.join(" × ") ?? "—", b: hB?.dimensions?.join(" × ") ?? "—", match: sameDims ?? undefined },
      { label: "Volumes", a: String(hA?.n_volumes ?? "—"), b: String(hB?.n_volumes ?? "—") },
      { label: "Voxel spacing (mm)", a: hA?.voxel_spacing_mm?.map((v) => v.toFixed(2)).join(" × ") ?? "—", b: hB?.voxel_spacing_mm?.map((v) => v.toFixed(2)).join(" × ") ?? "—", match: sameSpacing ?? undefined },
      { label: "TR (s)", a: hA?.tr_seconds != null ? hA.tr_seconds.toFixed(3) : "—", b: hB?.tr_seconds != null ? hB.tr_seconds.toFixed(3) : "—" },
      { label: "Datatype", a: `${hA?.datatype ?? "—"} (${hA?.bitpix ?? "?"}bit)`, b: `${hB?.datatype ?? "—"} (${hB?.bitpix ?? "?"}bit)`, match: sameDatatype ?? undefined },
      { label: "Orientation", a: hA?.orientation ?? "—", b: hB?.orientation ?? "—", match: sameOrientation ?? undefined },
      { label: "NIfTI version", a: hA?.header_version ?? "—", b: hB?.header_version ?? "—" },
    );
  }
  if (sA || sB) {
    rows.push(
      { label: "Min", a: fmt(sA?.min), b: fmt(sB?.min) },
      { label: "Max", a: fmt(sA?.max), b: fmt(sB?.max) },
      { label: "Mean", a: fmt(sA?.mean), b: fmt(sB?.mean) },
      { label: "Std dev", a: fmt(sA?.std), b: fmt(sB?.std) },
      { label: "Dynamic range", a: fmt(sA?.dynamic_range), b: fmt(sB?.dynamic_range) },
      { label: "Non-zero %", a: sA?.nonzero_pct != null ? `${sA.nonzero_pct.toFixed(1)}%` : "—", b: sB?.nonzero_pct != null ? `${sB.nonzero_pct.toFixed(1)}%` : "—" },
      { label: "NaN count", a: String(sA?.nan_count ?? "—"), b: String(sB?.nan_count ?? "—") },
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeading>NIfTI Inspector comparison</SectionHeading>

      {/* Compatibility badges */}
      <div className="flex flex-wrap items-center gap-2">
        {badge(sameDims, "Dimensions")}
        {badge(sameSpacing, "Voxel spacing")}
        {badge(sameDatatype, "Datatype")}
        {badge(sameOrientation, "Orientation")}
        {(!inspA || !inspB) && (
          <span className="text-xs text-gray-500 animate-pulse">Loading…</span>
        )}
      </div>

      {/* Warnings summary */}
      {(inspA?.warnings?.length ?? 0) + (inspB?.warnings?.length ?? 0) > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {[{ insp: inspA, label: labelA }, { insp: inspB, label: labelB }].map(({ insp, label }) => (
            insp?.warnings && insp.warnings.length > 0 ? (
              <div key={label} className="rounded border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <p className="font-semibold mb-1">{label}: {insp.warnings.length} warning{insp.warnings.length !== 1 ? "s" : ""}</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {insp.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
                </ul>
              </div>
            ) : null
          ))}
        </div>
      )}

      {/* Side-by-side table */}
      {rows.length > 0 && (
        <div className="rounded-lg border border-white/10 overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-white/5 border-b border-white/10">
                <th className="px-3 py-2 text-xs font-medium text-gray-400">Property</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-400">{labelA}</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-400">{labelB}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map(({ label, a, b, match }) => (
                <tr key={label} className={match === false ? "bg-amber-500/5" : ""}>
                  <td className="px-3 py-2 text-xs text-gray-400 font-medium">{label}</td>
                  <td className={`px-3 py-2 text-xs font-mono ${match === false ? "text-amber-300" : "text-gray-300"}`}>{a}</td>
                  <td className={`px-3 py-2 text-xs font-mono ${match === false ? "text-amber-300" : "text-gray-300"}`}>{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Histogram side by side */}
      <div className="grid grid-cols-2 gap-3">
        {[{ id: runIdA, label: labelA }, { id: runIdB, label: labelB }].map(({ id, label }) => (
          <div key={id}>
            <p className="mb-1 text-xs font-medium text-gray-400">{label}: Histogram</p>
            <img
              src={`/api/runs/${id}/files/nifti_histogram.png`}
              alt={`${label} histogram`}
              className="w-full rounded border border-white/10 object-contain max-h-48"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── GraphAnalysisComparisonPanel ──────────────────────────────────────────────

interface GraphGlobalMetrics {
  n_nodes: number;
  n_edges: number;
  density: number;
  global_efficiency: number;
  local_efficiency: number;
  clustering_coefficient: number;
  transitivity: number;
  characteristic_path_length: number | null;
  mean_betweenness_centrality: number;
  modularity: number;
  n_communities: number;
  n_connected_components: number;
  largest_component_size: number;
  threshold_method: string;
  threshold_value: number | null;
}

interface GraphNodeRow {
  label: string;
  strength: number;
  degree: number;
  betweenness: number;
  participation_coefficient: number;
  community: number;
}

function parseGraphNodeCsv(text: string): GraphNodeRow[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const get = (k: string) => {
      const i = headers.indexOf(k);
      return i >= 0 ? cols[i]?.trim() ?? "" : "";
    };
    return {
      label: get("label") || get("node"),
      strength: parseFloat(get("strength")) || 0,
      degree: parseInt(get("degree"), 10) || 0,
      betweenness: parseFloat(get("betweenness")) || 0,
      participation_coefficient: parseFloat(get("participation_coefficient")) || 0,
      community: parseInt(get("community"), 10) || 0,
    };
  });
}

function GraphAnalysisComparisonPanel({
  runIdA,
  runIdB,
  labelA,
  labelB,
}: {
  runIdA: number;
  runIdB: number;
  labelA: string;
  labelB: string;
}) {
  const [metricsA, setMetricsA] = useState<GraphGlobalMetrics | null>(null);
  const [metricsB, setMetricsB] = useState<GraphGlobalMetrics | null>(null);
  const [nodesA, setNodesA] = useState<GraphNodeRow[]>([]);
  const [nodesB, setNodesB] = useState<GraphNodeRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/runs/${runIdA}/files/graph_metrics.json`).then((r) => r.json()),
      fetch(`/api/runs/${runIdB}/files/graph_metrics.json`).then((r) => r.json()),
      fetch(`/api/runs/${runIdA}/files/node_metrics.csv`).then((r) => r.text()),
      fetch(`/api/runs/${runIdB}/files/node_metrics.csv`).then((r) => r.text()),
    ])
      .then(([mA, mB, csvA, csvB]) => {
        if (cancelled) return;
        setMetricsA(mA as GraphGlobalMetrics);
        setMetricsB(mB as GraphGlobalMetrics);
        setNodesA(parseGraphNodeCsv(csvA));
        setNodesB(parseGraphNodeCsv(csvB));
        setLoading(false);
      })
      .catch((e) => { if (!cancelled) { setErr(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [runIdA, runIdB]);

  if (err) return (
    <div className="rounded border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
      Could not load graph analysis results: {err}
    </div>
  );
  if (loading) return (
    <div className="text-xs text-gray-500 animate-pulse py-4">Loading graph metrics…</div>
  );
  if (!metricsA || !metricsB) return null;

  const fmt = (v: number | null | undefined, dec = 3) =>
    v == null ? "—" : v.toFixed(dec);

  const delta = (a: number | null | undefined, b: number | null | undefined) => {
    if (a == null || b == null) return null;
    return b - a;
  };

  const deltaStr = (a: number | null | undefined, b: number | null | undefined, dec = 3) => {
    const d = delta(a, b);
    if (d == null) return "—";
    const sign = d > 0 ? "+" : "";
    return `${sign}${d.toFixed(dec)}`;
  };

  const deltaColor = (a: number | null | undefined, b: number | null | undefined) => {
    const d = delta(a, b);
    if (d == null || Math.abs(d) < 1e-6) return "text-gray-400";
    return d > 0 ? "text-emerald-400" : "text-rose-400";
  };

  const rows: { label: string; a: string; b: string; diff: string; diffColor: string }[] = [
    {
      label: "Nodes",
      a: String(metricsA.n_nodes),
      b: String(metricsB.n_nodes),
      diff: deltaStr(metricsA.n_nodes, metricsB.n_nodes, 0),
      diffColor: deltaColor(metricsA.n_nodes, metricsB.n_nodes),
    },
    {
      label: "Edges",
      a: String(metricsA.n_edges),
      b: String(metricsB.n_edges),
      diff: deltaStr(metricsA.n_edges, metricsB.n_edges, 0),
      diffColor: deltaColor(metricsA.n_edges, metricsB.n_edges),
    },
    {
      label: "Density",
      a: fmt(metricsA.density),
      b: fmt(metricsB.density),
      diff: deltaStr(metricsA.density, metricsB.density),
      diffColor: deltaColor(metricsA.density, metricsB.density),
    },
    {
      label: "Global Efficiency",
      a: fmt(metricsA.global_efficiency),
      b: fmt(metricsB.global_efficiency),
      diff: deltaStr(metricsA.global_efficiency, metricsB.global_efficiency),
      diffColor: deltaColor(metricsA.global_efficiency, metricsB.global_efficiency),
    },
    {
      label: "Local Efficiency",
      a: fmt(metricsA.local_efficiency),
      b: fmt(metricsB.local_efficiency),
      diff: deltaStr(metricsA.local_efficiency, metricsB.local_efficiency),
      diffColor: deltaColor(metricsA.local_efficiency, metricsB.local_efficiency),
    },
    {
      label: "Clustering Coeff.",
      a: fmt(metricsA.clustering_coefficient),
      b: fmt(metricsB.clustering_coefficient),
      diff: deltaStr(metricsA.clustering_coefficient, metricsB.clustering_coefficient),
      diffColor: deltaColor(metricsA.clustering_coefficient, metricsB.clustering_coefficient),
    },
    {
      label: "Transitivity",
      a: fmt(metricsA.transitivity),
      b: fmt(metricsB.transitivity),
      diff: deltaStr(metricsA.transitivity, metricsB.transitivity),
      diffColor: deltaColor(metricsA.transitivity, metricsB.transitivity),
    },
    {
      label: "Char. Path Length",
      a: fmt(metricsA.characteristic_path_length),
      b: fmt(metricsB.characteristic_path_length),
      diff: deltaStr(metricsA.characteristic_path_length, metricsB.characteristic_path_length),
      diffColor: deltaColor(metricsA.characteristic_path_length, metricsB.characteristic_path_length),
    },
    {
      label: "Betweenness (mean)",
      a: fmt(metricsA.mean_betweenness_centrality),
      b: fmt(metricsB.mean_betweenness_centrality),
      diff: deltaStr(metricsA.mean_betweenness_centrality, metricsB.mean_betweenness_centrality),
      diffColor: deltaColor(metricsA.mean_betweenness_centrality, metricsB.mean_betweenness_centrality),
    },
    {
      label: "Modularity (Q)",
      a: fmt(metricsA.modularity),
      b: fmt(metricsB.modularity),
      diff: deltaStr(metricsA.modularity, metricsB.modularity),
      diffColor: deltaColor(metricsA.modularity, metricsB.modularity),
    },
    {
      label: "Communities",
      a: String(metricsA.n_communities),
      b: String(metricsB.n_communities),
      diff: deltaStr(metricsA.n_communities, metricsB.n_communities, 0),
      diffColor: deltaColor(metricsA.n_communities, metricsB.n_communities),
    },
  ];

  // Top 10 hubs by strength in each run
  const hubsA = [...nodesA].sort((x, y) => y.strength - x.strength).slice(0, 10);
  const hubsB = [...nodesB].sort((x, y) => y.strength - x.strength).slice(0, 10);

  const hubSetA = new Set(hubsA.map((n) => n.label));
  const hubSetB = new Set(hubsB.map((n) => n.label));
  const sharedHubs = hubsA.filter((n) => hubSetB.has(n.label));

  const diffThreshold = metricsA.threshold_method !== metricsB.threshold_method ||
    (metricsA.threshold_value ?? 0) !== (metricsB.threshold_value ?? 0);

  return (
    <div className="space-y-6">
      {diffThreshold && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Warning: runs used different thresholding ({metricsA.threshold_method} {metricsA.threshold_value} vs {metricsB.threshold_method} {metricsB.threshold_value}). Metric differences may reflect threshold choice rather than biology.
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wide mb-3">Global Graph Metrics</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/10 text-gray-500">
                <th className="text-left py-1 pr-4 font-medium">Metric</th>
                <th className="text-right py-1 px-3 font-medium">{labelA}</th>
                <th className="text-right py-1 px-3 font-medium">{labelB}</th>
                <th className="text-right py-1 pl-3 font-medium">Δ (B − A)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-1 pr-4 text-gray-400">{r.label}</td>
                  <td className="py-1 px-3 text-right font-mono text-blue-300">{r.a}</td>
                  <td className="py-1 px-3 text-right font-mono text-violet-300">{r.b}</td>
                  <td className={`py-1 pl-3 text-right font-mono ${r.diffColor}`}>{r.diff}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wide mb-3">
          Hub Nodes — Top 10 by Strength
          {sharedHubs.length > 0 && (
            <span className="ml-2 font-normal text-gray-500 normal-case">
              ({sharedHubs.length} shared)
            </span>
          )}
        </h4>
        <div className="grid grid-cols-2 gap-4">
          {([["A", hubsA, labelA, "text-blue-300", hubSetB], ["B", hubsB, labelB, "text-violet-300", hubSetA]] as const).map(
            ([key, hubs, label, cls, otherSet]) => (
              <div key={key}>
                <p className={`text-xs font-medium mb-2 ${cls}`}>{label}</p>
                <ol className="space-y-0.5">
                  {hubs.map((n, i) => (
                    <li key={n.label} className="flex items-center gap-2 text-xs">
                      <span className="text-gray-600 w-4 text-right">{i + 1}.</span>
                      <span className={`flex-1 truncate ${otherSet.has(n.label) ? "text-emerald-400" : "text-gray-300"}`}>
                        {n.label}
                      </span>
                      <span className="font-mono text-gray-500">{n.strength.toFixed(3)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )
          )}
        </div>
        {sharedHubs.length > 0 && (
          <p className="text-xs text-gray-600 mt-2">
            Green = node appears in both top-10 hub lists.
          </p>
        )}
      </div>

      {nodesA.length > 0 && nodesB.length > 0 && (() => {
        const mapA = new Map(nodesA.map((n) => [n.label, n]));
        const mapB = new Map(nodesB.map((n) => [n.label, n]));
        const shared = [...mapA.keys()].filter((k) => mapB.has(k));
        if (shared.length === 0) return null;
        const strengthDiffs = shared
          .map((k) => ({ label: k, diff: (mapB.get(k)!.strength - mapA.get(k)!.strength) }))
          .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
          .slice(0, 10);
        return (
          <div>
            <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wide mb-3">
              Largest Strength Differences (B − A, top 10)
            </h4>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/10 text-gray-500">
                  <th className="text-left py-1 pr-4 font-medium">Node</th>
                  <th className="text-right py-1 pr-4 font-medium">{labelA}</th>
                  <th className="text-right py-1 pr-4 font-medium">{labelB}</th>
                  <th className="text-right py-1 font-medium">Δ</th>
                </tr>
              </thead>
              <tbody>
                {strengthDiffs.map(({ label, diff }) => {
                  const a = mapA.get(label)!;
                  const b = mapB.get(label)!;
                  return (
                    <tr key={label} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-1 pr-4 text-gray-300 truncate max-w-[120px]">{label}</td>
                      <td className="py-1 pr-4 text-right font-mono text-blue-300">{a.strength.toFixed(3)}</td>
                      <td className="py-1 pr-4 text-right font-mono text-violet-300">{b.strength.toFixed(3)}</td>
                      <td className={`py-1 text-right font-mono ${diff > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {diff > 0 ? "+" : ""}{diff.toFixed(3)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })()}
    </div>
  );
}

// ── RoiExtractionComparisonPanel ──────────────────────────────────────────────

interface RoiRow {
  roi_number: number;
  roi_label: string;
  mean: number | null;
  std: number | null;
  voxel_count: number;
  coverage_pct: number | null;
}

interface RoiMeta {
  atlas_id?: string;
  atlas_display_name?: string;
  n_rois?: number;
  aggregation_mode?: string;
  resampling_performed?: boolean;
  nilearn_version?: string;
  nibabel_version?: string;
  numpy_version?: string;
}

function RoiExtractionComparisonPanel({
  runIdA,
  runIdB,
  labelA,
  labelB,
}: {
  runIdA: number;
  runIdB: number;
  labelA: string;
  labelB: string;
}) {
  const [rowsA, setRowsA] = useState<RoiRow[]>([]);
  const [rowsB, setRowsB] = useState<RoiRow[]>([]);
  const [metaA, setMetaA] = useState<RoiMeta | null>(null);
  const [metaB, setMetaB] = useState<RoiMeta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/runs/${runIdA}/files/roi_extraction.json`).then((r) => r.json()),
      fetch(`/api/runs/${runIdB}/files/roi_extraction.json`).then((r) => r.json()),
      fetch(`/api/runs/${runIdA}/files/roi_extraction_metadata.json`).then((r) => r.json()),
      fetch(`/api/runs/${runIdB}/files/roi_extraction_metadata.json`).then((r) => r.json()),
    ])
      .then(([dA, dB, mA, mB]) => {
        if (cancelled) return;
        setRowsA(Array.isArray(dA) ? dA : []);
        setRowsB(Array.isArray(dB) ? dB : []);
        setMetaA(mA as RoiMeta);
        setMetaB(mB as RoiMeta);
        setLoading(false);
      })
      .catch((e) => { if (!cancelled) { setErr(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [runIdA, runIdB]);

  if (err) return (
    <div className="rounded border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
      Could not load ROI extraction results: {err}
    </div>
  );
  if (loading) return (
    <div className="text-xs text-gray-500 animate-pulse py-4">Loading ROI data…</div>
  );

  const sameAtlas = metaA?.atlas_id && metaB?.atlas_id &&
    canonicalAtlasId(metaA.atlas_id) === canonicalAtlasId(metaB.atlas_id);
  const sameNRois = metaA?.n_rois && metaB?.n_rois && metaA.n_rois === metaB.n_rois;
  const compatible = sameAtlas && sameNRois;

  // Build per-ROI diff table (join by roi_number)
  const mapA = new Map(rowsA.map((r) => [r.roi_number, r]));
  const mapB = new Map(rowsB.map((r) => [r.roi_number, r]));
  const allNums = [...new Set([...mapA.keys(), ...mapB.keys()])].sort((a, b) => a - b);

  interface DiffRow {
    roi_number: number;
    roi_label: string;
    meanA: number | null;
    meanB: number | null;
    diff: number | null;
    absDiff: number;
  }

  const diffs: DiffRow[] = allNums.map((n) => {
    const a = mapA.get(n);
    const b = mapB.get(n);
    const meanA = a?.mean ?? null;
    const meanB = b?.mean ?? null;
    const diff = meanA != null && meanB != null ? meanB - meanA : null;
    return {
      roi_number: n,
      roi_label: a?.roi_label ?? b?.roi_label ?? `ROI ${n}`,
      meanA,
      meanB,
      diff,
      absDiff: diff != null ? Math.abs(diff) : 0,
    };
  }).sort((a, b) => b.absDiff - a.absDiff);

  // Correlation of means
  const paired = diffs.filter((d) => d.meanA != null && d.meanB != null);
  let correlation: number | null = null;
  if (paired.length >= 3) {
    const xs = paired.map((d) => d.meanA as number);
    const ys = paired.map((d) => d.meanB as number);
    const xm = xs.reduce((s, v) => s + v, 0) / xs.length;
    const ym = ys.reduce((s, v) => s + v, 0) / ys.length;
    const num = xs.reduce((s, v, i) => s + (v - xm) * (ys[i] - ym), 0);
    const den = Math.sqrt(
      xs.reduce((s, v) => s + (v - xm) ** 2, 0) *
      ys.reduce((s, v) => s + (v - ym) ** 2, 0),
    );
    correlation = den === 0 ? null : num / den;
  }

  // SVG scatter plot
  const W = 260, H = 200, PAD = 32;
  let scatterSvg: React.ReactNode = null;
  if (paired.length >= 2) {
    const xs = paired.map((d) => d.meanA as number);
    const ys = paired.map((d) => d.meanB as number);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = Math.min(...ys), yMax = Math.max(...ys);
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;
    const px = (v: number) => PAD + ((v - xMin) / xRange) * (W - 2 * PAD);
    const py = (v: number) => H - PAD - ((v - yMin) / yRange) * (H - 2 * PAD);
    // Identity line
    const xyMin = Math.min(xMin, yMin), xyMax = Math.max(xMax, yMax);
    const lx1 = px(Math.max(xMin, xyMin)), ly1 = py(Math.max(yMin, xyMin));
    const lx2 = px(Math.min(xMax, xyMax)), ly2 = py(Math.min(yMax, xyMax));

    scatterSvg = (
      <svg width={W} height={H} className="overflow-visible" aria-label="ROI mean scatter plot">
        {/* Axes */}
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
        {/* Identity line */}
        <line x1={lx1} y1={ly1} x2={lx2} y2={ly2} stroke="rgba(255,255,255,0.15)" strokeWidth={1} strokeDasharray="3,3" />
        {/* Points */}
        {paired.map((d, i) => (
          <circle key={i} cx={px(d.meanA as number)} cy={py(d.meanB as number)} r={2.5} fill="#a78bfa" fillOpacity={0.7} />
        ))}
        {/* Axis labels */}
        <text x={W / 2} y={H - 4} fill="rgba(156,163,175,0.8)" fontSize={9} textAnchor="middle">{labelA} mean</text>
        <text x={6} y={H / 2} fill="rgba(156,163,175,0.8)" fontSize={9} textAnchor="middle" transform={`rotate(-90, 6, ${H / 2})`}>{labelB} mean</text>
      </svg>
    );
  }

  const fmt = (v: number | null, dec = 4) =>
    v == null ? "—" : Number.isFinite(v) ? v.toFixed(dec) : String(v);

  return (
    <div className="space-y-4">
      <SectionHeading>Atlas ROI Extraction comparison</SectionHeading>

      {/* Compatibility badges */}
      <div className="flex flex-wrap items-center gap-2">
        {[
          { ok: sameAtlas, label: `Atlas: ${metaA?.atlas_display_name ?? metaA?.atlas_id ?? "—"}` },
          { ok: sameNRois, label: `ROIs: ${metaA?.n_rois ?? "—"} vs ${metaB?.n_rois ?? "—"}` },
        ].map(({ ok, label }) => (
          <span key={label} className={`rounded-full px-2 py-0.5 text-xs font-medium border ${
            ok ? "bg-blue-500/10 border-blue-500/20 text-blue-300"
               : "bg-amber-500/10 border-amber-500/20 text-amber-300"
          }`}>
            {ok ? "✓" : "≠"} {label}
          </span>
        ))}
        {!compatible && (
          <span className="text-xs text-amber-400">Different atlases or ROI counts — per-region comparison may be misleading.</span>
        )}
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div className="rounded border border-white/10 bg-surface-overlay px-3 py-2">
          <p className="text-gray-500 mb-0.5">ROIs compared</p>
          <p className="text-gray-100 font-mono">{paired.length} / {diffs.length}</p>
        </div>
        <div className="rounded border border-white/10 bg-surface-overlay px-3 py-2">
          <p className="text-gray-500 mb-0.5">Pearson r (means)</p>
          <p className="text-gray-100 font-mono">{correlation != null ? correlation.toFixed(4) : "—"}</p>
        </div>
        <div className="rounded border border-white/10 bg-surface-overlay px-3 py-2">
          <p className="text-gray-500 mb-0.5">Max |Δmean|</p>
          <p className="text-gray-100 font-mono">{diffs.length > 0 && diffs[0].absDiff > 0 ? diffs[0].absDiff.toFixed(4) : "—"}</p>
        </div>
      </div>

      {/* Scatter + top diffs */}
      <div className="grid grid-cols-2 gap-4">
        {scatterSvg && (
          <div>
            <p className="text-xs text-gray-500 mb-1">ROI mean scatter (A vs B)</p>
            <div className="rounded border border-white/10 bg-surface-overlay p-2 flex justify-center">
              {scatterSvg}
            </div>
          </div>
        )}
        <div>
          <p className="text-xs text-gray-500 mb-1">Top regions by |Δmean| (B − A)</p>
          <div className="rounded-lg border border-white/10 overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-white/5 border-b border-white/10">
                  <th className="px-2 py-1.5 text-xs font-medium text-gray-400">Region</th>
                  <th className="px-2 py-1.5 text-xs font-medium text-gray-400 text-right">{labelA}</th>
                  <th className="px-2 py-1.5 text-xs font-medium text-gray-400 text-right">{labelB}</th>
                  <th className="px-2 py-1.5 text-xs font-medium text-gray-400 text-right">Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {diffs.slice(0, 15).map((d) => (
                  <tr key={d.roi_number}>
                    <td className="px-2 py-1 text-xs text-gray-300 truncate max-w-[120px]" title={d.roi_label}>{d.roi_label}</td>
                    <td className="px-2 py-1 text-xs font-mono text-gray-400 text-right">{fmt(d.meanA)}</td>
                    <td className="px-2 py-1 text-xs font-mono text-gray-400 text-right">{fmt(d.meanB)}</td>
                    <td className={`px-2 py-1 text-xs font-mono text-right ${
                      d.diff == null ? "text-gray-600" : d.diff > 0 ? "text-green-400" : "text-red-400"
                    }`}>
                      {d.diff != null ? (d.diff > 0 ? "+" : "") + fmt(d.diff) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Provenance */}
      {(metaA?.nilearn_version || metaB?.nilearn_version) && (
        <p className="text-xs text-gray-600">
          Software: nilearn {metaA?.nilearn_version ?? "?"} · nibabel {metaA?.nibabel_version ?? "?"}
        </p>
      )}
    </div>
  );
}

// ── ArtifactComparison ────────────────────────────────────────────────────────

function ArtifactComparison({ resultsA, resultsB, labelA, labelB, runIdA, runIdB }: {
  resultsA: RunResults;
  resultsB: RunResults;
  labelA: string;
  labelB: string;
  runIdA: number;
  runIdB: number;
}) {
  const niftisA = resultsA.niftis ?? [];
  const niftisB = resultsB.niftis ?? [];
  const allNames = [...new Set([...niftisA.map((f) => f.name), ...niftisB.map((f) => f.name)])].sort();

  return (
    <div>
      <SectionHeading>Output files</SectionHeading>
      {allNames.length > 0 && (
        <div className="rounded-lg border border-white/10 overflow-hidden mb-3">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-white/5 border-b border-white/10">
                <th className="px-3 py-2 text-xs font-medium text-gray-400">File</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-400">{labelA}</th>
                <th className="px-3 py-2 text-xs font-medium text-gray-400">{labelB}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {allNames.map((name) => {
                const fA = niftisA.find((f) => f.name === name);
                const fB = niftisB.find((f) => f.name === name);
                return (
                  <tr key={name}>
                    <td className="px-3 py-2 text-xs text-gray-300 font-mono">{name}</td>
                    <td className="px-3 py-2 text-xs text-gray-400">
                      {fA ? (
                        <a href={`/api/runs/${runIdA}/files/${fA.path}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                          ↗ view
                        </a>
                      ) : <span className="text-red-400">missing</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-400">
                      {fB ? (
                        <a href={`/api/runs/${runIdB}/files/${fB.path}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                          ↗ view
                        </a>
                      ) : <span className="text-red-400">missing</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-lg border border-white/10 overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-white/5 border-b border-white/10">
              <th className="px-3 py-2 text-xs font-medium text-gray-400">Artifact type</th>
              <th className="px-3 py-2 text-xs font-medium text-gray-400">{labelA}</th>
              <th className="px-3 py-2 text-xs font-medium text-gray-400">{labelB}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {[...new Set([
              ...resultsA.artifacts.map((a) => a.type),
              ...resultsB.artifacts.map((a) => a.type),
            ])].sort().map((type) => {
              const aArt = resultsA.artifacts.find((a) => a.type === type);
              const bArt = resultsB.artifacts.find((a) => a.type === type);
              return (
                <tr key={type}>
                  <td className="px-3 py-2 text-xs text-gray-300 font-mono">{type}</td>
                  <td className="px-3 py-2 text-xs">
                    {aArt ? (
                      <span className={aArt.resolved ? "text-green-400" : "text-gray-500"}>
                        {aArt.resolved ? "✓ resolved" : "not resolved"}
                      </span>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {bArt ? (
                      <span className={bArt.resolved ? "text-green-400" : "text-gray-500"}>
                        {bArt.resolved ? "✓ resolved" : "not resolved"}
                      </span>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Viewer layer builders ─────────────────────────────────────────────────────

function buildLayers(results: RunResults, runId: number): NiivueLayer[] {
  const niftis = results.niftis ?? [];
  const base = niftis.find((f) => f.name === "stripped.nii.gz") ?? niftis[0];
  const mask = niftis.find((f) => f.name === "brain_mask.nii.gz");
  const url = (f: { path: string }) => `/api/runs/${runId}/files/${f.path}`;
  if (!base) return [];
  const layers: NiivueLayer[] = [{ url: url(base), name: base.name }];
  if (mask) layers.push({ url: url(mask), name: mask.name, colormap: "hot", opacity: 0.4 });
  return layers;
}

function buildMaskLayers(results: RunResults, runId: number, colormap: string): NiivueLayer[] {
  const niftis = results.niftis ?? [];
  const mask = niftis.find((f) => f.name === "brain_mask.nii.gz");
  const url = (f: { path: string }) => `/api/runs/${runId}/files/${f.path}`;
  if (!mask) return [];
  return [{ url: url(mask), name: mask.name, colormap, opacity: 1.0 }];
}

function getMaskUrl(results: RunResults, runId: number): string | null {
  const mask = (results.niftis ?? []).find((f) => f.name === "brain_mask.nii.gz");
  return mask ? `/api/runs/${runId}/files/${mask.path}` : null;
}

// ── Run selector with eligibility grouping ────────────────────────────────────

function RunSelector({
  label,
  value,
  options,
  referenceRun,
  onChange,
}: {
  label: string;
  value: number | null;
  options: RunOption[];
  referenceRun?: RunSummary | null;
  onChange: (id: number | null) => void;
}) {
  const grouped = referenceRun
    ? sortByEligibility(referenceRun, options.map((o) => ({ run: o.run, producedTypes: o.producedTypes })))
    : null;

  const verifiedGroup = grouped?.filter((o) => o.eligibility.tier === "verified") ?? [];
  const unverifiedGroup = grouped?.filter((o) => o.eligibility.tier === "unverified") ?? [];

  const renderOption = (run: RunSummary, tier?: "verified" | "unverified") => {
    const prefix = tier === "verified" ? "✓ " : tier === "unverified" ? "~ " : "";
    return (
      <option key={run.id} value={run.id}>
        {prefix}Run #{run.id} — {run.pipeline_manifest_id} v{run.pipeline_version}
      </option>
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400 font-medium">{label}</label>
      <select
        aria-label={label}
        className="rounded border border-white/20 bg-surface-raised text-sm text-gray-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">— select a run —</option>
        {grouped ? (
          <>
            {verifiedGroup.length > 0 && (
              <optgroup label="✓ Verified comparable (same source)">
                {verifiedGroup.map((o) => renderOption(o.run, "verified"))}
              </optgroup>
            )}
            {unverifiedGroup.length > 0 && (
              <optgroup label="~ Same dataset (unverified)">
                {unverifiedGroup.map((o) => renderOption(o.run, "unverified"))}
              </optgroup>
            )}
          </>
        ) : (
          options.map(({ run }) => renderOption(run))
        )}
      </select>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ComparisonStudio() {
  const [searchParams, setSearchParams] = useSearchParams();
  const runAId = searchParams.get("a") ? Number(searchParams.get("a")) : null;
  const runBId = searchParams.get("b") ? Number(searchParams.get("b")) : null;

  const [anatomicalViewMode, setAnatomicalViewMode] = useState<AnatomicalViewMode>("sidebyside");
  const [matrixViewMode, setMatrixViewMode] = useState<MatrixViewMode>("sidebyside");
  const nvARef = useRef<Niivue | null>(null);
  const nvBRef = useRef<Niivue | null>(null);

  // Pipeline produces cache: id → produced artifact types
  const [producesCache, setProducesCache] = useState<Record<string, string[]>>({});

  // Geometry + Dice state (anatomical family)
  const [geomState, setGeomState] = useState<GeomState>({ status: "idle" });
  const [diceState, setDiceState] = useState<DiceState>({ status: "idle" });
  // Connectivity comparison state
  const [connectivityState, setConnectivityState] = useState<ConnectivityCompareState>({ status: "idle" });
  const workerRef = useRef<Worker | null>(null);

  const { data: allRuns, isLoading: runsLoading } = useRuns();
  const { data: resultsA } = useRunResults(runAId ?? 0, runAId !== null);
  const { data: resultsB } = useRunResults(runBId ?? 0, runBId !== null);

  // Load pipeline manifests for all successful runs to build producesCache
  useEffect(() => {
    if (!allRuns) return;
    const successRuns = allRuns.filter((r) => r.status === "success");
    const ids = [...new Set(successRuns.map((r) => r.pipeline_manifest_id))];
    const uncached = ids.filter((id) => !(id in producesCache));
    if (uncached.length === 0) return;
    Promise.all(uncached.map((id) => fetchPipeline(id).catch(() => null))).then((pipelines) => {
      const updates: Record<string, string[]> = {};
      for (const p of pipelines) {
        if (p) updates[p.id] = (p.produces ?? []).map((s) => s.type);
      }
      setProducesCache((prev) => ({ ...prev, ...updates }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRuns]);

  // Build run options: successful runs producing volumetric or connectivity artifacts
  const runOptions: RunOption[] = (allRuns ?? [])
    .filter((r) => r.status === "success")
    .map((r) => ({ run: r, producedTypes: producesCache[r.pipeline_manifest_id] ?? [] }))
    .filter((o) =>
      o.producedTypes.some(
        (t) =>
          t.includes("nifti") ||
          t.includes("brain") ||
          t.includes("mask") ||
          t.startsWith("connectivity_") ||
          t.startsWith("seed_connectivity_") ||
          t.startsWith("group_") ||
          t.startsWith("roi_extraction_") ||
          t.startsWith("graph_") ||
          t.startsWith("alff_") ||
          t.startsWith("falff_"),
      ),
    );

  const runAOption = runOptions.find((o) => o.run.id === runAId);
  const runBOption = runOptions.find((o) => o.run.id === runBId);

  // Determine comparison family for Run A (single-run)
  const runAFamily = runAOption ? detectRunFamily(runAOption.producedTypes) : null;

  // B candidates depend on Run A's family:
  // - connectivity: same-pipeline OK (comparing two FC runs across subjects/sessions)
  // - anatomical: different pipeline required (comparing two skull-strippers)
  const bOptions = runAOption
    ? runOptions.filter((o) => {
        if (o.run.id === runAId) return false;
        const sharedTypes = o.producedTypes.filter((t) =>
          runAOption.producedTypes.includes(t),
        );
        if (sharedTypes.length === 0) return false;
        if (runAFamily === "connectivity" || runAFamily === "seed_connectivity" || runAFamily === "group_connectivity" || runAFamily === "alff_falff" || runAFamily === "reho" || runAFamily === "nifti_inspector" || runAFamily === "roi_extraction" || runAFamily === "graph_analysis") return true;
        return o.run.pipeline_manifest_id !== runAOption.run.pipeline_manifest_id;
      })
    : runOptions.filter((o) => o.run.id !== runBId);

  // A candidates: symmetric
  const runBFamily = runBOption ? detectRunFamily(runBOption.producedTypes) : null;
  const aOptions = runBOption
    ? runOptions.filter((o) => {
        if (o.run.id === runBId) return false;
        const sharedTypes = o.producedTypes.filter((t) =>
          runBOption.producedTypes.includes(t),
        );
        if (sharedTypes.length === 0) return false;
        if (runBFamily === "connectivity" || runBFamily === "seed_connectivity" || runBFamily === "group_connectivity" || runBFamily === "alff_falff" || runBFamily === "nifti_inspector" || runBFamily === "roi_extraction" || runBFamily === "graph_analysis") return true;
        return o.run.pipeline_manifest_id !== runBOption.run.pipeline_manifest_id;
      })
    : runOptions;

  // Comparison family between the two selected runs
  const comparisonFamily: ComparisonFamily =
    runAOption && runBOption
      ? detectComparisonFamily(runAOption.producedTypes, runBOption.producedTypes)
      : "none";

  // Eligibility between the two selected runs
  const runASummary = runAOption?.run ?? null;
  const runBSummary = runBOption?.run ?? null;
  const eligibility =
    runASummary && runBSummary ? classifyEligibility(runASummary, runBSummary) : null;

  function resetState() {
    setGeomState({ status: "idle" });
    setDiceState({ status: "idle" });
    setConnectivityState({ status: "idle" });
  }

  function setRunA(id: number | null) {
    const p = new URLSearchParams(searchParams);
    if (id) p.set("a", String(id)); else p.delete("a");
    setSearchParams(p);
    resetState();
  }

  function setRunB(id: number | null) {
    const p = new URLSearchParams(searchParams);
    if (id) p.set("b", String(id)); else p.delete("b");
    setSearchParams(p);
    resetState();
  }

  // Auto-suggest: when A is selected and B is empty, pick first compatible B
  useEffect(() => {
    if (runAId && !runBId && bOptions.length === 1) {
      setRunB(bOptions[0].run.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runAId, runBId, bOptions.length]);

  // Parse NIfTI headers when both anatomical runs are loaded with masks
  useEffect(() => {
    if (comparisonFamily !== "anatomical" || !resultsA || !resultsB || !runAId || !runBId) {
      if (comparisonFamily !== "anatomical") setGeomState({ status: "idle" });
      return;
    }
    const urlA = getMaskUrl(resultsA, runAId);
    const urlB = getMaskUrl(resultsB, runBId);
    if (!urlA || !urlB) return;

    setGeomState({ status: "loading" });

    Promise.all([parseNiftiHeader(urlA), parseNiftiHeader(urlB)])
      .then(([hA, hB]) => {
        const geomA: NiftiGeometry = {
          dims: hA.dims,
          pixdim: hA.pixdim,
          datatype: hA.datatype,
          qformCode: hA.qformCode,
          sformCode: hA.sformCode,
        };
        const geomB: NiftiGeometry = {
          dims: hB.dims,
          pixdim: hB.pixdim,
          datatype: hB.datatype,
          qformCode: hB.qformCode,
          sformCode: hB.sformCode,
        };
        setGeomState({ status: "done", geomA, geomB });
      })
      .catch((err: unknown) => {
        setGeomState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      });
  }, [resultsA, resultsB, runAId, runBId, comparisonFamily]);

  // Load connectivity matrices and metadata when both connectivity runs are loaded
  useEffect(() => {
    if (comparisonFamily !== "connectivity" || !resultsA || !resultsB || !runAId || !runBId) {
      if (comparisonFamily !== "connectivity") setConnectivityState({ status: "idle" });
      return;
    }
    const matrixA = resultsA.connectivity_matrices?.[0];
    const matrixB = resultsB.connectivity_matrices?.[0];
    const metaFileA = resultsA.connectivity_metadata?.[0];
    const metaFileB = resultsB.connectivity_metadata?.[0];

    if (!matrixA || !matrixB) {
      setConnectivityState({ status: "idle" });
      return;
    }

    setConnectivityState({ status: "loading" });

    Promise.all([
      fetchRunTextFile(runAId, matrixA.path),
      fetchRunTextFile(runBId, matrixB.path),
      metaFileA ? fetchRunFile<ConnectivityMetadata>(runAId, metaFileA.path).catch(() => null) : Promise.resolve(null),
      metaFileB ? fetchRunFile<ConnectivityMetadata>(runBId, metaFileB.path).catch(() => null) : Promise.resolve(null),
      loadRoiStatistics(runAId, resultsA).catch(() => []),
      loadRoiStatistics(runBId, resultsB).catch(() => []),
    ])
      .then(([textA, textB, metaA, metaB, roiA, roiB]) => {
        const a = parseConnectivityMatrixCsv(textA);
        const b = parseConnectivityMatrixCsv(textB);
        const sameDimensions =
          a.values.length === b.values.length &&
          (a.values[0]?.length ?? 0) === (b.values[0]?.length ?? 0);
        const compatibility =
          metaA && metaB ? checkMatrixCompatibility(metaA, metaB) : undefined;
        const canDiff = compatibility?.compatible !== false;
        if (!sameDimensions && canDiff) {
          throw new Error("Connectivity matrices have different dimensions.");
        }
        const diffStats = sameDimensions && canDiff
          ? connectivityMatrixDifference(a, b)
          : {};
        const roiComparison =
          roiA.length > 0 && roiB.length > 0 && canDiff
            ? compareRoiStatistics(roiA, roiB)
            : undefined;
        setConnectivityState({
          status: "done",
          a,
          b,
          metaA: metaA ?? undefined,
          metaB: metaB ?? undefined,
          compatibility,
          roiComparison,
          ...diffStats,
        });
      })
      .catch((err: unknown) => {
        setConnectivityState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [resultsA, resultsB, runAId, runBId, comparisonFamily]);

  // Compute Dice via Web Worker when anatomical geometry is compatible
  useEffect(() => {
    if (comparisonFamily !== "anatomical") return;
    if (geomState.status !== "done" || !resultsA || !resultsB || !runAId || !runBId) return;
    if (!geomState.geomA || !geomState.geomB) return;
    if (!geometriesCompatible(geomState.geomA, geomState.geomB)) return;

    const urlA = getMaskUrl(resultsA, runAId);
    const urlB = getMaskUrl(resultsB, runBId);
    if (!urlA || !urlB) return;

    workerRef.current?.terminate();
    setDiceState({ status: "loading", message: "Starting…" });

    const worker = new Worker(
      new URL("../workers/maskDiff.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;

    worker.onmessage = (evt: MessageEvent) => {
      const msg = evt.data as {
        type: string;
        message?: string;
        dice?: number;
        intersection?: number;
        aOnly?: number;
        bOnly?: number;
        totalForeground?: number;
        reason?: string;
      };
      if (msg.type === "progress") {
        setDiceState({ status: "loading", message: msg.message });
      } else if (msg.type === "result") {
        const stats: DiceStats = {
          dice: msg.dice!,
          intersection: msg.intersection!,
          aOnly: msg.aOnly!,
          bOnly: msg.bOnly!,
          totalForeground: msg.totalForeground!,
        };
        setDiceState({ status: "done", stats });
        worker.terminate();
        workerRef.current = null;
      } else if (msg.type === "incompatible") {
        setDiceState({ status: "incompatible", message: msg.reason });
        worker.terminate();
        workerRef.current = null;
      } else if (msg.type === "error") {
        setDiceState({ status: "error", message: msg.message });
        worker.terminate();
        workerRef.current = null;
      }
    };

    worker.onerror = (err) => {
      setDiceState({ status: "error", message: err.message });
      workerRef.current = null;
    };

    worker.postMessage({ type: "compute", urlA, urlB });

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geomState.status, geomState.geomA, geomState.geomB, comparisonFamily]);

  // Geometry compatibility (for disabling Difference mode)
  const geomCompatible =
    geomState.status === "done" &&
    geomState.geomA &&
    geomState.geomB &&
    geometriesCompatible(geomState.geomA, geomState.geomB);

  // Linked mode: once both panels ready, call broadcastTo
  const handleNvAReady = useCallback(
    (nv: Niivue) => {
      nvARef.current = nv;
      if (anatomicalViewMode === "linked" && nvBRef.current) nv.broadcastTo(nvBRef.current);
    },
    [anatomicalViewMode]
  );

  const handleNvBReady = useCallback(
    (nv: Niivue) => {
      nvBRef.current = nv;
      if (anatomicalViewMode === "linked" && nvARef.current) nvARef.current.broadcastTo(nv);
    },
    [anatomicalViewMode]
  );

  useEffect(() => {
    if (anatomicalViewMode === "linked" && nvARef.current && nvBRef.current) {
      nvARef.current.broadcastTo(nvBRef.current);
    }
  }, [anatomicalViewMode]);

  const metaA = resultsA?.metadata ?? null;
  const metaB = resultsB?.metadata ?? null;

  const labelA = metaA
    ? `Run #${runAId} — ${metaA.pipeline_display_name ?? metaA.pipeline_id}`
    : runAId ? `Run #${runAId}` : "Run A";
  const labelB = metaB
    ? `Run #${runBId} — ${metaB.pipeline_display_name ?? metaB.pipeline_id}`
    : runBId ? `Run #${runBId}` : "Run B";

  const bothSelected = runAId !== null && runBId !== null;
  const bothLoaded = resultsA !== undefined && resultsB !== undefined;

  // Anatomical viewer layers
  const layersA: NiivueLayer[] =
    comparisonFamily === "anatomical" && resultsA && runAId
      ? anatomicalViewMode === "maskoverlay" || anatomicalViewMode === "difference"
        ? buildMaskLayers(resultsA, runAId, "blue")
        : buildLayers(resultsA, runAId)
      : [];

  const layersB: NiivueLayer[] =
    comparisonFamily === "anatomical" && resultsB && runBId
      ? anatomicalViewMode === "maskoverlay" || anatomicalViewMode === "difference"
        ? buildMaskLayers(resultsB, runBId, "red")
        : buildLayers(resultsB, runBId)
      : [];

  const ANATOMICAL_VIEW_MODES: Array<{ mode: AnatomicalViewMode; label: string; disabled?: boolean; title?: string }> = [
    { mode: "sidebyside", label: "Side by side" },
    { mode: "linked", label: "Linked" },
    { mode: "maskoverlay", label: "Mask Overlay" },
    {
      mode: "difference",
      label: "Difference",
      disabled: geomState.status === "done" && !geomCompatible,
      title:
        geomState.status === "done" && !geomCompatible
          ? "Disabled: geometry mismatch between masks"
          : undefined,
    },
  ];

  // Prompt message when Run A is set but no compatible Run B exists
  const noCompatibleBMessage =
    runAId && !runBId && bOptions.length === 0
      ? runAFamily === "group_connectivity"
        ? "No other group connectivity runs found. Run group-functional-connectivity on a second set of FC runs to compare."
        : runAFamily === "reho"
        ? "No other compatible ReHo runs found. Run regional-homogeneity again on the same source to compare KCC maps."
        : runAFamily === "alff_falff"
        ? "No other compatible ALFF/fALFF runs found. Run ALFF/fALFF again on the same source to compare maps."
        : runAFamily === "roi_extraction"
        ? "No other Atlas ROI Extraction runs found. Run atlas-roi-extraction on another NIfTI to compare region statistics."
        : runAFamily === "nifti_inspector"
        ? "No other NIfTI Inspector runs found. Run nifti-inspector on another NIfTI file to compare metadata and statistics."
        : runAFamily === "connectivity"
        ? "No compatible connectivity runs found. Run functional-connectivity again (on this or another subject) to enable matrix comparison."
        : runAFamily === "seed_connectivity"
        ? "No compatible seed connectivity runs found. Run seed-based-connectivity again (on this or another subject) to compare maps."
        : "No compatible runs found to compare with Run A. Run another skull-stripping pipeline first."
      : runAId && !runBId && bOptions.length > 0
      ? `Select Run B above. ${bOptions.length} compatible run${bOptions.length === 1 ? "" : "s"} found.`
      : null;

  return (
    <div className="min-h-screen bg-background text-gray-200">
      {/* Header */}
      <div className="border-b border-white/10 bg-surface px-6 py-4">
        <div className="max-w-screen-2xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <a href="/runs" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                ← All runs
              </a>
            </div>
            <h1 className="text-lg font-semibold text-gray-100">Pipeline Comparison Studio</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Compare outputs from different pipelines on the same source data.
            </p>
          </div>

          {/* Anatomical mode switcher — only when family is anatomical */}
          {bothSelected && bothLoaded && comparisonFamily === "anatomical" && (
            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-surface-raised p-1">
              {ANATOMICAL_VIEW_MODES.map(({ mode, label, disabled, title }) => (
                <button
                  key={mode}
                  onClick={() => !disabled && setAnatomicalViewMode(mode)}
                  title={title}
                  disabled={disabled}
                  className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                    anatomicalViewMode === mode
                      ? "bg-blue-600 text-white shadow-sm"
                      : disabled
                      ? "text-gray-600 cursor-not-allowed"
                      : "text-gray-400 hover:text-gray-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-6">
        {/* Run selectors */}
        <div className="grid grid-cols-2 gap-4 max-w-2xl">
          <RunSelector
            label="Run A"
            value={runAId}
            options={aOptions.length > 0 ? aOptions : runOptions}
            referenceRun={runBSummary}
            onChange={setRunA}
          />
          <RunSelector
            label="Run B"
            value={runBId}
            options={bOptions.length > 0 ? bOptions : runOptions.filter((o) => o.run.id !== runAId)}
            referenceRun={runASummary}
            onChange={setRunB}
          />
        </div>

        {/* Eligibility badge */}
        {eligibility && bothSelected && (
          <div className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 max-w-2xl ${
            eligibility.tier === "verified"
              ? "bg-green-500/10 border border-green-500/20 text-green-300"
              : eligibility.tier === "unverified"
              ? "bg-amber-500/10 border border-amber-500/20 text-amber-300"
              : "bg-red-500/10 border border-red-500/20 text-red-300"
          }`}>
            <span className="shrink-0 mt-0.5">
              {eligibility.tier === "verified"
                ? <CheckCircle className="h-3.5 w-3.5" />
                : eligibility.tier === "unverified"
                ? <AlertTriangle className="h-3.5 w-3.5" />
                : <XCircle className="h-3.5 w-3.5" />}
            </span>
            <span>{eligibility.reason}</span>
          </div>
        )}

        {/* Loading state */}
        {runsLoading && <div className="text-sm text-gray-500">Loading runs…</div>}

        {/* No eligible runs found */}
        {!runsLoading && runOptions.length === 0 && (
          <div className="rounded-lg border border-white/10 bg-surface-raised px-5 py-4 text-sm text-gray-400 max-w-xl">
            No completed runs with comparable volumetric or connectivity outputs found yet.
          </div>
        )}

        {/* Prompt to select / no compatible runs */}
        {!runsLoading && runOptions.length > 0 && (!runAId || !runBId) && (
          <div className="rounded-lg border border-white/10 bg-surface-raised px-5 py-4 text-sm text-gray-400 max-w-xl">
            {!runAId && !runBId && "Select two runs above to compare their outputs."}
            {noCompatibleBMessage}
          </div>
        )}

        {/* Mixed-family warning */}
        {bothSelected && bothLoaded && comparisonFamily === "mixed" && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-5 py-4 text-sm text-amber-300 max-w-xl">
            <AlertTriangle className="mr-1.5 inline h-4 w-4" />These runs produce different artifact families (one anatomical, one connectivity).
            Select two runs from the same family to compare.
          </div>
        )}

        {/* Main comparison content */}
        {bothSelected && bothLoaded && comparisonFamily !== "mixed" && (
          <>
            {/* Run badges */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full bg-blue-500 shrink-0" />
                <span className="text-xs text-gray-300">{labelA}</span>
                {metaA && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${metaA.status === "success" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>{metaA.status}</span>
                )}
              </div>
              <span className="text-gray-600 text-xs">vs</span>
              <div className="flex items-center gap-2">
                <div className="h-2.5 w-2.5 rounded-full bg-violet-500 shrink-0" />
                <span className="text-xs text-gray-300">{labelB}</span>
                {metaB && (
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${metaB.status === "success" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>{metaB.status}</span>
                )}
              </div>
            </div>

            {/* ReHo comparison panel */}
            {comparisonFamily === "reho" && resultsA && resultsB && (
              <RehoComparisonPanel runIdA={runAId!} runIdB={runBId!} resultsA={resultsA} resultsB={resultsB} labelA={labelA} labelB={labelB}/>
            )}

            {/* ALFF/fALFF comparison panel */}
            {comparisonFamily === "alff_falff" && resultsA && resultsB && (
              <AlffFalffComparisonPanel runIdA={runAId!} runIdB={runBId!} resultsA={resultsA} resultsB={resultsB} labelA={labelA} labelB={labelB}/>
            )}

            {/* Seed connectivity comparison panel */}
            {comparisonFamily === "connectivity" &&
              runAFamily === "seed_connectivity" &&
              runBFamily === "seed_connectivity" &&
              resultsA &&
              resultsB && (
                <SeedConnectivityComparisonPanel
                  runIdA={runAId!}
                  runIdB={runBId!}
                  resultsA={resultsA}
                  resultsB={resultsB}
                  labelA={labelA}
                  labelB={labelB}
                />
              )}

            {/* Group FC comparison panel */}
            {comparisonFamily === "group_connectivity" &&
              resultsA &&
              resultsB && (
                <GroupFCComparisonPanel
                  runIdA={runAId!}
                  runIdB={runBId!}
                  resultsA={resultsA}
                  resultsB={resultsB}
                  labelA={labelA}
                  labelB={labelB}
                />
              )}

            {/* Connectome Graph Analysis comparison panel */}
            {comparisonFamily === "graph_analysis" && runAId && runBId && (
              <GraphAnalysisComparisonPanel
                runIdA={runAId}
                runIdB={runBId}
                labelA={labelA}
                labelB={labelB}
              />
            )}

            {/* Atlas ROI Extraction comparison panel */}
            {comparisonFamily === "roi_extraction" && runAId && runBId && (
              <RoiExtractionComparisonPanel
                runIdA={runAId}
                runIdB={runBId}
                labelA={labelA}
                labelB={labelB}
              />
            )}

            {/* NIfTI Inspector comparison panel */}
            {comparisonFamily === "nifti_inspector" && runAId && runBId && (
              <NiftiInspectorComparisonPanel
                runIdA={runAId}
                runIdB={runBId}
                labelA={labelA}
                labelB={labelB}
              />
            )}

            {/* Atlas connectivity matrix comparison panel */}
            {comparisonFamily === "connectivity" && runAFamily !== "seed_connectivity" && (
              <ConnectivityComparisonPanel
                state={connectivityState}
                labelA={labelA}
                labelB={labelB}
                matrixViewMode={matrixViewMode}
                onMatrixViewModeChange={setMatrixViewMode}
              />
            )}

            {/* Anatomical NIfTI viewer */}
            {comparisonFamily === "anatomical" && (layersA.length > 0 || layersB.length > 0) && (
              <div>
                <SectionHeading>
                  {anatomicalViewMode === "sidebyside" && "Side-by-side view"}
                  {anatomicalViewMode === "linked" && "Linked view — scroll one panel to move both"}
                  {anatomicalViewMode === "maskoverlay" && "Mask Overlay — brain mask per pipeline"}
                  {anatomicalViewMode === "difference" && "Difference — binary masks side by side"}
                </SectionHeading>
                {anatomicalViewMode === "maskoverlay" && (
                  <p className="text-xs text-gray-500 mb-3">
                    Mask Overlay: each panel shows one pipeline's brain mask. Blue = Run A, Red = Run B.
                  </p>
                )}
                <div
                  className="grid grid-cols-2 gap-2 rounded-xl overflow-hidden border border-white/10"
                  style={{ height: "55vh" }}
                >
                  {layersA.length > 0 ? (
                    <NiivuePanel
                      key={`a-${anatomicalViewMode}-${layersA.map((l) => l.url).join()}`}
                      layers={layersA}
                      label={labelA}
                      onReady={handleNvAReady}
                      onUnmount={() => { nvARef.current = null; }}
                    />
                  ) : (
                    <div className="flex items-center justify-center bg-gray-950 text-xs text-gray-500">
                      No volume files in Run A
                    </div>
                  )}
                  {layersB.length > 0 ? (
                    <NiivuePanel
                      key={`b-${anatomicalViewMode}-${layersB.map((l) => l.url).join()}`}
                      layers={layersB}
                      label={labelB}
                      onReady={handleNvBReady}
                      onUnmount={() => { nvBRef.current = null; }}
                    />
                  ) : (
                    <div className="flex items-center justify-center bg-gray-950 text-xs text-gray-500">
                      No volume files in Run B
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Geometry table — anatomical only */}
            {comparisonFamily === "anatomical" && (
              <GeometryTable geomState={geomState} labelA={labelA} labelB={labelB} />
            )}

            {/* Dice coefficient — anatomical only */}
            {comparisonFamily === "anatomical" && (
              <DicePanel diceState={diceState} />
            )}

            {/* Metadata comparison */}
            {metaA && metaB && (
              <MetadataComparison metaA={metaA} metaB={metaB} labelA={labelA} labelB={labelB} />
            )}

            {/* Artifact / file comparison */}
            {resultsA && resultsB && (
              <ArtifactComparison
                resultsA={resultsA}
                resultsB={resultsB}
                labelA={labelA}
                labelB={labelB}
                runIdA={runAId!}
                runIdB={runBId!}
              />
            )}

            {/* Lineage note */}
            {(metaA?.lineage || metaB?.lineage) && (
              <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3 text-xs text-gray-400 max-w-2xl">
                <span className="text-purple-300 font-medium">Lineage: </span>
                {metaA?.lineage && (
                  <span>Run A traces to run #{metaA.lineage.upstream_run_id} ({metaA.lineage.upstream_pipeline_id}).{" "}</span>
                )}
                {metaB?.lineage && (
                  <span>Run B traces to run #{metaB.lineage.upstream_run_id} ({metaB.lineage.upstream_pipeline_id}).</span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
