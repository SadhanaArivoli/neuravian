import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { cancelRun, fetchRunFile, fetchRunTextFile, retryRun, rerunRun } from "../../api/client";
import { useRunFile, useRunResults, useRuns } from "../../hooks/useRuns";
import NiivueViewer, { type NiivueLayer } from "./NiivueViewer";
import RunMetadataPanel from "./RunMetadataPanel";
import RunNextCard from "./RunNextCard";
import { detectRunFamily, findCompatibleConnectivityRun, findVerifiedSibling } from "../../lib/comparisonEligibility";
import { parseConnectivityMatrixCsv, type ConnectivityMatrixData } from "../../lib/connectivityMatrix";
import {
  filterRoiStatistics,
  normalizeRoiStatisticsJson,
  parseRoiStatisticsCsv,
  roiStatisticsToCsv,
  sortRoiStatistics,
  type RoiSortKey,
  type RoiStatistic,
  type SortDirection,
} from "../../lib/roiStatistics";

// Key T1w IQMs with friendly labels and descriptions.
// Shown in the summary card; the full set is in the MRIQC HTML report.
const T1W_METRICS: Array<{
  key: string;
  label: string;
  desc: string;
  precision: number;
  unit?: string;
}> = [
  { key: "snr_total", label: "SNR", desc: "Signal-to-noise ratio (higher = better)", precision: 2 },
  { key: "cnr", label: "CNR", desc: "Contrast-to-noise ratio, GM vs WM (higher = better)", precision: 2 },
  { key: "cjv", label: "CJV", desc: "Coefficient of joint variation (lower = better)", precision: 3 },
  { key: "efc", label: "EFC", desc: "Entropy focus criterion — image sharpness (lower = better)", precision: 4 },
  { key: "fber", label: "FBER", desc: "Foreground-background energy ratio (higher = better)", precision: 1 },
  { key: "fwhm_avg", label: "FWHM", desc: "Estimated smoothness (voxels)", precision: 2, unit: "vox" },
];

const TISSUE_METRICS: Array<{ key: string; label: string }> = [
  { key: "icvs_gm", label: "GM" },
  { key: "icvs_wm", label: "WM" },
  { key: "icvs_csf", label: "CSF" },
];

interface IqmData {
  bids_meta?: Record<string, unknown>;
  provenance?: { software?: string; version?: string };
  [key: string]: unknown;
}

function IqmCard({ data }: { data: IqmData }) {
  const version = data.provenance?.version ?? "unknown";

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-800">Image Quality Metrics</h3>
        <span className="text-xs text-gray-400">MRIQC {version}</span>
      </div>

      {/* Key scalar metrics */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {T1W_METRICS.map(({ key, label, desc, precision, unit }) => {
          const val = data[key];
          if (val === undefined || val === null) return null;
          return (
            <div key={key} className="rounded bg-gray-50 p-2.5" title={desc}>
              <div className="text-xs text-gray-500 mb-0.5">{label}</div>
              <div className="text-sm font-semibold text-gray-900 font-mono">
                {(val as number).toFixed(precision)}
                {unit && <span className="text-xs text-gray-400 ml-0.5">{unit}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Tissue volume fractions */}
      {TISSUE_METRICS.some(({ key }) => data[key] !== undefined) && (
        <div className="border-t border-gray-100 pt-3">
          <p className="text-xs text-gray-500 mb-2">Intracranial volume fractions</p>
          <div className="flex gap-3">
            {TISSUE_METRICS.map(({ key, label }) => {
              const val = data[key] as number | undefined;
              if (val === undefined) return null;
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-500">{label}</span>
                  <span className="text-xs font-semibold text-gray-800 font-mono">
                    {(val * 100).toFixed(1)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-gray-400">
        Hover metric names for descriptions. Full plots and details in the report below.
      </p>
    </div>
  );
}

interface GroupTableSummary {
  headers: string[];
  rows: Record<string, string>[];
  subjectCount: number;
  modalityCount: number;
  missingCount: number;
}

function parseTsv(text: string): GroupTableSummary | null {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
  const subjectKeys = ["bids_name", "subject_id", "subject", "sub"];
  const subjectKey = subjectKeys.find((key) => headers.includes(key));
  const subjects = new Set(
    rows
      .map((row) => (subjectKey ? row[subjectKey] : ""))
      .filter(Boolean),
  );
  const modalities = new Set(rows.map((row) => row.modality ?? row.suffix ?? "").filter(Boolean));
  const missingCount = rows.reduce(
    (count, row) => count + headers.filter((header) => row[header] === "" || row[header] === "n/a").length,
    0,
  );
  return {
    headers,
    rows,
    subjectCount: subjects.size || rows.length,
    modalityCount: modalities.size,
    missingCount,
  };
}

const PREFERRED_GROUP_COLUMNS = [
  "bids_name",
  "subject_id",
  "modality",
  "snr_total",
  "cnr",
  "cjv",
  "efc",
  "fber",
  "fwhm_avg",
];

function MriqcGroupSummary({ runId, tablePath }: { runId: number; tablePath: string }) {
  const [summary, setSummary] = useState<GroupTableSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError(null);
    fetchRunTextFile(runId, tablePath)
      .then((text) => {
        if (!cancelled) setSummary(parseTsv(text));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load group table.");
      });
    return () => {
      cancelled = true;
    };
  }, [runId, tablePath]);

  const columns = useMemo(() => {
    if (!summary) return [];
    const preferred = PREFERRED_GROUP_COLUMNS.filter((column) => summary.headers.includes(column));
    return preferred.length > 0 ? preferred.slice(0, 7) : summary.headers.slice(0, 7);
  }, [summary]);

  if (error) {
    return (
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        MRIQC group table is available for download, but the preview could not be loaded: {error}
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500">
        Loading MRIQC group table…
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">MRIQC Group Summary</h3>
          <p className="text-xs text-gray-500">Official aggregate IQM table preview.</p>
        </div>
        <a
          href={`/api/runs/${runId}/files/${tablePath}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          Open TSV
        </a>
      </div>
      <div className="mb-3 grid grid-cols-4 gap-2">
        <div className="rounded bg-gray-50 p-2">
          <div className="text-xs text-gray-500">Rows</div>
          <div className="font-mono text-sm font-semibold text-gray-900">{summary.rows.length}</div>
        </div>
        <div className="rounded bg-gray-50 p-2">
          <div className="text-xs text-gray-500">Subjects</div>
          <div className="font-mono text-sm font-semibold text-gray-900">{summary.subjectCount}</div>
        </div>
        <div className="rounded bg-gray-50 p-2">
          <div className="text-xs text-gray-500">Modalities</div>
          <div className="font-mono text-sm font-semibold text-gray-900">{summary.modalityCount || "—"}</div>
        </div>
        <div className="rounded bg-gray-50 p-2">
          <div className="text-xs text-gray-500">Missing values</div>
          <div className="font-mono text-sm font-semibold text-gray-900">{summary.missingCount}</div>
        </div>
      </div>
      <div className="overflow-x-auto rounded border border-gray-100">
        <table className="min-w-full divide-y divide-gray-100 text-left text-xs">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              {columns.map((column) => (
                <th key={column} className="whitespace-nowrap px-3 py-2 font-medium">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 text-gray-700">
            {summary.rows.slice(0, 8).map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column} className="whitespace-nowrap px-3 py-2 font-mono">
                    {row[column] || "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ConnectivityMetadata {
  atlas?: string;
  atlas_id?: string;
  atlas_source?: string;
  atlas_version?: string | null;
  atlas_type?: string;
  atlas_space?: string;
  atlas_resolution?: string;
  atlas_network_count?: number | null;
  correlation_method?: string;
  nilearn_version?: string;
  n_rois?: number;
  roi_count?: number;
  n_volumes?: number;
  matrix_shape?: [number, number];
  correlation_min?: number;
  correlation_max?: number;
  correlation_mean?: number;
  roi_labels?: string[];
}

function MatrixCanvas({ labels, matrix }: { labels: string[]; matrix: number[][] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<{ row: number; col: number; value: number } | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = matrix.length;
    const cell = Math.max(2, Math.floor((520 * zoom) / Math.max(1, size)));
    canvas.width = size * cell;
    canvas.height = size * cell;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = Math.max(-1, Math.min(1, matrix[y][x] ?? 0));
        const t = (value + 1) / 2;
        const r = Math.round(37 + t * 210);
        const g = Math.round(99 + (1 - Math.abs(t - 0.5) * 2) * 90);
        const b = Math.round(235 - t * 190);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }, [matrix, zoom]);

  function handleMove(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor(((event.clientX - rect.left) / rect.width) * matrix.length);
    const row = Math.floor(((event.clientY - rect.top) / rect.height) * matrix.length);
    if (row >= 0 && col >= 0 && row < matrix.length && col < matrix.length) {
      setHover({ row, col, value: matrix[row][col] });
    }
  }

  function exportPng() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = "connectivity_matrix_view.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500">
          {hover
            ? `${labels[hover.row] ?? `ROI ${hover.row + 1}`} × ${labels[hover.col] ?? `ROI ${hover.col + 1}`} = ${hover.value.toFixed(3)}`
            : "Hover matrix cells to inspect ROI pairs."}
        </p>
        <button
          type="button"
          onClick={exportPng}
          className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          Export PNG
        </button>
      </div>
      <label className="mt-2 flex max-w-xs items-center gap-2 text-xs text-gray-500">
        Zoom
        <input
          type="range"
          min="1"
          max="4"
          step="0.25"
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
          className="flex-1"
        />
        <span className="w-10 text-right font-mono">{zoom.toFixed(2)}×</span>
      </label>
      <div className="mt-3 max-h-[560px] overflow-auto rounded border border-gray-200 bg-gray-50 p-3">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
          className="block max-w-none"
          style={{ imageRendering: "pixelated" }}
        />
      </div>
    </div>
  );
}

interface SeedConnectivityMetadata {
  pipeline?: string;
  atlas?: string;
  atlas_id?: string;
  atlas_citation?: string;
  atlas_source?: string;
  atlas_resolution?: string;
  seed_roi_index?: number;
  seed_label?: string;
  correlation_method?: string;
  nilearn_version?: string;
  n_volumes?: number;
  n_rois?: number;
  z_min?: number;
  z_max?: number;
  z_mean?: number;
  runtime_seconds?: number;
}

function SeedConnectivityPanel({
  runId,
  metadataPath,
  imagePath,
  timeseriesPath,
}: {
  runId: number;
  metadataPath?: string;
  imagePath?: string;
  timeseriesPath?: string;
}) {
  const [metadata, setMetadata] = useState<SeedConnectivityMetadata | null>(null);

  useEffect(() => {
    if (!metadataPath) return;
    let cancelled = false;
    fetchRunFile<SeedConnectivityMetadata>(runId, metadataPath)
      .then((json) => { if (!cancelled) setMetadata(json); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [runId, metadataPath]);

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Seed-Based Connectivity Map</h3>
          <p className="text-xs text-gray-500">
            {metadata?.atlas ?? "Atlas-based"} · {metadata?.correlation_method ?? "Pearson correlation (Fisher z-transformed)"}
          </p>
        </div>
        {imagePath && (
          <a
            href={`/api/runs/${runId}/files/${imagePath}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline"
          >
            Open PNG
          </a>
        )}
      </div>
      {metadata && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Seed ROI", metadata.seed_roi_index ?? "—"],
            ["Seed label", metadata.seed_label?.slice(0, 24) ?? "—"],
            ["Volumes", metadata.n_volumes ?? "—"],
            ["Atlas ROIs", metadata.n_rois ?? "—"],
            ["Min z", metadata.z_min?.toFixed(3) ?? "—"],
            ["Max z", metadata.z_max?.toFixed(3) ?? "—"],
            ["Mean z", metadata.z_mean?.toFixed(3) ?? "—"],
            ["Resolution", metadata.atlas_resolution ?? "—"],
          ].map(([label, value]) => (
            <div key={label} className="rounded bg-gray-50 p-2">
              <div className="text-xs text-gray-500">{label}</div>
              <div className="font-mono text-sm font-semibold text-gray-900" title={String(value)}>{value}</div>
            </div>
          ))}
        </div>
      )}
      {metadata?.atlas_citation && (
        <p className="mb-3 text-xs text-gray-500">
          Atlas: {metadata.atlas_citation}
          {metadata.atlas_source && (
            <> · <a href={metadata.atlas_source} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">Reference</a></>
          )}
        </p>
      )}
      {imagePath ? (
        <img
          src={`/api/runs/${runId}/files/${imagePath}`}
          alt="Seed connectivity map"
          className="max-h-[320px] w-full rounded border border-gray-200 object-contain"
        />
      ) : (
        <div className="rounded border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
          Connectivity map PNG not found.
        </div>
      )}
      {timeseriesPath && (
        <div className="mt-2">
          <a
            href={`/api/runs/${runId}/files/${timeseriesPath}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline"
          >
            Download seed time series TSV
          </a>
        </div>
      )}
    </div>
  );
}

// ── Group FC panel ─────────────────────────────────────────────────────────────

interface GroupFCSummary {
  pipeline?: string;
  n_runs?: number;
  atlas?: string;
  atlas_id?: string;
  atlas_citation?: string;
  n_rois?: number;
  correlation_method?: string;
  nilearn_version?: string;
  mean_z_min?: number;
  mean_z_max?: number;
  mean_z_mean?: number;
  mean_z_std?: number;
  std_z_max?: number;
  warnings?: string[];
  runtime_seconds?: number;
}

function GroupFCPanel({
  runId,
  summary,
  images,
}: {
  runId: number;
  summary: GroupFCSummary;
  images: Array<{ name: string; path: string }>;
}) {
  const meanHeatmap = images.find((f) => f.name.includes("mean") && f.name.includes("heatmap"));
  const stdHeatmap = images.find((f) => f.name.includes("std") && f.name.includes("heatmap"));

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Group Functional Connectivity</h3>
          <p className="text-xs text-gray-500">
            {summary.atlas ?? "Unknown atlas"} · {summary.n_runs ?? "?"} runs aggregated
          </p>
        </div>
        <a
          href={`/api/runs/${runId}/files/group_report.html`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          View report
        </a>
      </div>

      {summary.warnings && summary.warnings.length > 0 && (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs font-semibold text-amber-800 mb-1">Compatibility warnings</p>
          <ul className="list-disc list-inside space-y-0.5">
            {summary.warnings.map((w, i) => (
              <li key={i} className="text-xs text-amber-700">{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Runs", summary.n_runs ?? "—"],
          ["ROIs", summary.n_rois ?? "—"],
          ["Mean min z", summary.mean_z_min?.toFixed(3) ?? "—"],
          ["Mean max z", summary.mean_z_max?.toFixed(3) ?? "—"],
          ["Mean avg z", summary.mean_z_mean?.toFixed(3) ?? "—"],
          ["Mean std z", summary.mean_z_std?.toFixed(3) ?? "—"],
          ["Max std", summary.std_z_max?.toFixed(3) ?? "—"],
          ["Nilearn", summary.nilearn_version ?? "—"],
        ].map(([label, value]) => (
          <div key={label} className="rounded bg-gray-50 p-2">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="font-mono text-sm font-semibold text-gray-900">{value}</div>
          </div>
        ))}
      </div>

      {summary.atlas_citation && (
        <p className="mb-3 text-xs text-gray-500">Atlas: {summary.atlas_citation}</p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {meanHeatmap && (
          <div>
            <p className="mb-1 text-xs font-medium text-gray-600">Group mean matrix</p>
            <img
              src={`/api/runs/${runId}/files/${meanHeatmap.path}`}
              alt="Group mean connectivity heatmap"
              className="w-full rounded border border-gray-200 object-contain"
            />
          </div>
        )}
        {stdHeatmap && (
          <div>
            <p className="mb-1 text-xs font-medium text-gray-600">Across-run std matrix</p>
            <img
              src={`/api/runs/${runId}/files/${stdHeatmap.path}`}
              alt="Group std connectivity heatmap"
              className="w-full rounded border border-gray-200 object-contain"
            />
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
        <a
          href={`/api/runs/${runId}/files/group_mean_connectivity_matrix.csv`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          Download mean matrix CSV
        </a>
        <a
          href={`/api/runs/${runId}/files/group_std_connectivity_matrix.csv`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          Download std matrix CSV
        </a>
        <a
          href={`/api/runs/${runId}/files/group_mean_connectivity_matrix.npy`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          Download mean matrix NPY
        </a>
      </div>
    </div>
  );
}

function ConnectivitySummary({
  runId,
  matrixPath,
  metadataPath,
  imagePath,
}: {
  runId: number;
  matrixPath: string;
  metadataPath?: string;
  imagePath?: string;
}) {
  const [matrixData, setMatrixData] = useState<ConnectivityMatrixData | null>(null);
  const [metadata, setMetadata] = useState<ConnectivityMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchRunTextFile(runId, matrixPath)
      .then((text) => {
        if (!cancelled) setMatrixData(parseConnectivityMatrixCsv(text));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load connectivity matrix.");
      });
    if (metadataPath) {
      fetchRunFile<ConnectivityMetadata>(runId, metadataPath)
        .then((json) => {
          if (!cancelled) setMetadata(json);
        })
        .catch(() => {
          if (!cancelled) setMetadata(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [runId, matrixPath, metadataPath]);

  if (error) {
    return (
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Connectivity outputs are available, but the matrix preview could not load: {error}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Connectivity Matrix</h3>
          <p className="text-xs text-gray-500">
            {metadata?.atlas ?? "Atlas-based"} · {metadata?.correlation_method ?? "Pearson correlation"}
          </p>
        </div>
        <a
          href={`/api/runs/${runId}/files/${matrixPath}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          Open CSV
        </a>
      </div>
      {metadata && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["ROIs", metadata.n_rois ?? metadata.roi_count ?? "—"],
            ["Matrix", metadata.matrix_shape?.join("×") ?? "—"],
            ["Volumes", metadata.n_volumes ?? "—"],
            ["Networks", metadata.atlas_network_count ?? "—"],
            ["Min r", metadata.correlation_min?.toFixed(3) ?? "—"],
            ["Max r", metadata.correlation_max?.toFixed(3) ?? "—"],
            ["Atlas type", metadata.atlas_type ?? "—"],
            ["Space", metadata.atlas_space ?? "—"],
          ].map(([label, value]) => (
            <div key={label} className="rounded bg-gray-50 p-2">
              <div className="text-xs text-gray-500">{label}</div>
              <div className="font-mono text-sm font-semibold text-gray-900" title={String(value)}>{value}</div>
            </div>
          ))}
        </div>
      )}
      {metadata?.atlas_source && (
        <p className="mb-3 text-xs text-gray-500">
          Atlas source:{" "}
          <a
            href={metadata.atlas_source}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            {metadata.atlas_version ?? metadata.atlas_id ?? "Nilearn atlas fetcher"}
          </a>
        </p>
      )}
      {matrixData ? (
        <MatrixCanvas labels={matrixData.labels} matrix={matrixData.values} />
      ) : imagePath ? (
        <img
          src={`/api/runs/${runId}/files/${imagePath}`}
          alt="Connectivity heatmap"
          className="max-h-[560px] rounded border border-gray-200 object-contain"
        />
      ) : (
        <div className="rounded border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
          Loading connectivity matrix…
        </div>
      )}
    </div>
  );
}

const ROI_SORT_OPTIONS: Array<{ key: RoiSortKey; label: string }> = [
  { key: "roi_number", label: "ROI #" },
  { key: "roi_label", label: "Label" },
  { key: "network", label: "Network" },
  { key: "voxel_count", label: "Voxels" },
  { key: "mean_signal", label: "Mean" },
  { key: "std_signal", label: "Std" },
  { key: "min_signal", label: "Min" },
  { key: "max_signal", label: "Max" },
  { key: "median_signal", label: "Median" },
];

function formatStat(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(4);
}

function RoiStatisticsPanel({
  runId,
  roiFiles,
  metadataPath,
  matrixPath,
}: {
  runId: number;
  roiFiles: RunResultFile[];
  metadataPath?: string;
  matrixPath?: string;
}) {
  const jsonFile = roiFiles.find((file) => file.path.endsWith(".json"));
  const csvFile = roiFiles.find((file) => file.path.endsWith(".csv"));
  const [rows, setRows] = useState<RoiStatistic[]>([]);
  const [metadata, setMetadata] = useState<ConnectivityMetadata | null>(null);
  const [matrixData, setMatrixData] = useState<ConnectivityMatrixData | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState("");
  const [sortKey, setSortKey] = useState<RoiSortKey>("roi_number");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setRows([]);
    const loadRows = jsonFile
      ? fetchRunFile<unknown>(runId, jsonFile.path).then(normalizeRoiStatisticsJson)
      : csvFile
        ? fetchRunTextFile(runId, csvFile.path).then(parseRoiStatisticsCsv)
        : Promise.resolve([]);
    loadRows
      .then((loaded) => {
        if (!cancelled) {
          setRows(loaded);
          setSelectedNumber(loaded[0]?.roi_number ?? null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load ROI statistics.");
      });
    if (metadataPath) {
      fetchRunFile<ConnectivityMetadata>(runId, metadataPath)
        .then((json) => {
          if (!cancelled) setMetadata(json);
        })
        .catch(() => {
          if (!cancelled) setMetadata(null);
        });
    }
    if (matrixPath) {
      fetchRunTextFile(runId, matrixPath)
        .then((text) => {
          if (!cancelled) setMatrixData(parseConnectivityMatrixCsv(text));
        })
        .catch(() => {
          if (!cancelled) setMatrixData(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [runId, jsonFile?.path, csvFile?.path, metadataPath, matrixPath]);

  const networks = useMemo(
    () => [...new Set(rows.map((row) => row.network ?? "Unassigned"))].sort(),
    [rows],
  );
  const visibleRows = useMemo(
    () => sortRoiStatistics(filterRoiStatistics(rows, query, network), sortKey, sortDirection),
    [rows, query, network, sortKey, sortDirection],
  );
  const selected = visibleRows.find((row) => row.roi_number === selectedNumber) ?? visibleRows[0] ?? null;
  const selectedIndex = selected ? rows.findIndex((row) => row.roi_number === selected.roi_number) : -1;
  const associatedConnectivity = useMemo(() => {
    if (!matrixData || selectedIndex < 0) return [];
    return matrixData.values[selectedIndex]
      ?.map((value, index) => ({
        label: matrixData.labels[index] ?? `ROI ${index + 1}`,
        value,
      }))
      .filter((_, index) => index !== selectedIndex)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 6) ?? [];
  }, [matrixData, selectedIndex]);

  function handleSort(nextKey: RoiSortKey) {
    if (nextKey === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(nextKey);
      setSortDirection(nextKey === "roi_label" || nextKey === "network" ? "asc" : "desc");
    }
  }

  function exportCsv() {
    const blob = new Blob([roiStatisticsToCsv(visibleRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "roi_statistics_filtered.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  if (error) {
    return (
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        ROI statistics are available, but the preview could not load: {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
        Loading ROI statistics…
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">ROI Statistics</h3>
          <p className="text-xs text-gray-500">
            {metadata?.atlas ?? "Atlas"} · {rows.length} ROIs · descriptive time-series summaries
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {csvFile && (
            <a
              href={`/api/runs/${runId}/files/${csvFile.path}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline"
            >
              Open CSV
            </a>
          )}
          <button
            type="button"
            onClick={exportCsv}
            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            Export filtered CSV
          </button>
        </div>
      </div>

      <div className="mb-3 grid gap-2 md:grid-cols-[1fr_180px_180px]">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search ROI label, number, or network"
          className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400"
        />
        <select
          value={network}
          onChange={(event) => setNetwork(event.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-900"
        >
          <option value="">All networks</option>
          {networks.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <select
          value={`${sortKey}:${sortDirection}`}
          onChange={(event) => {
            const [key, direction] = event.target.value.split(":") as [RoiSortKey, SortDirection];
            setSortKey(key);
            setSortDirection(direction);
          }}
          className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-900"
        >
          {ROI_SORT_OPTIONS.flatMap(({ key, label }) => [
            <option key={`${key}:asc`} value={`${key}:asc`}>{label} ↑</option>,
            <option key={`${key}:desc`} value={`${key}:desc`}>{label} ↓</option>,
          ])}
        </select>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="max-h-[520px] overflow-auto rounded border border-gray-200">
          <table className="min-w-full divide-y divide-gray-100 text-left text-xs">
            <thead className="sticky top-0 bg-gray-50 text-gray-500">
              <tr>
                {ROI_SORT_OPTIONS.map(({ key, label }) => (
                  <th key={key} className="whitespace-nowrap px-3 py-2 font-medium">
                    <button
                      type="button"
                      onClick={() => handleSort(key)}
                      className="flex items-center gap-1 hover:text-gray-900"
                    >
                      {label}
                      {sortKey === key && <span>{sortDirection === "asc" ? "↑" : "↓"}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-gray-700">
              {visibleRows.map((row) => (
                <tr
                  key={row.roi_number}
                  onClick={() => setSelectedNumber(row.roi_number)}
                  className={`cursor-pointer transition-colors hover:bg-blue-50 ${
                    selected?.roi_number === row.roi_number ? "bg-blue-50" : ""
                  }`}
                >
                  <td className="px-3 py-2 font-mono">{row.roi_number}</td>
                  <td className="max-w-[280px] truncate px-3 py-2" title={row.roi_label}>{row.roi_label}</td>
                  <td className="px-3 py-2">{row.network ?? "—"}</td>
                  <td className="px-3 py-2 font-mono">{row.voxel_count}</td>
                  <td className="px-3 py-2 font-mono">{formatStat(row.mean_signal)}</td>
                  <td className="px-3 py-2 font-mono">{formatStat(row.std_signal)}</td>
                  <td className="px-3 py-2 font-mono">{formatStat(row.min_signal)}</td>
                  <td className="px-3 py-2 font-mono">{formatStat(row.max_signal)}</td>
                  <td className="px-3 py-2 font-mono">{formatStat(row.median_signal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleRows.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-gray-500">No ROIs match the current search.</div>
          )}
        </div>

        <aside className="rounded border border-gray-200 bg-gray-50 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Region Explorer</h4>
          {selected ? (
            <div className="mt-3 space-y-3 text-xs text-gray-700">
              <div>
                <div className="text-sm font-semibold text-gray-900">{selected.roi_label}</div>
                <div className="text-gray-500">
                  ROI {selected.roi_number} · {metadata?.atlas ?? metadata?.atlas_id ?? "Atlas"}
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-2">
                {[
                  ["Network", selected.network ?? "—"],
                  ["Voxels", String(selected.voxel_count)],
                  ["Mean", formatStat(selected.mean_signal)],
                  ["Std", formatStat(selected.std_signal)],
                  ["Min", formatStat(selected.min_signal)],
                  ["Max", formatStat(selected.max_signal)],
                  ["Median", formatStat(selected.median_signal)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded bg-white px-2 py-1.5">
                    <dt className="text-[10px] uppercase tracking-wide text-gray-400">{label}</dt>
                    <dd className="font-mono text-gray-800">{value}</dd>
                  </div>
                ))}
              </dl>
              {associatedConnectivity.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-gray-400">
                    Strongest connectivity row values
                  </div>
                  <ul className="space-y-1">
                    {associatedConnectivity.map((entry) => (
                      <li key={entry.label} className="flex justify-between gap-2 rounded bg-white px-2 py-1">
                        <span className="truncate" title={entry.label}>{entry.label}</span>
                        <span className="font-mono">{entry.value.toFixed(4)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-3 text-xs text-gray-500">Select an ROI row to inspect region details.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

interface RunResultFile {
  name: string;
  path: string;
}

interface LayerPairSpec {
  /** Human-readable label shown in the hint line below the file list. */
  label: string;
  /** Names of files that belong to this pair (base + overlay). Used to
   *  decide which "View" buttons trigger the multi-layer mode. */
  memberNames: string[];
  layers: NiivueLayer[];
}

/**
 * Tries each known pipeline output pattern in order and returns the first
 * match. Returns null when none of the file lists match a known pattern.
 *
 * Adding support for a new pipeline: append a new block that detects the
 * pipeline's characteristic file names and returns a LayerPairSpec.
 */
function detectLayerPairs(
  niftis: RunResultFile[],
  runId: number
): LayerPairSpec | null {
  const url = (f: RunResultFile) => `/api/runs/${runId}/files/${f.path}`;

  // ── FastSurfer ──────────────────────────────────────────────────────────
  // orig.mgz (conformed T1) + aparc/aseg label overlay
  {
    const base = niftis.find((f) => f.name === "orig.mgz" || f.name === "T1.mgz");
    const seg = niftis.find(
      (f) =>
        f.name === "aseg.auto.mgz" ||
        (f.name.includes("aseg") && f.name.endsWith(".mgz")) ||
        (f.name.includes("aparc") && f.name.endsWith(".mgz"))
    );
    if (base && seg) {
      return {
        label: "FastSurfer output detected — clicking orig.mgz or aseg files opens base + segmentation overlay.",
        memberNames: [base.name, seg.name],
        layers: [
          { url: url(base), name: base.name },
          { url: url(seg), name: seg.name, isSegmentation: true, opacity: 0.7 },
        ],
      };
    }
  }

  // ── BrainChop / SynthStrip ──────────────────────────────────────────────
  // Both tools write stripped.nii.gz (skull-stripped T1) and brain_mask.nii.gz
  // (binary mask) to the same output directory. The mask is a 0/1 volume, so
  // we render it with the "hot" colormap rather than the FreeSurfer label LUT.
  {
    const base = niftis.find((f) => f.name === "stripped.nii.gz");
    const mask = niftis.find((f) => f.name === "brain_mask.nii.gz");
    if (base && mask) {
      return {
        label: "Skull-strip output detected — clicking either file opens the stripped T1 with brain mask overlay.",
        memberNames: [base.name, mask.name],
        layers: [
          { url: url(base), name: base.name },
          { url: url(mask), name: mask.name, colormap: "hot", opacity: 0.4 },
        ],
      };
    }
  }

  return null;
}

interface Props {
  runId: number;
}

export default function RunResults({ runId }: Props) {
  const { data: results, isLoading, error } = useRunResults(runId, true);
  const { data: allRuns } = useRuns();
  const [activeReport, setActiveReport] = useState(0);
  const [viewerLayers, setViewerLayers] = useState<NiivueLayer[] | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Smart Compare button: detect sibling for this run
  const thisRun = allRuns?.find((r) => r.id === runId) ?? null;
  const otherSuccessRuns = (allRuns ?? []).filter((r) => r.id !== runId && r.status === "success");
  const verifiedSibling = thisRun ? findVerifiedSibling(thisRun, otherSuccessRuns) : null;
  // For connectivity runs, prefer findCompatibleConnectivityRun for pre-fill
  const connectivitySibling =
    thisRun ? findCompatibleConnectivityRun(thisRun, otherSuccessRuns.filter((r) => r.pipeline_manifest_id === thisRun.pipeline_manifest_id)) : null;

  const firstMetricPath = results?.metrics[0]?.path ?? null;
  const { data: iqmData } = useRunFile<IqmData>(runId, firstMetricPath);

  if (isLoading) {
    return (
      <div className="mt-4 rounded border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
        Loading results…
      </div>
    );
  }

  if (error || !results) {
    return (
      <div className="mt-4 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        Could not load results. The output directory may not be accessible.
      </div>
    );
  }

  const niftis: RunResultFile[] = (results as { niftis?: RunResultFile[] }).niftis ?? [];
  const groupTables = results.group_tables ?? [];
  const images = results.images ?? [];
  const connectivityMatrices = results.connectivity_matrices ?? [];
  const timeseries = results.timeseries ?? [];
  const connectivityMetadata = results.connectivity_metadata ?? [];
  const roiStatistics = results.roi_statistics ?? [];
  const hasFiles =
    results.reports.length > 0 ||
    results.metrics.length > 0 ||
    groupTables.length > 0 ||
    images.length > 0 ||
    connectivityMatrices.length > 0 ||
    timeseries.length > 0 ||
    roiStatistics.length > 0 ||
    niftis.length > 0;
  // Show Download All when any surfaced file or resolved artifact exists.
  // Resolved artifacts may live in output_dir (e.g. bids-validator writes validation-report.txt)
  // even when they aren't classified as report/metric/nifti.
  const hasDownloadable = hasFiles || (results.artifacts ?? []).some((a) => a.resolved);

  const currentReport = results.reports[activeReport];
  const reportUrl = currentReport
    ? `/api/runs/${runId}/files/${currentReport.path}`
    : null;

  const thisRunStatus = allRuns?.find((r) => r.id === runId)?.status ?? results.metadata?.status ?? null;

  async function handleCancel() {
    setActionBusy(true);
    setActionError(null);
    try {
      await cancelRun(runId);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRetry() {
    setActionBusy(true);
    setActionError(null);
    try {
      const newRun = await retryRun(runId);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/runs/${newRun.id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Retry failed");
      setActionBusy(false);
    }
  }

  async function handleRerun() {
    setActionBusy(true);
    setActionError(null);
    try {
      const newRun = await rerunRun(runId);
      await queryClient.invalidateQueries({ queryKey: ["runs"] });
      navigate(`/runs/${newRun.id}`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Re-run failed");
      setActionBusy(false);
    }
  }

  return (
    <div className="mt-4">
      {actionError && (
        <div className="mb-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 flex items-center justify-between">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="ml-3 text-red-400 hover:text-red-200">×</button>
        </div>
      )}
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-gray-100">Results</h2>
          {/* Run action buttons */}
          {(thisRunStatus === "queued" || thisRunStatus === "running" || thisRunStatus === "pending") && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={handleCancel}
              className="rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-50 transition-colors focus:outline-none"
            >
              {actionBusy ? "…" : "Cancel"}
            </button>
          )}
          {(thisRunStatus === "failed" || thisRunStatus === "cancelled" || thisRunStatus === "interrupted") && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={handleRetry}
              className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-300 hover:bg-amber-500/20 disabled:opacity-50 transition-colors focus:outline-none"
            >
              {actionBusy ? "…" : "Retry"}
            </button>
          )}
          {thisRunStatus === "success" && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={handleRerun}
              className="rounded border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs text-accent hover:bg-accent/20 disabled:opacity-50 transition-colors focus:outline-none"
            >
              {actionBusy ? "…" : "Re-run"}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {results.metadata?.dataset_id && (
            <>
              <a
                href={`/datasets/${results.metadata.dataset_id}/dashboard`}
                className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                  <rect x="1" y="1" width="6" height="6" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" />
                  <rect x="1" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" />
                </svg>
                Dashboard
              </a>
              <a
                href={`/datasets/${results.metadata.dataset_id}/artifacts?run=${runId}`}
                className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                  <path d="M2 3h12M2 8h8M2 13h5" strokeLinecap="round" />
                </svg>
                Artifacts
              </a>
              <a
                href={`/datasets/${results.metadata.dataset_id}/graph?highlight=${runId}`}
                className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                  <circle cx="8" cy="3" r="1.5" />
                  <circle cx="3" cy="13" r="1.5" />
                  <circle cx="13" cy="13" r="1.5" />
                  <line x1="8" y1="4.5" x2="4.5" y2="11.5" />
                  <line x1="8" y1="4.5" x2="11.5" y2="11.5" />
                </svg>
                Graph
              </a>
              <a
                href={`/datasets/${results.metadata.dataset_id}/methods?run=${runId}`}
                className="flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:border-accent/60 hover:text-accent transition-colors"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                  <path d="M2 4h12M2 8h9M2 12h6" strokeLinecap="round" />
                </svg>
                Methods
              </a>
            </>
          )}
          {/* Compare button — shown for volumetric outputs (anatomical) or connectivity matrices. */}
          {(niftis.length > 0 || connectivityMatrices.length > 0) && (() => {
            const isConn = connectivityMatrices.length > 0 && niftis.length === 0;
            const sibling = isConn ? connectivitySibling : verifiedSibling;
            const runFamily = thisRun ? detectRunFamily(
              isConn ? ["connectivity_matrix_csv"] : ["brain_mask"]
            ) : null;
            const compareHref = sibling
              ? `/compare?a=${runId}&b=${sibling.id}`
              : `/compare?a=${runId}`;
            const compareTitle = sibling
              ? isConn
                ? `Compare connectivity matrices (run #${sibling.id} found)`
                : `Comparable: verified same-source run found (run #${sibling.id})`
              : undefined;
            const compareLabel = sibling
              ? isConn
                ? "Compare matrices"
                : `Compare with ${sibling.pipeline_manifest_id}`
              : "Compare";
            void runFamily;
            return (
              <a
                href={compareHref}
                title={compareTitle}
                className="flex items-center gap-1.5 rounded border border-violet-600/50 bg-violet-600/10 px-3 py-1.5 text-xs font-medium text-violet-300 hover:border-violet-500 hover:text-violet-200 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M6.5 2.75a.75.75 0 0 0-1.5 0v10.5a.75.75 0 0 0 1.5 0V2.75ZM11 5.5a.75.75 0 0 0-1.5 0v7.75a.75.75 0 0 0 1.5 0V5.5ZM2 8.25a.75.75 0 0 0 0 1.5h12a.75.75 0 0 0 0-1.5H2Z" />
                </svg>
                {compareLabel}
              </a>
            );
          })()}
          {hasDownloadable && (
            <a
              href={`/api/runs/${runId}/download`}
              download
              className="flex items-center gap-1.5 rounded border border-gray-600 bg-surface-raised px-3 py-1.5 text-xs font-medium text-gray-300 hover:border-gray-400 hover:text-gray-100 transition-colors"
            >
              {/* Download icon */}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M8.75 2.75a.75.75 0 0 0-1.5 0v5.69L5.03 6.22a.75.75 0 0 0-1.06 1.06l3.5 3.5a.75.75 0 0 0 1.06 0l3.5-3.5a.75.75 0 0 0-1.06-1.06L8.75 8.44V2.75Z" />
                <path d="M3.5 9.75a.75.75 0 0 0-1.5 0v1.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-1.5a.75.75 0 0 0-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-1.5Z" />
              </svg>
              Download All (.zip)
            </a>
          )}
        </div>
      </div>

      {/* Workflow chaining: recommend compatible next pipelines.
          Rendered before the empty-files guard so pipelines like bids-validator
          (no downloadable outputs, but meaningful artifact types) still show recommendations. */}
      <RunNextCard artifacts={results.artifacts ?? []} runId={runId} />

      {/* Empty-files notice — shown after RunNextCard so chaining is still visible */}
      {!hasFiles && (
        <div className="mt-4 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Run completed but no output files were found in the output directory.
          This may indicate the pipeline exited before writing its outputs — check the log above.
        </div>
      )}

      {/* IQM summary card */}
      {iqmData && <IqmCard data={iqmData} />}

      {/* MRIQC group TSV summary */}
      {groupTables.length > 0 && (
        <MriqcGroupSummary runId={runId} tablePath={groupTables[0].path} />
      )}

      {results.metadata?.pipeline_id === "seed-based-connectivity" ? (
        <SeedConnectivityPanel
          runId={runId}
          metadataPath={connectivityMetadata[0]?.path}
          imagePath={images.find((f) => f.name.includes("seed_connectivity_map"))?.path ?? images[0]?.path}
          timeseriesPath={timeseries[0]?.path}
        />
      ) : results.metadata?.pipeline_id === "group-functional-connectivity" && results.group_summary ? (
        <GroupFCPanel
          runId={runId}
          summary={results.group_summary as GroupFCSummary}
          images={images}
        />
      ) : connectivityMatrices.length > 0 ? (
        <ConnectivitySummary
          runId={runId}
          matrixPath={connectivityMatrices[0].path}
          metadataPath={connectivityMetadata[0]?.path}
          imagePath={images[0]?.path}
        />
      ) : null}

      {roiStatistics.length > 0 && (
        <RoiStatisticsPanel
          runId={runId}
          roiFiles={roiStatistics}
          metadataPath={connectivityMetadata[0]?.path}
          matrixPath={connectivityMatrices[0]?.path}
        />
      )}

      {/* Report tabs (multiple subjects / group report) */}
      {results.reports.length > 0 && (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          {results.reports.length > 1 && (
            <div className="flex border-b border-gray-200 bg-gray-50 overflow-x-auto">
              {results.reports.map((r, i) => (
                <button
                  key={r.path}
                  onClick={() => setActiveReport(i)}
                  className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 transition-colors ${
                    i === activeReport
                      ? "border-blue-500 text-blue-700 bg-white font-medium"
                      : "border-transparent text-gray-600 hover:text-gray-900"
                  }`}
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between bg-gray-100 px-4 py-2">
            <span className="text-xs text-gray-600 font-mono truncate">
              {currentReport?.name}
            </span>
            {reportUrl && (
              <a
                href={reportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-3 shrink-0 text-xs text-blue-600 hover:underline"
              >
                Open in new tab ↗
              </a>
            )}
          </div>

          {reportUrl && (
            <iframe
              key={reportUrl}
              src={reportUrl}
              title={currentReport?.name ?? "MRIQC report"}
              className="w-full border-0"
              style={{ height: "75vh" }}
            />
          )}
        </div>
      )}

      {/* Metrics file list (secondary) */}
      {results.metrics.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-200 select-none">
            Raw IQM files ({results.metrics.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {results.metrics.map((m) => (
              <li key={m.path}>
                <a
                  href={`/api/runs/${runId}/files/${m.path}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline font-mono"
                >
                  {m.path}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}

      {groupTables.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-xs text-gray-400 hover:text-gray-200">
            Group IQM tables ({groupTables.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {groupTables.map((table) => (
              <li key={table.path}>
                <a
                  href={`/api/runs/${runId}/files/${table.path}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-blue-600 hover:underline"
                >
                  {table.path}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}

      {(connectivityMatrices.length > 0 || timeseries.length > 0 || images.length > 0 || connectivityMetadata.length > 0 || roiStatistics.length > 0) && (
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-xs text-gray-400 hover:text-gray-200">
            Connectivity files ({connectivityMatrices.length + timeseries.length + images.length + connectivityMetadata.length + roiStatistics.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {[...connectivityMatrices, ...timeseries, ...images, ...connectivityMetadata, ...roiStatistics].map((file) => (
              <li key={file.path}>
                <a
                  href={`/api/runs/${runId}/files/${file.path}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-blue-600 hover:underline"
                >
                  {file.path}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Volumetric file viewer — .nii/.nii.gz/.mgz output from pipelines.
          Known pairs (FastSurfer, BrainChop) open as multi-layer overlays;
          all other files open as single-volume. */}
      {niftis.length > 0 && (() => {
        const pair = detectLayerPairs(niftis, runId);
        return (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-gray-100 mb-2">
              Volume files ({niftis.length})
            </h3>
            <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 overflow-hidden">
              {niftis.map((f) => (
                <div
                  key={f.path}
                  className="flex items-center justify-between px-3 py-2 bg-white gap-3"
                >
                  <span className="text-xs text-gray-700 font-mono truncate">{f.path}</span>
                  <button
                    onClick={() => {
                      if (pair && pair.memberNames.includes(f.name)) {
                        setViewerLayers(pair.layers);
                      } else {
                        setViewerLayers([{
                          url: `/api/runs/${runId}/files/${f.path}`,
                          name: f.name,
                        }]);
                      }
                    }}
                    className="shrink-0 rounded border border-blue-300 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 transition-colors"
                  >
                    View
                  </button>
                </div>
              ))}
            </div>
            {pair && (
              <p className="mt-2 text-xs text-gray-400">{pair.label}</p>
            )}
          </div>
        );
      })()}

      {/* NiivueViewer modal */}
      {viewerLayers && (
        <NiivueViewer
          layers={viewerLayers}
          onClose={() => setViewerLayers(null)}
        />
      )}

      {/* Run provenance / metadata — collapsible, shown for all completed runs */}
      {results.metadata && <RunMetadataPanel metadata={results.metadata} />}
    </div>
  );
}
