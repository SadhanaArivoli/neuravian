/**
 * Pure helpers for the Project Dashboard and Artifact Explorer.
 * No React, no API calls — fully testable.
 */

import type { DatasetArtifact, DashboardRecentRun } from "../api/client";

// ── Formatting ────────────────────────────────────────────────────────────────

export function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// SQLite stores UTC datetimes but strips the timezone marker on read.
// Pydantic then serializes them without 'Z', causing JS to misparse as local
// time. Appending 'Z' restores correct UTC interpretation.
export function toUtc(iso: string): Date {
  return new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return toUtc(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function fmtDatetime(iso: string | null): string {
  if (!iso) return "—";
  return toUtc(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - toUtc(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ── Chart data helpers ────────────────────────────────────────────────────────

export interface ChartBar {
  label: string;
  value: number;
  color: string;
}

export function pipelineRuntimeBars(
  byPipeline: Record<string, number>,
): ChartBar[] {
  const entries = Object.entries(byPipeline).sort((a, b) => b[1] - a[1]);
  const colors = [
    "#818cf8", "#34d399", "#f59e0b", "#f87171", "#38bdf8",
    "#a78bfa", "#fb923c", "#4ade80",
  ];
  return entries.map(([label, value], i) => ({
    label,
    value,
    color: colors[i % colors.length],
  }));
}

export function pipelineStorageBars(
  byPipeline: Record<string, number>,
): ChartBar[] {
  const entries = Object.entries(byPipeline).sort((a, b) => b[1] - a[1]);
  const colors = [
    "#818cf8", "#34d399", "#f59e0b", "#f87171", "#38bdf8",
    "#a78bfa", "#fb923c", "#4ade80",
  ];
  return entries.map(([label, value], i) => ({
    label,
    value,
    color: colors[i % colors.length],
  }));
}

// ── Artifact filtering / sorting ──────────────────────────────────────────────

export type ArtifactSortKey =
  | "newest"
  | "oldest"
  | "largest"
  | "smallest"
  | "pipeline"
  | "type";

export interface ArtifactFilters {
  search: string;
  artifactType: string;
  pipeline: string;
  fileKind: "all" | "file" | "directory";
  sortBy: ArtifactSortKey;
}

export const DEFAULT_ARTIFACT_FILTERS: ArtifactFilters = {
  search: "",
  artifactType: "",
  pipeline: "",
  fileKind: "all",
  sortBy: "newest",
};

export function filterArtifacts(
  artifacts: DatasetArtifact[],
  filters: ArtifactFilters,
): DatasetArtifact[] {
  let out = artifacts;

  if (filters.fileKind === "file") {
    out = out.filter((a) => !a.is_directory);
  } else if (filters.fileKind === "directory") {
    out = out.filter((a) => a.is_directory);
  }

  if (filters.artifactType) {
    out = out.filter((a) => a.type === filters.artifactType);
  }

  if (filters.pipeline) {
    out = out.filter((a) => a.pipeline_id === filters.pipeline);
  }

  if (filters.search.trim()) {
    const q = filters.search.trim().toLowerCase();
    out = out.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.type.toLowerCase().includes(q) ||
        a.path.toLowerCase().includes(q) ||
        a.pipeline_id.toLowerCase().includes(q) ||
        (a.atlas_metadata?.atlas ?? "").toLowerCase().includes(q) ||
        (a.atlas_metadata?.atlas_id ?? "").toLowerCase().includes(q) ||
        String(a.run_id).includes(q),
    );
  }

  return sortArtifacts(out, filters.sortBy);
}

export function sortArtifacts(
  artifacts: DatasetArtifact[],
  key: ArtifactSortKey,
): DatasetArtifact[] {
  const out = [...artifacts];
  switch (key) {
    case "newest":
      return out.sort(
        (a, b) =>
          (b.run_finished_at ?? "").localeCompare(a.run_finished_at ?? ""),
      );
    case "oldest":
      return out.sort(
        (a, b) =>
          (a.run_finished_at ?? "").localeCompare(b.run_finished_at ?? ""),
      );
    case "largest":
      return out.sort((a, b) => b.size_bytes - a.size_bytes);
    case "smallest":
      return out.sort((a, b) => a.size_bytes - b.size_bytes);
    case "pipeline":
      return out.sort((a, b) => a.pipeline_id.localeCompare(b.pipeline_id));
    case "type":
      return out.sort((a, b) => a.type.localeCompare(b.type));
  }
}

export function uniqueArtifactTypes(artifacts: DatasetArtifact[]): string[] {
  return [...new Set(artifacts.map((a) => a.type))].sort();
}

export function uniqueArtifactPipelines(artifacts: DatasetArtifact[]): string[] {
  return [...new Set(artifacts.map((a) => a.pipeline_id))].sort();
}

// ── Lineage helpers ───────────────────────────────────────────────────────────

export interface LineageStep {
  kind: "dataset" | "run" | "artifact";
  label: string;
  runId?: number;
  pipeline?: string;
  timestamp?: string | null;
}

export function buildArtifactLineage(
  artifact: DatasetArtifact,
  allRuns: DashboardRecentRun[],
  datasetName: string | null,
): LineageStep[] {
  const steps: LineageStep[] = [];

  steps.push({
    kind: "dataset",
    label: datasetName ?? `Dataset ${artifact.run_id}`,
  });

  // Walk upstream chain via source_run_id
  const runMap = new Map(allRuns.map((r) => [r.id, r]));
  const chain: DashboardRecentRun[] = [];

  const producingRun = runMap.get(artifact.run_id);
  if (!producingRun) {
    steps.push({
      kind: "run",
      label: `Run #${artifact.run_id} (${artifact.pipeline_id})`,
      runId: artifact.run_id,
      pipeline: artifact.pipeline_id,
      timestamp: artifact.run_finished_at,
    });
  } else {
    // Trace upstream
    let current: DashboardRecentRun | undefined = producingRun;
    const visited = new Set<number>();
    while (current?.source_run_id && !visited.has(current.source_run_id)) {
      visited.add(current.id);
      const upstream = runMap.get(current.source_run_id);
      if (upstream) chain.unshift(upstream);
      current = upstream;
    }

    for (const r of chain) {
      steps.push({
        kind: "run",
        label: `Run #${r.id} (${r.pipeline_manifest_id})`,
        runId: r.id,
        pipeline: r.pipeline_manifest_id,
        timestamp: r.finished_at,
      });
    }

    steps.push({
      kind: "run",
      label: `Run #${producingRun.id} (${producingRun.pipeline_manifest_id})`,
      runId: producingRun.id,
      pipeline: producingRun.pipeline_manifest_id,
      timestamp: producingRun.finished_at,
    });
  }

  steps.push({
    kind: "artifact",
    label: artifact.label,
  });

  return steps;
}

// ── File path helpers ─────────────────────────────────────────────────────────

/** Convert an absolute artifact path to a run-relative path for API serving. */
export function artifactRelativePath(artifact: DatasetArtifact): string {
  if (!artifact.output_dir) return artifact.path;
  const prefix = artifact.output_dir.endsWith("/")
    ? artifact.output_dir
    : artifact.output_dir + "/";
  return artifact.path.startsWith(prefix)
    ? artifact.path.slice(prefix.length)
    : artifact.path;
}

/** URL to serve this artifact via the run files API. */
export function artifactFileUrl(artifact: DatasetArtifact): string {
  const rel = artifactRelativePath(artifact);
  return `/api/runs/${artifact.run_id}/files/${rel}`;
}

/** Whether this artifact type can be previewed inline. */
export type PreviewKind =
  | "nifti"
  | "html"
  | "connectivity_matrix"
  | "image"
  | "csv"
  | "tsv"
  | "json"
  | "none";

export function resolvePreviewKind(artifact: DatasetArtifact): PreviewKind {
  if (artifact.is_directory) return "none";
  const p = artifact.path.toLowerCase();
  if (p.endsWith(".nii") || p.endsWith(".nii.gz") || p.endsWith(".mgz"))
    return "nifti";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".png") || p.endsWith(".jpg") || p.endsWith(".jpeg"))
    return "image";
  if (
    artifact.type === "connectivity_matrix_csv" ||
    (p.includes("connectivity_matrix") && p.endsWith(".csv"))
  )
    return "connectivity_matrix";
  if (artifact.type === "roi_statistics_csv" || p.endsWith(".csv")) return "csv";
  if (p.endsWith(".tsv")) return "tsv";
  if (p.endsWith(".json")) return "json";
  return "none";
}
