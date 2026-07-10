/**
 * Pipeline Comparison Studio
 *
 * Compares outputs from two different pipelines run on the same source data.
 * Route: /compare?a=<runId>&b=<runId>
 *
 * Candidate discovery uses three-tier lineage-safe eligibility:
 *   verified   – shared source_run_id (confirmed same ancestor)
 *   unverified – same dataset_id only (fallback with warning)
 *   ineligible – different datasets (excluded)
 *
 * Four viewer modes: Side-by-Side, Linked, Mask Overlay, Difference.
 * "Difference" requires geometry-compatible masks and computes voxel-wise
 * binary disagreement via a Web Worker.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Niivue } from "@niivue/niivue";
import { useRuns } from "../hooks/useRuns";
import { useRunResults } from "../hooks/useRuns";
import { fetchPipeline, fetchRunTextFile } from "../api/client";
import type { RunMetadata, RunResults, RunSummary } from "../api/client";
import NiivuePanel from "../components/domain/NiivuePanel";
import type { NiivueLayer } from "../components/domain/NiivuePanel";
import {
  classifyEligibility,
  sortByEligibility,
  geometriesCompatible,
  type DiceStats,
  type NiftiGeometry,
} from "../lib/comparisonEligibility";
import {
  connectivityMatrixDifference,
  connectivityMatrixRange,
  parseConnectivityMatrixCsv,
  type ConnectivityMatrixData,
} from "../lib/connectivityMatrix";
import { parseNiftiHeader, DATATYPE_LABELS } from "../lib/niftiHeader";

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewMode = "sidebyside" | "linked" | "maskoverlay" | "difference";

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
  frobenius?: number;
  minDiff?: number;
  maxDiff?: number;
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
          ⚠ Voxel-wise Difference and Dice are disabled — masks must share the same dimensions and voxel spacing.
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

function MatrixPreview({ matrix, mode }: { matrix: ConnectivityMatrixData; mode: "matrix" | "diff" }) {
  const size = matrix.values.length;
  const cells = matrix.values.slice(0, 40).map((row, y) =>
    row.slice(0, 40).map((value, x) => {
      const scaled = mode === "diff" ? Math.max(-1, Math.min(1, value)) : Math.max(-1, Math.min(1, value));
      const t = (scaled + 1) / 2;
      const color = `rgb(${Math.round(40 + t * 200)}, ${Math.round(90 + (1 - Math.abs(t - 0.5) * 2) * 80)}, ${Math.round(220 - t * 170)})`;
      return <div key={`${y}-${x}`} title={`${matrix.labels[y] ?? y + 1} x ${matrix.labels[x] ?? x + 1}: ${value.toFixed(3)}`} style={{ backgroundColor: color }} />;
    }),
  );
  return (
    <div
      className="grid h-48 w-48 overflow-hidden rounded border border-white/10"
      style={{ gridTemplateColumns: `repeat(${Math.min(size, 40)}, minmax(0, 1fr))` }}
    >
      {cells}
    </div>
  );
}

function ConnectivityComparisonPanel({
  state,
  labelA,
  labelB,
}: {
  state: ConnectivityCompareState;
  labelA: string;
  labelB: string;
}) {
  if (state.status === "idle") return null;
  if (state.status === "loading") {
    return (
      <div className="rounded-lg border border-white/10 bg-surface-raised px-4 py-3 text-xs text-gray-400">
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

  const rangeA = connectivityMatrixRange(state.a);
  const rangeB = connectivityMatrixRange(state.b);
  const diffValues: ConnectivityMatrixData = {
    labels: state.a.labels,
    values: state.a.values.map((row, y) => row.map((value, x) => value - (state.b!.values[y]?.[x] ?? 0))),
  };

  return (
    <div>
      <SectionHeading>Connectivity matrix comparison</SectionHeading>
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_auto]">
        <div className="rounded-lg border border-white/10 bg-surface-raised p-4">
          <p className="mb-2 text-xs font-medium text-gray-300">{labelA}</p>
          <MatrixPreview matrix={state.a} mode="matrix" />
        </div>
        <div className="rounded-lg border border-white/10 bg-surface-raised p-4">
          <p className="mb-2 text-xs font-medium text-gray-300">{labelB}</p>
          <MatrixPreview matrix={state.b} mode="matrix" />
        </div>
        <div className="rounded-lg border border-white/10 bg-surface-raised p-4">
          <p className="mb-2 text-xs font-medium text-gray-300">Difference</p>
          <MatrixPreview matrix={diffValues} mode="diff" />
        </div>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["A dimensions", `${rangeA.rows} x ${rangeA.cols}`],
          ["B dimensions", `${rangeB.rows} x ${rangeB.cols}`],
          ["A range", `${rangeA.min.toFixed(3)} to ${rangeA.max.toFixed(3)}`],
          ["B range", `${rangeB.min.toFixed(3)} to ${rangeB.max.toFixed(3)}`],
          ["Frobenius diff", state.frobenius?.toFixed(4) ?? "—"],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-white/10 bg-white/5 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
            <div className="font-mono text-xs font-semibold text-gray-200">{value}</div>
          </div>
        ))}
      </div>
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
      <div className="rounded-lg border border-white/10 overflow-hidden">
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

      <div className="mt-3 rounded-lg border border-white/10 overflow-hidden">
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
  ref: refRun,
  onChange,
}: {
  label: string;
  value: number | null;
  options: RunOption[];
  ref?: RunSummary | null;
  onChange: (id: number | null) => void;
}) {
  // When a reference run is known, group options by eligibility tier
  const grouped = refRun
    ? sortByEligibility(refRun, options.map((o) => ({ run: o.run, producedTypes: o.producedTypes })))
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

  const [viewMode, setViewMode] = useState<ViewMode>("sidebyside");
  const nvARef = useRef<Niivue | null>(null);
  const nvBRef = useRef<Niivue | null>(null);

  // Pipeline produces cache: id → produced artifact types
  const [producesCache, setProducesCache] = useState<Record<string, string[]>>({});

  // Geometry + Dice state
  const [geomState, setGeomState] = useState<GeomState>({ status: "idle" });
  const [diceState, setDiceState] = useState<DiceState>({ status: "idle" });
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

  // Build run options: successful volumetric or connectivity outputs
  const runOptions: RunOption[] = (allRuns ?? [])
    .filter((r) => r.status === "success")
    .map((r) => ({ run: r, producedTypes: producesCache[r.pipeline_manifest_id] ?? [] }))
    .filter((o) => o.producedTypes.some((t) => t.includes("nifti") || t.includes("brain") || t.includes("mask") || t.startsWith("connectivity_")));

  const runAOption = runOptions.find((o) => o.run.id === runAId);
  const runBOption = runOptions.find((o) => o.run.id === runBId);

  // B candidates: different pipeline, shares at least one artifact type with A
  const bOptions = runAOption
    ? runOptions.filter(
        (o) =>
          o.run.id !== runAId &&
          o.run.pipeline_manifest_id !== runAOption.run.pipeline_manifest_id &&
          o.producedTypes.some((t) => runAOption.producedTypes.includes(t))
      )
    : runOptions.filter((o) => o.run.id !== runBId);

  // A candidates: symmetric filter against B
  const aOptions = runBOption
    ? runOptions.filter(
        (o) =>
          o.run.id !== runBId &&
          o.run.pipeline_manifest_id !== runBOption.run.pipeline_manifest_id &&
          o.producedTypes.some((t) => runBOption.producedTypes.includes(t))
      )
    : runOptions;

  // Eligibility between the two selected runs
  const runASummary = runAOption?.run ?? null;
  const runBSummary = runBOption?.run ?? null;
  const eligibility =
    runASummary && runBSummary ? classifyEligibility(runASummary, runBSummary) : null;

  function setRunA(id: number | null) {
    const p = new URLSearchParams(searchParams);
    if (id) p.set("a", String(id)); else p.delete("a");
    setSearchParams(p);
    setGeomState({ status: "idle" });
    setDiceState({ status: "idle" });
    setConnectivityState({ status: "idle" });
  }

  function setRunB(id: number | null) {
    const p = new URLSearchParams(searchParams);
    if (id) p.set("b", String(id)); else p.delete("b");
    setSearchParams(p);
    setGeomState({ status: "idle" });
    setDiceState({ status: "idle" });
    setConnectivityState({ status: "idle" });
  }

  // Auto-suggest: when A is selected and B is empty, pick first verified-or-only compatible B
  useEffect(() => {
    if (runAId && !runBId && bOptions.length === 1) {
      setRunB(bOptions[0].run.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runAId, runBId, bOptions.length]);

  // Parse NIfTI headers when both runs are loaded and have masks
  useEffect(() => {
    if (!resultsA || !resultsB || !runAId || !runBId) {
      setGeomState({ status: "idle" });
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
  }, [resultsA, resultsB, runAId, runBId]);

  useEffect(() => {
    if (!resultsA || !resultsB || !runAId || !runBId) {
      setConnectivityState({ status: "idle" });
      return;
    }
    const matrixA = resultsA.connectivity_matrices?.[0];
    const matrixB = resultsB.connectivity_matrices?.[0];
    if (!matrixA || !matrixB) {
      setConnectivityState({ status: "idle" });
      return;
    }
    setConnectivityState({ status: "loading" });
    Promise.all([
      fetchRunTextFile(runAId, matrixA.path),
      fetchRunTextFile(runBId, matrixB.path),
    ])
      .then(([textA, textB]) => {
        const a = parseConnectivityMatrixCsv(textA);
        const b = parseConnectivityMatrixCsv(textB);
        if (a.values.length !== b.values.length || (a.values[0]?.length ?? 0) !== (b.values[0]?.length ?? 0)) {
          throw new Error("Connectivity matrices have different dimensions.");
        }
        setConnectivityState({ status: "done", a, b, ...connectivityMatrixDifference(a, b) });
      })
      .catch((err: unknown) => {
        setConnectivityState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      });
  }, [resultsA, resultsB, runAId, runBId]);

  // Compute Dice via Web Worker when geometry is compatible
  useEffect(() => {
    if (geomState.status !== "done" || !resultsA || !resultsB || !runAId || !runBId) return;
    if (!geomState.geomA || !geomState.geomB) return;
    if (!geometriesCompatible(geomState.geomA, geomState.geomB)) return;

    const urlA = getMaskUrl(resultsA, runAId);
    const urlB = getMaskUrl(resultsB, runBId);
    if (!urlA || !urlB) return;

    // Terminate any previous worker
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
        // Validate with our pure function for consistency
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
  }, [geomState.status, geomState.geomA, geomState.geomB]);

  // Validate: if geometry is incompatible, disable "Difference" mode
  const geomCompatible =
    geomState.status === "done" &&
    geomState.geomA &&
    geomState.geomB &&
    geometriesCompatible(geomState.geomA, geomState.geomB);

  // Linked mode: once both panels ready, call broadcastTo
  const handleNvAReady = useCallback(
    (nv: Niivue) => {
      nvARef.current = nv;
      if (viewMode === "linked" && nvBRef.current) nv.broadcastTo(nvBRef.current);
    },
    [viewMode]
  );

  const handleNvBReady = useCallback(
    (nv: Niivue) => {
      nvBRef.current = nv;
      if (viewMode === "linked" && nvARef.current) nvARef.current.broadcastTo(nv);
    },
    [viewMode]
  );

  useEffect(() => {
    if (viewMode === "linked" && nvARef.current && nvBRef.current) {
      nvARef.current.broadcastTo(nvBRef.current);
    }
  }, [viewMode]);

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

  // Build viewer layers based on mode
  const layersA: NiivueLayer[] =
    resultsA && runAId
      ? viewMode === "maskoverlay" || viewMode === "difference"
        ? buildMaskLayers(resultsA, runAId, "blue")
        : buildLayers(resultsA, runAId)
      : [];

  const layersB: NiivueLayer[] =
    resultsB && runBId
      ? viewMode === "maskoverlay" || viewMode === "difference"
        ? buildMaskLayers(resultsB, runBId, "red")
        : buildLayers(resultsB, runBId)
      : [];

  const VIEW_MODES: Array<{ mode: ViewMode; label: string; disabled?: boolean; title?: string }> = [
    { mode: "sidebyside", label: "Side by side" },
    { mode: "linked", label: "Linked" },
    { mode: "maskoverlay", label: "Mask Overlay" },
    {
      mode: "difference",
      label: "Difference",
      disabled: geomState.status === "done" && !geomCompatible,
      title: geomState.status === "done" && !geomCompatible
        ? "Disabled: geometry mismatch between masks"
        : undefined,
    },
  ];

  const viewerNote =
    viewMode === "maskoverlay"
      ? "Mask Overlay: each panel shows one pipeline's brain mask. Blue = Run A, Red = Run B."
      : viewMode === "difference"
      ? "Difference: each panel shows one pipeline's binary mask. Areas of agreement are in both panels; areas of disagreement appear in only one."
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

          {/* Mode switcher */}
          {bothSelected && bothLoaded && (
            <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-surface-raised p-1">
              {VIEW_MODES.map(({ mode, label, disabled, title }) => (
                <button
                  key={mode}
                  onClick={() => !disabled && setViewMode(mode)}
                  title={title}
                  disabled={disabled}
                  className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                    viewMode === mode
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
            ref={runBSummary}
            onChange={setRunA}
          />
          <RunSelector
            label="Run B"
            value={runBId}
            options={bOptions.length > 0 ? bOptions : runOptions.filter((o) => o.run.id !== runAId)}
            ref={runASummary}
            onChange={setRunB}
          />
        </div>

        {/* Eligibility badge — shown when both runs are selected */}
        {eligibility && bothSelected && (
          <div className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 max-w-2xl ${
            eligibility.tier === "verified"
              ? "bg-green-500/10 border border-green-500/20 text-green-300"
              : eligibility.tier === "unverified"
              ? "bg-amber-500/10 border border-amber-500/20 text-amber-300"
              : "bg-red-500/10 border border-red-500/20 text-red-300"
          }`}>
            <span className="shrink-0 mt-0.5">
              {eligibility.tier === "verified" ? "✓" : eligibility.tier === "unverified" ? "⚠" : "✗"}
            </span>
            <span>{eligibility.reason}</span>
          </div>
        )}

        {/* Loading state */}
        {runsLoading && <div className="text-sm text-gray-500">Loading runs…</div>}

        {/* No runs with nifti outputs yet */}
        {!runsLoading && runOptions.length === 0 && (
          <div className="rounded-lg border border-white/10 bg-surface-raised px-5 py-4 text-sm text-gray-400 max-w-xl">
            No completed runs with comparable volumetric or connectivity outputs found yet.
          </div>
        )}

        {/* Prompt to select runs */}
        {!runsLoading && runOptions.length > 0 && (!runAId || !runBId) && (
          <div className="rounded-lg border border-white/10 bg-surface-raised px-5 py-4 text-sm text-gray-400 max-w-xl">
            {!runAId && !runBId && "Select two runs above to compare their outputs."}
            {runAId && !runBId && bOptions.length === 0 && "No compatible runs found to compare with Run A. Run another skull-stripping pipeline first."}
            {runAId && !runBId && bOptions.length > 0 && `Select Run B above. ${bOptions.length} compatible run${bOptions.length === 1 ? "" : "s"} found.`}
          </div>
        )}

        {/* Main comparison content */}
        {bothSelected && bothLoaded && (
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

            {/* Viewer panels */}
            <ConnectivityComparisonPanel
              state={connectivityState}
              labelA={labelA}
              labelB={labelB}
            />

            {/* Viewer panels */}
            {(layersA.length > 0 || layersB.length > 0) && (
              <div>
                <SectionHeading>
                  {viewMode === "sidebyside" && "Side-by-side view"}
                  {viewMode === "linked" && "Linked view — scroll one panel to move both"}
                  {viewMode === "maskoverlay" && "Mask Overlay — brain mask per pipeline"}
                  {viewMode === "difference" && "Difference — binary masks side by side"}
                </SectionHeading>
                {viewerNote && <p className="text-xs text-gray-500 mb-3">{viewerNote}</p>}
                <div
                  className="grid grid-cols-2 gap-2 rounded-xl overflow-hidden border border-white/10"
                  style={{ height: "55vh" }}
                >
                  {layersA.length > 0 ? (
                    <NiivuePanel
                      key={`a-${viewMode}-${layersA.map((l) => l.url).join()}`}
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
                      key={`b-${viewMode}-${layersB.map((l) => l.url).join()}`}
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

            {/* Geometry table (Item 4) */}
            <GeometryTable geomState={geomState} labelA={labelA} labelB={labelB} />

            {/* Dice coefficient (Item 3) */}
            <DicePanel diceState={diceState} />

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
