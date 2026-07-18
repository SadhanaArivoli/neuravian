/**
 * Statistical Map Explorer — /datasets/:id/stat-maps
 *
 * Interactive page for launching the Statistical Map Explorer pipeline,
 * browsing past cluster analysis runs, and comparing results across runs.
 *
 * This page does NOT generate scientific interpretations, infer significance,
 * or apply inferential corrections. All numbers are derived from the NIfTI data.
 */

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useRuns } from "../hooks/useRuns";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClusterRow {
  cluster_id: number;
  size_voxels: number;
  peak_value: number;
  mean_value: number;
  peak_x_mm: number;
  peak_y_mm: number;
  peak_z_mm: number;
  com_x_mm: number;
  com_y_mm: number;
  com_z_mm: number;
}

interface ClusterResult {
  runId: number;
  status: string;
  created_at: string;
  inputFilename?: string;
  threshold?: number;
  direction?: string;
  nClusters?: number;
  largestCluster?: number;
  peakValue?: number;
  clusters: ClusterRow[];
  overlayPath?: string;
  reportPath?: string;
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function fmt(v: number | undefined, dec = 3): string {
  return v == null ? "—" : v.toFixed(dec);
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "success"
      ? "bg-green-500/15 text-green-300"
      : status === "running" || status === "pending"
        ? "bg-amber-500/15 text-amber-300"
        : "bg-red-500/15 text-red-300";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {status}
    </span>
  );
}

// ── Cluster table ─────────────────────────────────────────────────────────────

function ClusterTable({ clusters }: { clusters: ClusterRow[] }) {
  if (clusters.length === 0) {
    return (
      <p className="text-xs text-gray-500 py-2">No clusters detected above threshold.</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-white/8 text-gray-500">
            <th className="py-1.5 pr-3 text-left font-medium">#</th>
            <th className="py-1.5 pr-3 text-right font-medium">Voxels</th>
            <th className="py-1.5 pr-3 text-right font-medium">Peak</th>
            <th className="py-1.5 pr-3 text-right font-medium">Mean</th>
            <th className="py-1.5 pr-3 text-right font-medium">X (mm)</th>
            <th className="py-1.5 pr-3 text-right font-medium">Y (mm)</th>
            <th className="py-1.5 pr-3 text-right font-medium">Z (mm)</th>
          </tr>
        </thead>
        <tbody>
          {clusters.map((c) => (
            <tr key={c.cluster_id} className="border-b border-white/4 hover:bg-white/4">
              <td className="py-1.5 pr-3 text-gray-400">{c.cluster_id}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-300">
                {c.size_voxels.toLocaleString()}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-gray-200">
                {fmt(c.peak_value)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-400">
                {fmt(c.mean_value)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-400">
                {fmt(c.peak_x_mm, 1)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-400">
                {fmt(c.peak_y_mm, 1)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-400">
                {fmt(c.peak_z_mm, 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Run card ──────────────────────────────────────────────────────────────────

function RunCard({
  result,
  expanded,
  onToggle,
}: {
  result: ClusterResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-white/8 bg-surface-raised overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-white/4 transition-colors"
      >
        <span className="text-gray-500 text-xs font-mono">Run #{result.runId}</span>
        <StatusBadge status={result.status} />
        {result.nClusters != null && (
          <span className="text-xs text-gray-400">
            {result.nClusters} cluster{result.nClusters !== 1 ? "s" : ""}
          </span>
        )}
        {result.threshold != null && (
          <span className="text-xs text-gray-500">
            |z| ≥ {result.threshold} · {result.direction ?? "positive"}
          </span>
        )}
        <span className="ml-auto text-[10px] text-gray-600">
          {new Date(result.created_at).toLocaleString()}
        </span>
        <span className="text-gray-600 text-xs">{expanded ? "▲" : "▼"}</span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-white/8 px-4 py-3 space-y-3">
          {/* Summary stats */}
          {result.status === "success" && (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              {[
                ["Clusters", String(result.nClusters ?? "—")],
                ["Largest", result.largestCluster ? `${result.largestCluster} vox` : "—"],
                ["Peak value", fmt(result.peakValue)],
                ["Threshold", result.threshold != null ? String(result.threshold) : "—"],
                ["Direction", result.direction ?? "—"],
              ].map(([label, val]) => (
                <div key={label} className="rounded bg-white/4 px-3 py-2">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</p>
                  <p className="text-sm font-semibold text-gray-200 font-mono">{val}</p>
                </div>
              ))}
            </div>
          )}

          {/* Overlay figure */}
          {result.overlayPath && (
            <img
              src={`/api/runs/${result.runId}/files/cluster_overlay.png`}
              alt="Cluster overlay"
              className="w-full max-h-[260px] object-contain rounded border border-white/8"
            />
          )}

          {/* Cluster table */}
          {result.status === "success" && (
            <ClusterTable clusters={result.clusters} />
          )}

          {/* Links */}
          <div className="flex flex-wrap gap-4 pt-1 text-xs">
            <Link
              to={`/runs/${result.runId}`}
              className="text-accent hover:underline"
            >
              Full run details →
            </Link>
            {result.reportPath && (
              <a
                href={`/api/runs/${result.runId}/files/cluster_report.html`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                Cluster report ↗
              </a>
            )}
            <a
              href={`/api/runs/${result.runId}/files/cluster_table.csv`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-300"
            >
              ↓ CSV
            </a>
            <a
              href={`/api/runs/${result.runId}/files/cluster_table.json`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-300"
            >
              ↓ JSON
            </a>
          </div>

          <p className="text-[10px] text-gray-600 pt-1">
            No AI-generated scientific interpretation is included.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StatisticalMapExplorer() {
  const { id } = useParams<{ id: string }>();
  const datasetId = Number(id);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Fetch all runs, filter to this dataset + statistical-map-explorer
  const { data: allRuns, isLoading } = useRuns();
  const smRuns = (allRuns ?? []).filter(
    (r: { dataset_id?: number; pipeline_manifest_id?: string }) =>
      r.dataset_id === datasetId &&
      r.pipeline_manifest_id === "statistical-map-explorer"
  );

  // Fetch cluster results for each run
  const runIds = smRuns.map((r: { id: number }) => r.id);
  const { data: results, isLoading: loadingResults } = useQuery<ClusterResult[]>({
    queryKey: ["stat-map-results", runIds.join(",")],
    queryFn: async () => {
      const out: ClusterResult[] = [];
      for (const run of smRuns) {
        try {
          const res: {
            cluster_files?: Array<{ name: string; path: string }>;
          } = await fetch(`/api/runs/${run.id}/results`).then((r) => r.json());

          const clusterFiles: Array<{ name: string; path: string }> = res.cluster_files ?? [];
          const jsonFile = clusterFiles.find((f) => f.name === "cluster_table");
          const overlayFile = clusterFiles.find((f) => f.name === "cluster_overlay");
          const reportFile = clusterFiles.find((f) => f.name === "cluster_report");

          let clusters: ClusterRow[] = [];
          let threshold: number | undefined;
          let direction: string | undefined;
          let nClusters: number | undefined;

          if (jsonFile && run.status === "success") {
            try {
              const table: {
                clusters: ClusterRow[];
                metadata?: {
                  threshold?: number;
                  direction?: string;
                  n_clusters?: number;
                };
              } = await fetch(`/api/runs/${run.id}/files/${jsonFile.path}`).then((r) => r.json());
              clusters = table.clusters ?? [];
              threshold = table.metadata?.threshold;
              direction = table.metadata?.direction;
              nClusters = table.metadata?.n_clusters ?? clusters.length;
            } catch {
              // cluster table unavailable
            }
          }

          out.push({
            runId: run.id,
            status: run.status,
            created_at: run.created_at,
            threshold,
            direction,
            nClusters,
            largestCluster: clusters[0]?.size_voxels,
            peakValue: clusters[0] ? Math.abs(clusters[0].peak_value) : undefined,
            clusters,
            overlayPath: overlayFile?.path,
            reportPath: reportFile?.path,
          });
        } catch {
          out.push({
            runId: run.id,
            status: run.status ?? "unknown",
            created_at: run.created_at,
            clusters: [],
          });
        }
      }
      return out;
    },
    enabled: runIds.length > 0,
    staleTime: 30_000,
  });

  const loading = isLoading || loadingResults;
  const displayResults = results ?? [];

  return (
    <div className="p-6 max-w-3xl space-y-6">
      {/* Page header */}
      <div>
        <Link
          to={`/datasets/${datasetId}`}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          ← Dataset
        </Link>
        <h1 className="text-2xl font-semibold mt-1">Statistical Map Explorer</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          Threshold, cluster, and summarise statistical NIfTI maps.
          Supports z-maps, t-maps, beta maps, contrast maps, and seed connectivity maps.
        </p>
      </div>

      {/* Quick launch card */}
      <div className="rounded-lg border border-white/8 bg-surface-raised p-4">
        <h3 className="text-sm font-semibold mb-1">Run cluster analysis</h3>
        <p className="text-xs text-gray-400 mb-3">
          Launch the Statistical Map Explorer pipeline from the Workflow Builder
          or from a compatible run's output.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            to={`/workflows/new?dataset=${datasetId}&template=seed-fc-cluster`}
            className="rounded-md bg-accent/90 hover:bg-accent px-3 py-1.5 text-xs font-medium text-white"
          >
            Seed FC → Cluster workflow
          </Link>
          <Link
            to={`/workflows/new?dataset=${datasetId}`}
            className="rounded-md border border-white/10 hover:bg-white/8 px-3 py-1.5 text-xs text-gray-300"
          >
            Open Workflow Builder
          </Link>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="rounded-md border border-white/8 bg-white/3 px-4 py-2 text-[11px] text-gray-500">
        No inferential statistics, random field theory, or permutation testing are applied.
        Threshold selection is at the investigator's discretion. All values are derived
        directly from the NIfTI data without AI-generated interpretation.
      </div>

      {/* Results list */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
          Cluster analysis runs ({smRuns.length})
        </h3>

        {loading && (
          <p className="text-sm text-gray-400 animate-pulse">Loading runs…</p>
        )}

        {!loading && smRuns.length === 0 && (
          <div className="rounded-lg border border-white/8 bg-surface-raised px-4 py-6 text-center text-sm text-gray-500">
            No Statistical Map Explorer runs yet for this dataset.
            <br />
            <span className="text-xs text-gray-600 mt-1 block">
              Launch the pipeline from the Workflow Builder above.
            </span>
          </div>
        )}

        <div className="space-y-3">
          {displayResults.map((result) => (
            <RunCard
              key={result.runId}
              result={result}
              expanded={expandedId === result.runId}
              onToggle={() =>
                setExpandedId((prev) =>
                  prev === result.runId ? null : result.runId
                )
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
