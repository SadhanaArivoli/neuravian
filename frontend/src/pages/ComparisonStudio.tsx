/**
 * Pipeline Comparison Studio
 *
 * Compares outputs from two different pipelines run on the same source data.
 * Route: /compare?a=<runId>&b=<runId>
 *
 * Discovery: runs are "comparable" when they share the same dataset_id and
 * both produce at least one common artifact type. The page auto-suggests
 * candidates when only one run is selected.
 *
 * Three viewer modes (Side-by-Side, Linked, Difference) reuse NiivuePanel.
 * No backend changes required.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Niivue } from "@niivue/niivue";
import { useRuns } from "../hooks/useRuns";
import { useRunResults } from "../hooks/useRuns";
import { fetchPipeline } from "../api/client";
import type { RunMetadata, RunResults, RunSummary } from "../api/client";
import NiivuePanel from "../components/domain/NiivuePanel";
import type { NiivueLayer } from "../components/domain/NiivuePanel";

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewMode = "sidebyside" | "linked" | "difference";

interface RunOption {
  run: RunSummary;
  producedTypes: string[];
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
  return (
    <h2 className="text-sm font-semibold text-gray-100 mb-3">{children}</h2>
  );
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
      {/* Runtime bar chart */}
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

  // Pair files by name
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
                      <a
                        href={`/api/runs/${runIdA}/files/${fA.path}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:underline"
                      >
                        ↗ view
                      </a>
                    ) : (
                      <span className="text-red-400">missing</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-400">
                    {fB ? (
                      <a
                        href={`/api/runs/${runIdB}/files/${fB.path}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:underline"
                      >
                        ↗ view
                      </a>
                    ) : (
                      <span className="text-red-400">missing</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Produced artifact types */}
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
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {bArt ? (
                      <span className={bArt.resolved ? "text-green-400" : "text-gray-500"}>
                        {bArt.resolved ? "✓ resolved" : "not resolved"}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
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

// ── ViewerPanel ───────────────────────────────────────────────────────────────

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

// ── Run selector ──────────────────────────────────────────────────────────────

function RunSelector({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number | null;
  options: RunOption[];
  onChange: (id: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400 font-medium">{label}</label>
      <select
        className="rounded border border-white/20 bg-surface-raised text-sm text-gray-200 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">— select a run —</option>
        {options.map(({ run }) => (
          <option key={run.id} value={run.id}>
            Run #{run.id} — {run.pipeline_manifest_id} v{run.pipeline_version}
          </option>
        ))}
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

  const { data: allRuns, isLoading: runsLoading } = useRuns();

  // Results for selected runs
  const { data: resultsA } = useRunResults(runAId ?? 0, runAId !== null);
  const { data: resultsB } = useRunResults(runBId ?? 0, runBId !== null);

  // Load pipeline manifests for all successful runs to build producesCache
  useEffect(() => {
    if (!allRuns) return;
    const successRuns = allRuns.filter((r) => r.status === "success");
    const ids = [...new Set(successRuns.map((r) => r.pipeline_manifest_id))];
    const uncached = ids.filter((id) => !(id in producesCache));
    if (uncached.length === 0) return;
    Promise.all(uncached.map((id) => fetchPipeline(id).catch(() => null)))
      .then((pipelines) => {
        const updates: Record<string, string[]> = {};
        for (const p of pipelines) {
          if (p) updates[p.id] = (p.produces ?? []).map((s) => s.type);
        }
        setProducesCache((prev) => ({ ...prev, ...updates }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRuns]);

  // Build run options: only successful runs with nifti outputs
  const runOptions: RunOption[] = (allRuns ?? [])
    .filter((r) => r.status === "success")
    .map((r) => ({ run: r, producedTypes: producesCache[r.pipeline_manifest_id] ?? [] }))
    .filter((o) => o.producedTypes.some((t) => t.includes("nifti") || t.includes("brain") || t.includes("mask")));

  // When A is selected, B options = runs sharing at least one artifact type with A (different pipeline)
  const runAOption = runOptions.find((o) => o.run.id === runAId);
  const bOptions = runAOption
    ? runOptions.filter(
        (o) =>
          o.run.id !== runAId &&
          o.run.pipeline_manifest_id !== runAOption.run.pipeline_manifest_id &&
          o.producedTypes.some((t) => runAOption.producedTypes.includes(t))
      )
    : runOptions.filter((o) => o.run.id !== runBId);

  const aOptions = runBId
    ? runOptions.filter(
        (o) => {
          const bOpt = runOptions.find((x) => x.run.id === runBId);
          return (
            o.run.id !== runBId &&
            (!bOpt || (
              o.run.pipeline_manifest_id !== bOpt.run.pipeline_manifest_id &&
              o.producedTypes.some((t) => bOpt.producedTypes.includes(t))
            ))
          );
        }
      )
    : runOptions;

  function setRunA(id: number | null) {
    const p = new URLSearchParams(searchParams);
    if (id) p.set("a", String(id)); else p.delete("a");
    setSearchParams(p);
  }

  function setRunB(id: number | null) {
    const p = new URLSearchParams(searchParams);
    if (id) p.set("b", String(id)); else p.delete("b");
    setSearchParams(p);
  }

  // Auto-suggest: when A is selected and B is empty, pick the first compatible B
  useEffect(() => {
    if (runAId && !runBId && bOptions.length === 1) {
      setRunB(bOptions[0].run.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runAId, runBId, bOptions.length]);

  // Linked mode: once both panels ready, call broadcastTo
  const handleNvAReady = useCallback(
    (nv: Niivue) => {
      nvARef.current = nv;
      if (viewMode === "linked" && nvBRef.current) {
        nv.broadcastTo(nvBRef.current);
      }
    },
    [viewMode]
  );

  const handleNvBReady = useCallback(
    (nv: Niivue) => {
      nvBRef.current = nv;
      if (viewMode === "linked" && nvARef.current) {
        nvARef.current.broadcastTo(nv);
      }
    },
    [viewMode]
  );

  // When mode switches to linked, set up broadcast if both are already loaded
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
      ? viewMode === "difference"
        ? buildMaskLayers(resultsA, runAId, "blue")
        : buildLayers(resultsA, runAId)
      : [];

  const layersB: NiivueLayer[] =
    resultsB && runBId
      ? viewMode === "difference"
        ? buildMaskLayers(resultsB, runBId, "red")
        : buildLayers(resultsB, runBId)
      : [];

  const diffNote =
    viewMode === "difference"
      ? "Difference mode: each panel shows one pipeline's brain mask. Blue = Run A only, Red = Run B only, overlap = agreement."
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
              {(
                [
                  { mode: "sidebyside" as const, label: "Side by side" },
                  { mode: "linked" as const, label: "Linked" },
                  { mode: "difference" as const, label: "Difference" },
                ] as const
              ).map(({ mode, label }) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                    viewMode === mode
                      ? "bg-blue-600 text-white shadow-sm"
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
            onChange={setRunA}
          />
          <RunSelector
            label="Run B"
            value={runBId}
            options={bOptions.length > 0 ? bOptions : runOptions.filter((o) => o.run.id !== runAId)}
            onChange={setRunB}
          />
        </div>

        {/* Loading state */}
        {runsLoading && (
          <div className="text-sm text-gray-500">Loading runs…</div>
        )}

        {/* No runs with nifti outputs yet */}
        {!runsLoading && runOptions.length === 0 && (
          <div className="rounded-lg border border-white/10 bg-surface-raised px-5 py-4 text-sm text-gray-400 max-w-xl">
            No completed runs with volumetric outputs found yet. Run BrainChop or SynthStrip on a dcm2niix output first.
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
            {(layersA.length > 0 || layersB.length > 0) && (
              <div>
                <SectionHeading>
                  {viewMode === "sidebyside" && "Side-by-side view"}
                  {viewMode === "linked" && "Linked view — scroll one panel to move both"}
                  {viewMode === "difference" && "Difference view — brain masks overlaid"}
                </SectionHeading>
                {diffNote && (
                  <p className="text-xs text-gray-500 mb-3">{diffNote}</p>
                )}
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

            {/* Metadata comparison */}
            {metaA && metaB && (
              <MetadataComparison
                metaA={metaA}
                metaB={metaB}
                labelA={labelA}
                labelB={labelB}
              />
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
                  <span>
                    Run A traces to run #{metaA.lineage.upstream_run_id} ({metaA.lineage.upstream_pipeline_id}).{" "}
                  </span>
                )}
                {metaB?.lineage && (
                  <span>
                    Run B traces to run #{metaB.lineage.upstream_run_id} ({metaB.lineage.upstream_pipeline_id}).
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
