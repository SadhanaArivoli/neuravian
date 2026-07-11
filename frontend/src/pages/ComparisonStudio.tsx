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
  type ComparisonFamily,
  type DiceStats,
  type NiftiGeometry,
} from "../lib/comparisonEligibility";
import {
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
import { parseNiftiHeader, DATATYPE_LABELS } from "../lib/niftiHeader";

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
          const t = (scaled + 1) / 2;
          const r = Math.round(40 + t * 200);
          const g = Math.round(90 + (1 - Math.abs(t - 0.5) * 2) * 80);
          const b = Math.round(220 - t * 170);
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

      {/* Cross-subject warning */}
      {compat?.mode === "cross-subject" && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          ⚠ Cross-subject comparison: these matrices are from different source BOLD files.
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
            Blue = A &lt; B · Red = A &gt; B · Teal = near-zero difference
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

  // Compatibility check
  const sameAtlas = !metaA || !metaB || metaA.atlas_id === metaB.atlas_id;
  const sameSeed = !metaA || !metaB || metaA.seed_roi_index === metaB.seed_roi_index;
  const compatible = sameAtlas && sameSeed;

  return (
    <div className="space-y-4">
      <SectionHeading>Seed connectivity map comparison</SectionHeading>

      {metaA && metaB && !compatible && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-300">
          ⚠ Incompatible runs:{" "}
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
  n_rois?: number;
  correlation_method?: string;
  nilearn_version?: string;
  mean_z_min?: number;
  mean_z_max?: number;
  mean_z_mean?: number;
  mean_z_std?: number;
  std_z_max?: number;
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
    !summaryA || !summaryB || summaryA.atlas_id === summaryB.atlas_id;
  const sameRoiCount =
    !summaryA || !summaryB || summaryA.n_rois === summaryB.n_rois;
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
              ⚠ Incompatible:{" "}
              {!sameAtlas && `different atlases (${summaryA.atlas_id ?? "?"} vs ${summaryB.atlas_id ?? "?"})`}
              {!sameAtlas && !sameRoiCount && " · "}
              {!sameRoiCount && `different ROI counts (${summaryA.n_rois ?? "?"} vs ${summaryB.n_rois ?? "?"})`}
            </span>
          )}
          {compatible && summaryA.atlas && (
            <span className="text-gray-500">{summaryA.atlas}</span>
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
          t.startsWith("group_"),
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
        if (runAFamily === "connectivity" || runAFamily === "seed_connectivity" || runAFamily === "group_connectivity") return true;
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
        if (runBFamily === "connectivity" || runBFamily === "seed_connectivity" || runBFamily === "group_connectivity") return true;
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
              {eligibility.tier === "verified" ? "✓" : eligibility.tier === "unverified" ? "⚠" : "✗"}
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
            ⚠ These runs produce different artifact families (one anatomical, one connectivity).
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
