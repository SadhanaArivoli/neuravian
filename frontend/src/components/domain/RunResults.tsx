import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { cancelRun, fetchRunFile, fetchRunTextFile, retryRun, rerunRun } from "../../api/client";
import { useRunFile, useRunResults, useRuns } from "../../hooks/useRuns";
import NiivueViewer, { type NiivueLayer } from "./NiivueViewer";
import NiivuePanel from "./NiivuePanel";
import RunMetadataPanel from "./RunMetadataPanel";
import RunNextCard from "./RunNextCard";
import FmriprepResultsPanel from "./FmriprepResultsPanel";
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
  // Confound provenance (added in Fisher-z milestone)
  confound_strategy?: string;
  confounds_used?: string[];
  confounds_missing?: string[];
  n_confound_regressors?: number;
  global_signal_included?: boolean;
  detrending?: boolean;
  standardize?: string;
  n_volumes_before_cleaning?: number;
  n_volumes_after_cleaning?: number;
}

interface AlffMetadata {
  tr: number; number_of_timepoints: number; nyquist_frequency: number;
  frequency_band: [number, number]; confound_strategy: string; mask_voxel_count: number;
  normalization: string; detrending: string; alff_statistics: Record<string, number>;
  falff_statistics: Record<string, number>; warnings: string[];
}

interface RehoMetadata {
  tr: number; number_of_timepoints: number; neighborhood: number; neighborhood_voxels: number;
  neighborhood_label: string; confound_strategy: string; detrending: string; z_normalize: boolean;
  mask_voxel_count: number; valid_voxel_count: number; excluded_edge_voxels: number;
  reho_statistics: Record<string, number>; warnings: string[]; runtime_seconds: number;
  citations: string[];
}

function RehoPanel({ runId, niftis, images }: { runId: number; niftis: RunResultFile[]; images: RunResultFile[] }) {
  const { data: meta, error } = useRunFile<RehoMetadata>(runId, "reho_metadata.json");
  const rehoMap = niftis.find((f) => f.path.endsWith("reho_map.nii.gz") && !f.path.includes("normalized"));
  const normMap = niftis.find((f) => f.path.endsWith("reho_normalized_map.nii.gz"));
  if (error) return <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">Could not load ReHo metadata.</div>;
  if (!meta) return <div className="rounded border border-gray-200 bg-white p-3 text-sm text-gray-500">Loading ReHo results…</div>;
  const cards = [
    ["Neighborhood", meta.neighborhood_label],
    ["TR", `${meta.tr} s`],
    ["Timepoints", meta.number_of_timepoints],
    ["Valid voxels", meta.valid_voxel_count.toLocaleString()],
    ["Mask voxels", meta.mask_voxel_count.toLocaleString()],
    ["Confounds", meta.confound_strategy],
    ["Detrend", meta.detrending],
    ["Z-norm", meta.z_normalize ? "yes" : "no"],
  ];
  const s = meta.reho_statistics;
  return (
    <div className="space-y-4">
      {/* Metadata card — dark theme to match viewer */}
      <div className="rounded-lg border border-white/10 bg-[#111] p-4">
        <h3 className="mb-3 text-sm font-semibold text-gray-100">Regional Homogeneity (ReHo)</h3>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {cards.map(([k, v]) => (
            <div key={String(k)} className="rounded bg-white/5 border border-white/8 p-2">
              <div className="text-[10px] text-gray-500 uppercase tracking-wide">{k}</div>
              <div className="font-mono text-sm text-gray-200 mt-0.5">{v}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded border border-white/8 bg-white/3 p-3">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">KCC (W) statistics</div>
          <div className="mt-1 font-mono text-xs text-gray-300">
            mean {s.mean.toPrecision(5)} · median {s.median.toPrecision(5)} · std {s.std.toPrecision(5)} · range {s.min.toPrecision(4)}–{s.max.toPrecision(4)}
          </div>
        </div>
        {meta.excluded_edge_voxels > 0 && (
          <p className="mt-2 text-xs text-gray-500">{meta.excluded_edge_voxels.toLocaleString()} mask-edge voxels excluded (incomplete neighborhood).</p>
        )}
        {meta.warnings.length > 0 && (
          <ul className="mt-3 rounded border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-300">
            {meta.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
      </div>
      {/* Viewers — plasma = perceptually uniform for positive KCC values */}
      <div className={`grid gap-4 ${normMap ? "lg:grid-cols-2" : ""}`}>
        {rehoMap && (
          <div className="h-[460px] overflow-hidden rounded border border-white/8">
            <NiivuePanel
              label="ReHo map (KCC W)"
              mapType="reho"
              layers={[{ url: `/api/runs/${runId}/files/${rehoMap.path}`, name: "ReHo" }]}
            />
          </div>
        )}
        {normMap && (
          <div className="h-[460px] overflow-hidden rounded border border-white/8">
            <NiivuePanel
              label="Normalized ReHo (z-score)"
              mapType="reho_z"
              layers={[{ url: `/api/runs/${runId}/files/${normMap.path}`, name: "ReHo-z" }]}
            />
          </div>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {images.filter((i) => /reho_histogram/.test(i.path)).map((i) => (
          <a key={i.path} href={`/api/runs/${runId}/files/${i.path}`} target="_blank" rel="noreferrer">
            <img src={`/api/runs/${runId}/files/${i.path}`} alt={i.name} className="w-full rounded border border-white/10" />
          </a>
        ))}
      </div>
      {meta.citations.length > 0 && (
        <p className="text-xs text-gray-500">Citation: {meta.citations[0]}</p>
      )}
    </div>
  );
}

function AlffFalffPanel({ runId, niftis, images }: { runId: number; niftis: RunResultFile[]; images: RunResultFile[] }) {
  const { data: metadata, error } = useRunFile<AlffMetadata>(runId, "alff_falff_metadata.json");
  const alff = niftis.find((f) => f.path.endsWith("alff_map.nii.gz") && !f.path.includes("falff"));
  const falff = niftis.find((f) => f.path.endsWith("falff_map.nii.gz"));
  if (error) return <div className="rounded border border-red-800/40 bg-red-950/30 p-3 text-sm text-red-300">Could not load ALFF/fALFF metadata.</div>;
  if (!metadata) return <div className="rounded border border-white/10 bg-[#111] p-3 text-sm text-gray-400">Loading ALFF/fALFF results…</div>;
  const cards = [["TR", `${metadata.tr} s`], ["Timepoints", metadata.number_of_timepoints], ["Band", `${metadata.frequency_band[0]}–${metadata.frequency_band[1]} Hz`], ["Nyquist", `${metadata.nyquist_frequency} Hz`], ["Confounds", metadata.confound_strategy], ["Mask voxels", metadata.mask_voxel_count]];
  return <div className="space-y-4">
    {/* Dark-themed metadata card to match viewer */}
    <div className="rounded-lg border border-white/10 bg-[#111] p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-100">ALFF / fALFF</h3>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        {cards.map(([k,v]) => (
          <div key={String(k)} className="rounded bg-white/5 border border-white/8 p-2">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide">{k}</div>
            <div className="font-mono text-sm text-gray-200 mt-0.5">{v}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {([['ALFF',metadata.alff_statistics],['fALFF',metadata.falff_statistics]] as const).map(([label,s]) => (
          <div key={label} className="rounded border border-white/8 bg-white/3 p-3">
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">{label} statistics</div>
            <div className="mt-1 font-mono text-xs text-gray-300">mean {s.mean.toPrecision(5)} · median {s.median.toPrecision(5)} · std {s.std.toPrecision(5)} · range {s.min.toPrecision(4)}–{s.max.toPrecision(4)}</div>
          </div>
        ))}
      </div>
      {metadata.warnings.length > 0 && <ul className="mt-3 rounded border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-300">{metadata.warnings.map(w=><li key={w}>{w}</li>)}</ul>}
    </div>
    {/* Viewers — inferno = perceptually uniform for positive-only amplitude values */}
    <div className="grid gap-4 lg:grid-cols-2">
      {alff && <div className="h-[460px] overflow-hidden rounded border border-white/8"><NiivuePanel label="ALFF map" mapType="alff" layers={[{url:`/api/runs/${runId}/files/${alff.path}`,name:"ALFF"}]}/></div>}
      {falff && <div className="h-[460px] overflow-hidden rounded border border-white/8"><NiivuePanel label="fALFF map" mapType="falff" layers={[{url:`/api/runs/${runId}/files/${falff.path}`,name:"fALFF"}]}/></div>}
    </div>
    <div className="grid gap-3 md:grid-cols-3">
      {images.filter(i=>/alff_histogram|falff_histogram|spectral_summary/.test(i.path)).map(i=>(
        <a key={i.path} href={`/api/runs/${runId}/files/${i.path}`} target="_blank" rel="noreferrer">
          <img src={`/api/runs/${runId}/files/${i.path}`} alt={i.name} className="w-full rounded border border-white/10"/>
        </a>
      ))}
    </div>
  </div>;
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
        // Blue–white–red diverging colormap (matches blue2red in NiiVue):
        //   -1 → blue (0,0,178), 0 → white (255,255,255), +1 → red (178,0,0)
        // Perceptually balanced: mid-grey → white avoids dark-centre artefact
        let r: number, g: number, b: number;
        if (value >= 0) {
          // white → red
          r = 255;
          g = Math.round(255 * (1 - value));
          b = Math.round(255 * (1 - value));
        } else {
          // blue → white
          const t = 1 + value; // 0 at -1, 1 at 0
          r = Math.round(255 * t);
          g = Math.round(255 * t);
          b = 255;
        }
        ctx.fillStyle = `rgb(${r},${g},${b})`;
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
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p className="text-xs text-gray-400 font-mono">
          {hover
            ? `${labels[hover.row] ?? `ROI ${hover.row + 1}`} × ${labels[hover.col] ?? `ROI ${hover.col + 1}`} = ${hover.value.toFixed(3)}`
            : "Hover to inspect ROI pairs"}
        </p>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-500">
            Zoom
            <input
              type="range"
              min="1"
              max="4"
              step="0.25"
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="w-20 accent-blue-400"
            />
            <span className="w-8 text-right font-mono tabular-nums text-gray-400">{zoom.toFixed(2)}×</span>
          </label>
          <button
            type="button"
            onClick={exportPng}
            className="rounded border border-white/12 px-2 py-1 text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
          >
            ↓ PNG
          </button>
        </div>
      </div>
      {/* Color scale legend */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] text-blue-300 font-mono">−1</span>
        <div
          className="flex-1 h-2.5 rounded"
          style={{background: "linear-gradient(to right, rgb(0,0,255), rgb(255,255,255), rgb(255,0,0))"}}
        />
        <span className="text-[10px] text-red-300 font-mono">+1</span>
        <span className="text-[10px] text-gray-500 ml-1">Pearson r</span>
      </div>
      {/* Matrix canvas — width grows with zoom; overflow-x scrolls when wider than viewport */}
      <div className="max-h-[560px] overflow-auto rounded border border-white/10 bg-[#0d0d0d] p-2 w-fit max-w-full">
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
  confound_strategy?: string;
  // Fisher-z fields (v0.1.1+)
  fisher_z_applied?: boolean;
  aggregation_space?: string;
  mean_r_min?: number;
  mean_r_max?: number;
  mean_r_mean?: number;
  mean_z_min?: number;
  mean_z_max?: number;
  mean_z_mean?: number;
  mean_z_std?: number;
  std_z_max?: number;
  std_z_mean?: number;
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
  const isLegacy = !summary.fisher_z_applied;
  // For new runs: prefer r-space heatmap for the primary display.
  const meanRHeatmap = images.find((f) => f.name.includes("mean_r") && f.name.includes("heatmap"))
    ?? images.find((f) => f.name.includes("mean") && f.name.includes("heatmap") && !f.name.includes("fisher"));
  const meanZHeatmap = images.find((f) => f.name.includes("fisher_z") && f.name.includes("mean") && f.name.includes("heatmap"));
  const stdHeatmap = images.find((f) => f.name.includes("std") && f.name.includes("heatmap"));

  // Download paths differ between legacy and new runs
  const meanRCsvFile = isLegacy ? "group_mean_connectivity_matrix.csv" : "group_mean_r_matrix.csv";
  const meanRNpyFile = isLegacy ? "group_mean_connectivity_matrix.npy" : "group_mean_r_matrix.npy";
  const stdCsvFile = isLegacy ? "group_std_connectivity_matrix.csv" : "group_std_fisher_z_matrix.csv";

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Group Functional Connectivity</h3>
          <p className="text-xs text-gray-500">
            {summary.atlas ?? "Unknown atlas"} · {summary.n_runs ?? "?"} runs aggregated
            {isLegacy
              ? " · legacy aggregation (raw r)"
              : " · Fisher r-to-z aggregation"}
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

      {isLegacy && (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs font-semibold text-amber-800">Legacy aggregation (raw r)</p>
          <p className="text-xs text-amber-700 mt-0.5">
            This run averaged raw Pearson r values without Fisher r-to-z transformation.
            Re-run group aggregation to obtain scientifically correct Fisher-z results.
          </p>
        </div>
      )}

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

      {summary.confound_strategy && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs text-gray-500">Confound strategy:</span>
          <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-800">
            {summary.confound_strategy}
          </span>
          {(summary.confound_strategy === "motion6_wm_csf_gsr" || summary.confound_strategy === "motion6_wm_csf_global") && (
            <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-800">GSR</span>
          )}
        </div>
      )}

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Runs", summary.n_runs ?? "—"],
          ["ROIs", summary.n_rois ?? "—"],
          ...(summary.fisher_z_applied ? [
            ["Mean r min", summary.mean_r_min?.toFixed(3) ?? "—"],
            ["Mean r max", summary.mean_r_max?.toFixed(3) ?? "—"],
          ] : []),
          ["Mean z min", summary.mean_z_min?.toFixed(3) ?? "—"],
          ["Mean z max", summary.mean_z_max?.toFixed(3) ?? "—"],
          ["Max std z", summary.std_z_max?.toFixed(3) ?? "—"],
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
        {meanRHeatmap && (
          <div>
            <p className="mb-1 text-xs font-medium text-gray-600">
              Group mean matrix {isLegacy ? "(raw r — legacy)" : "(r, back-transformed from Fisher z)"}
            </p>
            <img
              src={`/api/runs/${runId}/files/${meanRHeatmap.path}`}
              alt="Group mean connectivity heatmap (r-space)"
              className="w-full rounded border border-gray-200 object-contain"
            />
          </div>
        )}
        {meanZHeatmap && !isLegacy && (
          <div>
            <p className="mb-1 text-xs font-medium text-gray-600">Group mean (Fisher z-space)</p>
            <img
              src={`/api/runs/${runId}/files/${meanZHeatmap.path}`}
              alt="Group mean connectivity heatmap (Fisher z)"
              className="w-full rounded border border-gray-200 object-contain"
            />
          </div>
        )}
        {stdHeatmap && (
          <div>
            <p className="mb-1 text-xs font-medium text-gray-600">
              Across-run std {isLegacy ? "(raw r)" : "(Fisher z-space, ddof=1)"}
            </p>
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
          href={`/api/runs/${runId}/files/${meanRCsvFile}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          {isLegacy ? "Download mean matrix CSV" : "Download mean r matrix CSV"}
        </a>
        {!isLegacy && (
          <a
            href={`/api/runs/${runId}/files/group_mean_fisher_z_matrix.csv`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline"
          >
            Download mean z matrix CSV
          </a>
        )}
        <a
          href={`/api/runs/${runId}/files/${stdCsvFile}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          {isLegacy ? "Download std matrix CSV" : "Download std z matrix CSV"}
        </a>
        <a
          href={`/api/runs/${runId}/files/${meanRNpyFile}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline"
        >
          {isLegacy ? "Download mean matrix NPY" : "Download mean r matrix NPY"}
        </a>
      </div>
    </div>
  );
}

// ── Atlas ROI Extraction panel ────────────────────────────────────────────────

interface RoiExtractionRow {
  roi_number: number;
  roi_label: string;
  network: string | null;
  voxel_count: number;
  nonzero_voxel_count: number;
  coverage_pct: number | null;
  mean: number | null;
  median: number | null;
  std: number | null;
  min: number | null;
  max: number | null;
  p5: number | null;
  p95: number | null;
  nan_count: number;
  inf_count: number;
  overlap_voxel_count?: number;
  roi_occupancy_pct?: number;
}

interface RoiExtractionMeta {
  atlas_id?: string;
  atlas_display_name?: string;
  atlas_citation?: string;
  n_rois?: number;
  n_rois_with_voxels?: number;
  resampling_performed?: boolean;
  interpolation_method?: string;
  aggregation_mode?: string;
  is_binary_mask?: boolean;
  input_filename?: string;
  input_shape?: number[];
  image_voxel_spacing_mm?: number[];
  atlas_fov_overlap_pct?: number;
  nibabel_version?: string;
  nilearn_version?: string;
  runtime_seconds?: number;
  timestamp?: string;
}

type RoiExSortKey = "roi_number" | "roi_label" | "network" | "voxel_count" | "coverage_pct" | "mean" | "std" | "min" | "max";

const ROI_EX_SORT_OPTIONS: Array<{ key: RoiExSortKey; label: string }> = [
  { key: "roi_number", label: "ROI #" },
  { key: "roi_label", label: "Label" },
  { key: "mean", label: "Mean" },
  { key: "coverage_pct", label: "Coverage" },
  { key: "voxel_count", label: "Voxels" },
  { key: "std", label: "Std dev" },
];

function RoiExtractionPanel({ runId, files }: {
  runId: number;
  files: RunResultFile[];
}) {
  const [rows, setRows] = useState<RoiExtractionRow[]>([]);
  const [meta, setMeta] = useState<RoiExtractionMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState<string>("");
  const [sortKey, setSortKey] = useState<RoiExSortKey>("roi_number");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selected, setSelected] = useState<RoiExtractionRow | null>(null);

  const jsonFile = files.find((f) => f.path.endsWith("roi_extraction.json"));
  const metaFile = files.find((f) => f.path.endsWith("roi_extraction_metadata.json"));
  const csvFile = files.find((f) => f.path.endsWith("roi_extraction.csv"));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const loadJson = jsonFile
      ? fetchRunFile<RoiExtractionRow[]>(runId, jsonFile.path)
      : Promise.reject(new Error("No roi_extraction.json found"));
    const loadMeta = metaFile
      ? fetchRunFile<RoiExtractionMeta>(runId, metaFile.path)
      : Promise.resolve(null);
    Promise.all([loadJson, loadMeta])
      .then(([rowData, metaData]) => {
        if (!cancelled) { setRows(rowData); setMeta(metaData); setLoading(false); }
      })
      .catch((err) => {
        if (!cancelled) { setError(err instanceof Error ? err.message : "Could not load ROI data."); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [runId, jsonFile?.path, metaFile?.path]);

  const networks = useMemo(() => {
    const nets = new Set(rows.map((r) => r.network).filter(Boolean) as string[]);
    return [...nets].sort();
  }, [rows]);

  const visible = useMemo(() => {
    let filtered = rows;
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter(
        (r) => r.roi_label.toLowerCase().includes(q) || String(r.roi_number).includes(q) || (r.network ?? "").toLowerCase().includes(q)
      );
    }
    if (network) filtered = filtered.filter((r) => r.network === network);
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      const cmp = typeof av === "string" && typeof bv === "string"
        ? av.localeCompare(bv)
        : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, query, network, sortKey, sortDir]);

  function handleSort(key: RoiExSortKey) {
    if (sortKey === key) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  function downloadCsv() {
    if (!csvFile) return;
    window.open(`/api/runs/${runId}/files/${csvFile.path}`, "_blank");
  }

  function fmt(v: number | null | undefined, digits = 4) {
    if (v === null || v === undefined) return "—";
    return v.toFixed(digits);
  }

  if (loading) return <div className="p-4 text-sm text-gray-400">Loading ROI extraction data…</div>;
  if (error) return <div className="p-4 text-sm text-red-500">ROI extraction preview failed: {error}</div>;

  const isBinary = meta?.is_binary_mask ?? false;

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Atlas ROI Extraction</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {meta?.atlas_display_name ?? "Atlas"} · {meta?.n_rois ?? rows.length} ROIs
            {meta?.input_filename ? ` · ${meta.input_filename}` : ""}
            {meta?.is_binary_mask ? " · binary mask" : ""}
            {meta?.resampling_performed ? " · atlas resampled" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {meta?.resampling_performed && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs text-amber-700">
              ↔ Resampled
            </span>
          )}
          <button
            onClick={downloadCsv}
            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            ↓ CSV
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-px bg-gray-100 border-b border-gray-100">
        {[
          ["ROIs with voxels", `${meta?.n_rois_with_voxels ?? "—"} / ${meta?.n_rois ?? "—"}`],
          ["FOV overlap", meta?.atlas_fov_overlap_pct != null ? `${meta.atlas_fov_overlap_pct.toFixed(1)}%` : "—"],
          ["Aggregation", meta?.aggregation_mode === "temporal_mean" ? "Temporal mean" : meta?.aggregation_mode === "none" ? "None (3D)" : (meta?.aggregation_mode ?? "—")],
          ["Runtime", meta?.runtime_seconds != null ? `${meta.runtime_seconds}s` : "—"],
        ].map(([label, val]) => (
          <div key={label} className="bg-white px-3 py-2">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
            <p className="text-sm font-semibold text-gray-800">{val}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="px-3 py-2 border-b border-gray-100 flex gap-2 flex-wrap">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ROI label, number, or network…"
          className="flex-1 min-w-40 rounded border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300"
        />
        {networks.length > 0 && (
          <select
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            className="rounded border border-gray-200 px-2 py-1.5 text-xs focus:outline-none"
          >
            <option value="">All networks</option>
            {networks.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
        <div className="flex gap-1 flex-wrap">
          {ROI_EX_SORT_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => handleSort(key)}
              className={`rounded border px-2 py-1 text-[11px] transition-colors ${
                sortKey === key
                  ? "border-blue-400 bg-blue-50 text-blue-700 font-medium"
                  : "border-gray-200 text-gray-500 hover:border-gray-300"
              }`}
            >
              {label}{sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
            </button>
          ))}
        </div>
      </div>

      {/* Table + side panel */}
      <div className="flex overflow-hidden" style={{ maxHeight: "420px" }}>
        {/* ROI table */}
        <div className={`overflow-y-auto ${selected ? "w-1/2" : "w-full"} transition-all`}>
          {visible.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">No ROIs match the current filter.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr className="border-b border-gray-200">
                  <th className="px-3 py-2 text-left font-medium text-gray-600 whitespace-nowrap">#</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Label</th>
                  {networks.length > 0 && <th className="px-3 py-2 text-left font-medium text-gray-600">Network</th>}
                  <th className="px-3 py-2 text-right font-medium text-gray-600">Voxels</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600">Coverage</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600">Mean</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600">Std</th>
                  {isBinary && <th className="px-3 py-2 text-right font-medium text-gray-600">Occupancy</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.roi_number}
                    onClick={() => setSelected(selected?.roi_number === row.roi_number ? null : row)}
                    className={`border-b border-gray-50 cursor-pointer hover:bg-blue-50 transition-colors ${selected?.roi_number === row.roi_number ? "bg-blue-50" : ""}`}
                  >
                    <td className="px-3 py-1.5 text-gray-400 tabular-nums">{row.roi_number}</td>
                    <td className="px-3 py-1.5 font-mono text-gray-700 max-w-xs truncate">{row.roi_label}</td>
                    {networks.length > 0 && <td className="px-3 py-1.5 text-gray-500">{row.network ?? "—"}</td>}
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{row.voxel_count.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{fmt(row.coverage_pct, 1)}%</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{fmt(row.mean)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{fmt(row.std)}</td>
                    {isBinary && <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{fmt(row.roi_occupancy_pct, 1)}%</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Region Explorer side panel */}
        {selected && (
          <div className="w-1/2 border-l border-gray-200 overflow-y-auto bg-gray-50 p-3">
            <div className="flex items-start justify-between mb-2">
              <div>
                <p className="text-xs font-semibold text-gray-800">ROI {selected.roi_number}</p>
                <p className="text-[11px] text-gray-500 font-mono mt-0.5 break-all">{selected.roi_label}</p>
              </div>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 text-sm ml-2">✕</button>
            </div>
            {selected.network && (
              <p className="text-[11px] text-blue-600 mb-2">Network: {selected.network}</p>
            )}
            <div className="grid grid-cols-2 gap-1 text-xs">
              {[
                ["Atlas", meta?.atlas_display_name ?? "—"],
                ["Voxel count", selected.voxel_count.toLocaleString()],
                ["Non-zero voxels", selected.nonzero_voxel_count.toLocaleString()],
                ["Coverage", fmt(selected.coverage_pct, 2) + "%"],
                ["Mean", fmt(selected.mean)],
                ["Median", fmt(selected.median)],
                ["Std dev", fmt(selected.std)],
                ["Min", fmt(selected.min)],
                ["Max", fmt(selected.max)],
                ["p5", fmt(selected.p5)],
                ["p95", fmt(selected.p95)],
                ["NaN count", String(selected.nan_count)],
                ["Inf count", String(selected.inf_count)],
                ...(isBinary ? [
                  ["Overlap voxels", String(selected.overlap_voxel_count ?? "—")],
                  ["ROI occupancy", fmt(selected.roi_occupancy_pct, 2) + "%"],
                ] : []),
              ].map(([label, val]) => (
                <div key={label} className="bg-white rounded border border-gray-100 px-2 py-1">
                  <p className="text-[10px] text-gray-400">{label}</p>
                  <p className="text-xs font-medium text-gray-800 tabular-nums">{val}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 text-[10px] text-gray-400 border-t border-gray-100">
        {visible.length} of {rows.length} ROIs shown
        {meta?.nibabel_version && ` · nibabel ${meta.nibabel_version}`}
        {meta?.nilearn_version && ` · nilearn ${meta.nilearn_version}`}
        {meta?.atlas_citation && ` · ${meta.atlas_citation}`}
      </div>
    </div>
  );
}

// ── Connectome Graph Analysis panel ───────────────────────────────────────────

interface GraphMetrics {
  n_nodes: number;
  n_edges: number;
  max_possible_edges: number;
  density: number | null;
  mean_degree: number | null;
  mean_strength: number | null;
  global_efficiency: number | null;
  local_efficiency: number | null;
  clustering_coefficient: number | null;
  transitivity: number | null;
  characteristic_path_length: number | null;
  average_shortest_path_length: number | null;
  mean_betweenness_centrality: number | null;
  modularity: number | null;
  n_communities: number | null;
  n_connected_components: number;
  largest_component_size: number;
  is_connected: boolean;
  provenance?: {
    threshold_method?: string;
    threshold_value?: number;
    source_run_id?: number | null;
    runtime_seconds?: number;
    networkx_version?: string;
    louvain_available?: boolean;
  };
}

interface GraphNodeRow {
  node_index: number;
  node_label: string;
  degree: number;
  strength: number | null;
  clustering_coefficient: number | null;
  betweenness_centrality: number | null;
  participation_coefficient: number | null;
  community: number | null;
}

type GraphNodeSortKey = "strength" | "degree" | "clustering_coefficient" | "betweenness_centrality" | "participation_coefficient";

function GraphAnalysisPanel({ runId, files }: { runId: number; files: Array<{ name: string; path: string }> }) {
  const [metrics, setMetrics] = useState<GraphMetrics | null>(null);
  const [nodes, setNodes] = useState<GraphNodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<GraphNodeSortKey>("strength");
  const [sortAsc, setSortAsc] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const metricsFile = files.find((f) => f.name === "graph_metrics");
  const nodeFile = files.find((f) => f.name === "node_metrics");
  const imgFile = files.find((f) => f.name === "graph_summary");

  useEffect(() => {
    if (!metricsFile) { setLoading(false); return; }
    setLoading(true);
    const p1 = fetchRunFile<GraphMetrics>(runId, metricsFile.path).then(setMetrics);
    const p2 = nodeFile
      ? fetch(`/api/runs/${runId}/files/${nodeFile.path}`).then((r) => r.text()).then((txt) => {
          const lines = txt.trim().split("\n");
          if (lines.length < 2) return;
          const headers = lines[0].split(",");
          const rows: GraphNodeRow[] = lines.slice(1).map((line) => {
            const vals = line.split(",");
            const obj: Record<string, string> = {};
            headers.forEach((h, i) => { obj[h.trim()] = vals[i]?.trim() ?? ""; });
            return {
              node_index: parseInt(obj.node_index),
              node_label: obj.node_label,
              degree: parseInt(obj.degree),
              strength: obj.strength === "" || obj.strength === "None" ? null : parseFloat(obj.strength),
              clustering_coefficient: obj.clustering_coefficient === "" || obj.clustering_coefficient === "None" ? null : parseFloat(obj.clustering_coefficient),
              betweenness_centrality: obj.betweenness_centrality === "" || obj.betweenness_centrality === "None" ? null : parseFloat(obj.betweenness_centrality),
              participation_coefficient: obj.participation_coefficient === "" || obj.participation_coefficient === "None" ? null : parseFloat(obj.participation_coefficient),
              community: obj.community === "" || obj.community === "None" ? null : parseInt(obj.community),
            };
          });
          setNodes(rows);
        })
      : Promise.resolve();
    Promise.all([p1, p2]).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [runId, metricsFile?.path, nodeFile?.path]);

  const sortedNodes = useMemo(() => {
    const sorted = [...nodes].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return sortAsc ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
    });
    return showAll ? sorted : sorted.slice(0, 20);
  }, [nodes, sortKey, sortAsc, showAll]);

  function toggleSort(k: GraphNodeSortKey) {
    if (sortKey === k) setSortAsc((p) => !p);
    else { setSortKey(k); setSortAsc(false); }
  }

  const fmt = (v: number | null | undefined, decimals = 4) =>
    v == null ? "—" : v.toFixed(decimals);

  if (loading) return <div className="text-gray-500 text-sm py-4">Loading graph metrics…</div>;
  if (error || !metrics) return <div className="text-red-500 text-sm py-4">{error ?? "No graph metrics found."}</div>;

  const prov = metrics.provenance ?? {};
  const METRIC_CARDS: Array<{ label: string; value: string }> = [
    { label: "Nodes", value: String(metrics.n_nodes) },
    { label: "Edges", value: String(metrics.n_edges) },
    { label: "Density", value: fmt(metrics.density) },
    { label: "Mean Degree", value: fmt(metrics.mean_degree, 2) },
    { label: "Mean Strength", value: fmt(metrics.mean_strength, 4) },
    { label: "Global Efficiency", value: fmt(metrics.global_efficiency) },
    { label: "Local Efficiency", value: fmt(metrics.local_efficiency) },
    { label: "Clustering Coeff", value: fmt(metrics.clustering_coefficient) },
    { label: "Transitivity", value: fmt(metrics.transitivity) },
    { label: "Char Path Length", value: fmt(metrics.characteristic_path_length) },
    { label: "Modularity (Q)", value: fmt(metrics.modularity) },
    { label: "Communities", value: metrics.n_communities != null ? String(metrics.n_communities) : "—" },
    { label: "Connected", value: metrics.is_connected ? "Yes" : "No" },
    { label: "Components", value: String(metrics.n_connected_components) },
    { label: "Largest CC", value: String(metrics.largest_component_size) },
  ];

  const SortHeader = ({ k, label }: { k: GraphNodeSortKey; label: string }) => (
    <th
      className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-300 select-none"
      onClick={() => toggleSort(k)}
    >
      {label}{sortKey === k ? (sortAsc ? " ↑" : " ↓") : ""}
    </th>
  );

  return (
    <div className="space-y-4 mt-4">
      {/* Graph summary figure */}
      {imgFile && (
        <div className="rounded-lg overflow-hidden border border-gray-700">
          <img
            src={`/api/runs/${runId}/files/${imgFile.path}`}
            alt="Graph summary"
            className="w-full object-contain"
          />
        </div>
      )}

      {/* Badges */}
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="px-2 py-1 rounded bg-violet-900/40 text-violet-300 border border-violet-700">
          Threshold: {prov.threshold_method ?? "—"} @ {prov.threshold_value ?? "—"}
        </span>
        <span className="px-2 py-1 rounded bg-blue-900/40 text-blue-300 border border-blue-700">
          weighted undirected graph
        </span>
        {prov.networkx_version && (
          <span className="px-2 py-1 rounded bg-gray-800 text-gray-400 border border-gray-700">
            networkx {prov.networkx_version}
          </span>
        )}
      </div>

      {/* Global metrics grid */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Global Graph Metrics</h3>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {METRIC_CARDS.map(({ label, value }) => (
            <div key={label} className="bg-gray-800 rounded-lg p-3 border border-gray-700">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">{label}</div>
              <div className="text-sm font-semibold text-gray-100">{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Node metrics table */}
      {nodes.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">
            Node Metrics — Top {showAll ? nodes.length : Math.min(20, nodes.length)} of {nodes.length} nodes
          </h3>
          <div className="overflow-x-auto rounded-lg border border-gray-700">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Label</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-300" onClick={() => toggleSort("degree" as GraphNodeSortKey)}>
                    Deg{sortKey === "degree" ? (sortAsc ? " ↑" : " ↓") : ""}
                  </th>
                  <SortHeader k="strength" label="Strength" />
                  <SortHeader k="clustering_coefficient" label="Clust" />
                  <SortHeader k="betweenness_centrality" label="Btwn" />
                  <SortHeader k="participation_coefficient" label="Partic" />
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Comm</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {sortedNodes.map((row) => (
                  <tr key={row.node_index} className="hover:bg-gray-800/50">
                    <td className="px-3 py-1.5 text-gray-500">{row.node_index}</td>
                    <td className="px-3 py-1.5 text-gray-200 font-mono text-[11px] max-w-[180px] truncate" title={row.node_label}>{row.node_label}</td>
                    <td className="px-3 py-1.5 text-gray-300">{row.degree}</td>
                    <td className="px-3 py-1.5 text-gray-300">{fmt(row.strength, 4)}</td>
                    <td className="px-3 py-1.5 text-gray-300">{fmt(row.clustering_coefficient, 4)}</td>
                    <td className="px-3 py-1.5 text-gray-300">{fmt(row.betweenness_centrality, 4)}</td>
                    <td className="px-3 py-1.5 text-gray-300">{fmt(row.participation_coefficient, 4)}</td>
                    <td className="px-3 py-1.5 text-gray-400">{row.community ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nodes.length > 20 && (
            <button
              onClick={() => setShowAll((p) => !p)}
              className="mt-2 text-xs text-violet-400 hover:text-violet-300"
            >
              {showAll ? "Show top 20 only" : `Show all ${nodes.length} nodes`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Statistical Map Explorer panel ───────────────────────────────────────────

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

interface ClusterTableJson {
  schema: string;
  metadata: {
    threshold?: number;
    direction?: string;
    min_cluster_size?: number;
    n_clusters?: number;
    n_suprathreshold_voxels?: number;
    image_shape?: number[];
    voxel_size_mm?: number[];
    nibabel_version?: string;
    scipy_version?: string;
    neuroforge_version?: string;
    runtime_seconds?: number;
    input_filename?: string;
    generated_at?: string;
  };
  clusters: ClusterRow[];
}

function StatisticalMapPanel({ runId, files }: { runId: number; files: RunResultFile[] }) {
  const [data, setData] = useState<ClusterTableJson | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const jsonFile = files.find((f) => f.path.endsWith("cluster_table.json"));
  const overlayFile = files.find((f) => f.path.endsWith("cluster_overlay.png"));

  useEffect(() => {
    if (!jsonFile) { setErr("cluster_table.json not found in run outputs."); return; }
    let cancelled = false;
    fetchRunFile<ClusterTableJson>(runId, jsonFile.path)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Could not load cluster table."); });
    return () => { cancelled = true; };
  }, [runId, jsonFile?.path]);

  if (err) {
    return <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{err}</div>;
  }
  if (!data) {
    return <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500 animate-pulse">Loading cluster results…</div>;
  }

  const meta = data.metadata;
  const clusters = data.clusters;
  const fmt = (v: number | undefined, dec = 3) => (v == null ? "—" : v.toFixed(dec));

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Statistical Map Explorer</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {meta.input_filename ?? "Statistical map"}
            {meta.threshold != null && ` · threshold |z| ≥ ${meta.threshold}`}
            {meta.direction && ` · ${meta.direction}`}
          </p>
        </div>
        <a
          href={`/api/runs/${runId}/files/cluster_report.html`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline shrink-0"
        >
          View cluster report
        </a>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-px bg-gray-100">
        {[
          ["Clusters", String(meta.n_clusters ?? clusters.length)],
          ["Suprathreshold voxels", (meta.n_suprathreshold_voxels ?? "—").toLocaleString()],
          ["Largest cluster", clusters[0] ? String(clusters[0].size_voxels) + " vox" : "—"],
          ["Peak value", clusters[0] ? fmt(clusters[0].peak_value) : "—"],
        ].map(([label, val]) => (
          <div key={label} className="bg-white px-3 py-2">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
            <p className="text-sm font-semibold text-gray-800 font-mono">{val}</p>
          </div>
        ))}
      </div>

      {/* Overlay figure */}
      {overlayFile && (
        <div className="border-t border-gray-100">
          <img
            src={`/api/runs/${runId}/files/${overlayFile.path}`}
            alt="Cluster overlay"
            className="w-full object-contain max-h-[320px]"
          />
        </div>
      )}

      {/* Cluster table */}
      {clusters.length === 0 ? (
        <div className="px-4 py-4 text-sm text-gray-500">No clusters detected above threshold.</div>
      ) : (
        <div className="overflow-x-auto border-t border-gray-100 max-h-[300px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 z-10">
              <tr className="border-b border-gray-200">
                <th className="px-3 py-2 text-left font-medium text-gray-600">#</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Voxels</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Peak</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Mean</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Peak X (mm)</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Peak Y (mm)</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Peak Z (mm)</th>
              </tr>
            </thead>
            <tbody>
              {clusters.map((c) => (
                <tr key={c.cluster_id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-3 py-1.5 text-gray-400">{c.cluster_id}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-700">{c.size_voxels.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-gray-800">{fmt(c.peak_value)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{fmt(c.mean_value)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{fmt(c.peak_x_mm, 1)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{fmt(c.peak_y_mm, 1)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-gray-600">{fmt(c.peak_z_mm, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      <div className="px-3 py-1.5 border-t border-gray-100 flex flex-wrap gap-4 text-[10px] text-gray-400">
        <span>Min cluster size: {meta.min_cluster_size ?? "—"} vox</span>
        {meta.voxel_size_mm && <span>Voxel size: {meta.voxel_size_mm.map((v) => v.toFixed(2)).join(" × ")} mm</span>}
        {meta.nibabel_version && <span>nibabel {meta.nibabel_version}</span>}
        {meta.scipy_version && <span>scipy {meta.scipy_version}</span>}
        <span className="ml-auto text-gray-300">No AI-generated interpretation</span>
      </div>
    </div>
  );
}

// ── NIfTI Inspector panel ──────────────────────────────────────────────────────

interface NiftiInspectorResult {
  input_file?: string;
  file_size_bytes?: number;
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
    qform_name?: string;
    sform_code?: number;
    sform_name?: string;
    intent_name?: string;
    header_version?: string;
    voxel_count?: number;
  };
  stats?: {
    min?: number | null;
    max?: number | null;
    mean?: number | null;
    median?: number | null;
    std?: number | null;
    p5?: number | null;
    p95?: number | null;
    dynamic_range?: number | null;
    nonzero_count?: number;
    nonzero_pct?: number;
    nan_count?: number;
    inf_count?: number;
    background_pct?: number;
  };
  warnings?: Array<{ code: string; severity: string; message: string }>;
  provenance?: {
    nibabel_version?: string;
    inspection_timestamp?: string;
    header_hash?: string;
    runtime_seconds?: number;
  };
}

function NiftiInspectorPanel({ runId, jsonPath, histogramPath }: {
  runId: number;
  jsonPath: string;
  histogramPath?: string;
}) {
  const [result, setResult] = useState<NiftiInspectorResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRunFile<NiftiInspectorResult>(runId, jsonPath)
      .then((d) => { if (!cancelled) setResult(d); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Could not load inspection results"); });
    return () => { cancelled = true; };
  }, [runId, jsonPath]);

  if (err) return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      NIfTI Inspector results could not be loaded: {err}
    </div>
  );
  if (!result) return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500 animate-pulse">
      Loading inspection results…
    </div>
  );

  const h = result.header ?? {};
  const s = result.stats ?? {};
  const warns = result.warnings ?? [];
  const prov = result.provenance ?? {};
  const filename = result.input_file?.split("/").pop() ?? "unknown";
  const fileSizeKb = result.file_size_bytes ? (result.file_size_bytes / 1024).toFixed(1) : "—";

  const fmt = (v: number | null | undefined, dec = 3) =>
    v == null ? "—" : Number.isFinite(v) ? v.toFixed(dec) : String(v);

  const errorWarns = warns.filter((w) => w.severity === "error");
  const otherWarns = warns.filter((w) => w.severity !== "error");

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">NIfTI Inspector</h3>
          <p className="text-xs text-gray-500 font-mono truncate max-w-xs" title={filename}>
            {filename}
          </p>
          <p className="text-xs text-gray-400">
            {h.dimensions?.join(" × ")} vox · {h.voxel_spacing_mm?.map((v) => v.toFixed(2)).join(" × ")} mm
            {h.tr_seconds != null && ` · TR ${h.tr_seconds.toFixed(3)} s`}
            {" · "}{h.datatype} · {h.orientation} · {fileSizeKb} KB
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {warns.length > 0 && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              errorWarns.length > 0
                ? "bg-red-100 text-red-700 border border-red-200"
                : "bg-amber-100 text-amber-700 border border-amber-200"
            }`}>
              {warns.length} warning{warns.length !== 1 ? "s" : ""}
            </span>
          )}
          {warns.length === 0 && (
            <span className="rounded-full px-2 py-0.5 text-xs font-semibold bg-green-100 text-green-700 border border-green-200">
              ✓ No warnings
            </span>
          )}
          <a
            href={`/api/runs/${runId}/files/nifti_report.html`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline"
          >
            View report
          </a>
        </div>
      </div>

      {/* Warnings */}
      {warns.length > 0 && (
        <div className="mb-3 space-y-1">
          {[...errorWarns, ...otherWarns].map((w, i) => (
            <div
              key={i}
              className={`rounded px-3 py-2 text-xs ${
                w.severity === "error"
                  ? "bg-red-50 border border-red-200 text-red-800"
                  : "bg-amber-50 border border-amber-200 text-amber-800"
              }`}
            >
              <span className="font-semibold uppercase mr-1">{w.severity}:</span>
              {w.message}
            </div>
          ))}
        </div>
      )}

      {/* Stats grid */}
      <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {[
          ["Min", fmt(s.min)],
          ["Max", fmt(s.max)],
          ["Mean", fmt(s.mean)],
          ["Median", fmt(s.median)],
          ["Std dev", fmt(s.std)],
          ["Dyn range", fmt(s.dynamic_range)],
          ["Non-zero", s.nonzero_pct != null ? `${s.nonzero_pct.toFixed(1)}%` : "—"],
          ["NaN", String(s.nan_count ?? 0)],
          ["Inf", String(s.inf_count ?? 0)],
          ["p5", fmt(s.p5)],
          ["p95", fmt(s.p95)],
          ["Background", s.background_pct != null ? `${s.background_pct.toFixed(1)}%` : "—"],
        ].map(([label, value]) => (
          <div key={label} className="rounded bg-gray-50 p-2">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="font-mono text-sm font-semibold text-gray-900 truncate">{value}</div>
          </div>
        ))}
      </div>

      {/* Header details (collapsible) */}
      <details className="mb-3 text-xs">
        <summary className="cursor-pointer font-medium text-gray-600 hover:text-gray-800">
          Header details
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3 text-xs">
          {[
            ["NIfTI version", h.header_version],
            ["Datatype", `${h.datatype} (${h.bitpix}bit)`],
            ["Endianness", h.endianness],
            ["Intent", h.intent_name],
            ["qform", `${h.qform_code} (${h.qform_name})`],
            ["sform", `${h.sform_code} (${h.sform_name})`],
            ["Total voxels", h.voxel_count?.toLocaleString()],
            ["nibabel", prov.nibabel_version],
            ["Header hash", prov.header_hash?.slice(0, 20) + "…"],
          ].map(([label, val]) => (
            <div key={label} className="flex gap-1 py-0.5">
              <span className="text-gray-500 shrink-0 w-24">{label}</span>
              <span className="font-mono text-gray-800 truncate">{val ?? "—"}</span>
            </div>
          ))}
        </div>
      </details>

      {/* Histogram */}
      {histogramPath && (
        <div>
          <p className="mb-1 text-xs font-medium text-gray-600">Intensity histogram</p>
          <img
            src={`/api/runs/${runId}/files/${histogramPath}`}
            alt="Intensity histogram"
            className="max-h-[240px] w-full rounded border border-gray-200 object-contain"
          />
        </div>
      )}
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
        <>
          {metadata.confound_strategy && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">Confound strategy:</span>
              <span className="rounded bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-800">
                {metadata.confound_strategy}
              </span>
              {metadata.global_signal_included && (
                <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-800">GSR</span>
              )}
              {metadata.n_confound_regressors !== undefined && (
                <span className="text-xs text-gray-400">{metadata.n_confound_regressors} regressors</span>
              )}
              {metadata.n_volumes_after_cleaning !== undefined && metadata.n_volumes_before_cleaning !== undefined && (
                <span className="text-xs text-gray-400">
                  {metadata.n_volumes_after_cleaning}/{metadata.n_volumes_before_cleaning} volumes retained
                </span>
              )}
            </div>
          )}
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
        </>
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
  size?: number;
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
  const isFmriprep = results.metadata?.pipeline_id === "fmriprep";
  const groupTables = results.group_tables ?? [];
  const images = results.images ?? [];
  const connectivityMatrices = results.connectivity_matrices ?? [];
  const timeseries = results.timeseries ?? [];
  const connectivityMetadata = results.connectivity_metadata ?? [];
  const roiStatistics = results.roi_statistics ?? [];
  const roiExtraction = (results as { roi_extraction?: RunResultFile[] }).roi_extraction ?? [];
  const graphAnalysis = (results as { graph_analysis?: RunResultFile[] }).graph_analysis ?? [];
  const clusterFiles = (results as { cluster_files?: RunResultFile[] }).cluster_files ?? [];
  const hasFiles =
    results.reports.length > 0 ||
    results.metrics.length > 0 ||
    groupTables.length > 0 ||
    images.length > 0 ||
    connectivityMatrices.length > 0 ||
    timeseries.length > 0 ||
    roiStatistics.length > 0 ||
    clusterFiles.length > 0 ||
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

      {isFmriprep && <FmriprepResultsPanel runId={runId} results={results} />}

      {/* IQM summary card */}
      {!isFmriprep && iqmData && <IqmCard data={iqmData} />}

      {/* MRIQC group TSV summary */}
      {groupTables.length > 0 && (
        <MriqcGroupSummary runId={runId} tablePath={groupTables[0].path} />
      )}

      {results.metadata?.pipeline_id === "statistical-map-explorer" ? (
        <StatisticalMapPanel runId={runId} files={clusterFiles} />
      ) : results.metadata?.pipeline_id === "regional-homogeneity" ? (
        <RehoPanel runId={runId} niftis={niftis} images={images} />
      ) : results.metadata?.pipeline_id === "alff-falff" ? (
        <AlffFalffPanel runId={runId} niftis={niftis} images={images} />
      ) : results.metadata?.pipeline_id === "connectome-graph-analysis" && graphAnalysis.length > 0 ? (
        <GraphAnalysisPanel runId={runId} files={graphAnalysis} />
      ) : results.metadata?.pipeline_id === "atlas-roi-extraction" && roiExtraction.length > 0 ? (
        <RoiExtractionPanel runId={runId} files={roiExtraction} />
      ) : results.metadata?.pipeline_id === "nifti-inspector" ? (
        <NiftiInspectorPanel
          runId={runId}
          jsonPath="nifti_inspector.json"
          histogramPath="nifti_histogram.png"
        />
      ) : results.metadata?.pipeline_id === "seed-based-connectivity" ? (
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
      {!isFmriprep && results.reports.length > 0 && (
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
              title={currentReport?.name ?? `${results.metadata?.pipeline_id ?? "Pipeline"} report`}
              sandbox="allow-scripts allow-same-origin allow-popups"
              className="w-full border-0 bg-[#090d18] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
              style={{ height: "75vh" }}
            />
          )}
        </div>
      )}

      {/* Metrics file list (secondary) */}
      {!isFmriprep && results.metrics.length > 0 && (
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

      {roiExtraction.length > 0 && results.metadata?.pipeline_id !== "atlas-roi-extraction" && (
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-xs text-gray-400 hover:text-gray-200">
            ROI extraction files ({roiExtraction.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {roiExtraction.map((file) => (
              <li key={file.path}>
                <a href={`/api/runs/${runId}/files/${file.path}`} target="_blank" rel="noopener noreferrer"
                  className="font-mono text-xs text-blue-600 hover:underline">{file.path}</a>
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
      {!isFmriprep && niftis.length > 0 && (() => {
        const pair = detectLayerPairs(niftis, runId);
        return (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-gray-100 mb-2">
              Volume files ({niftis.length})
            </h3>
            <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 overflow-hidden">
              {niftis.map((f) => {
                // Find host_path for this NIfTI from resolved artifacts so
                // the Inspector can receive a container-local absolute path.
                const matchingArtifact = (results.artifacts ?? []).find(
                  (a) => a.resolved && a.host_paths?.[0] && a.paths?.some((p) => p.endsWith(f.path))
                );
                const hostPath = matchingArtifact?.host_paths?.[0] ?? null;
                const isInspectorRun = results.metadata?.pipeline_id === "nifti-inspector";
                const isRoiExRun = results.metadata?.pipeline_id === "atlas-roi-extraction";
                return (
                  <div
                    key={f.path}
                    className="flex items-center justify-between px-3 py-2 bg-white gap-3"
                  >
                    <span className="text-xs text-gray-700 font-mono truncate">{f.path}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!isInspectorRun && hostPath && (
                        <button
                          onClick={() => navigate("/pipelines", {
                            state: {
                              selectPipeline: "nifti-inspector",
                              prefill: {
                                runId,
                                sourcePipelineId: results.metadata?.pipeline_id ?? "",
                                sourceDisplayName: results.metadata?.pipeline_id ?? "",
                                artifactType: "nifti_raw",
                                artifactLabel: f.name,
                                param: "input-file",
                                path: hostPath,
                                isDatasetSlot: false,
                              },
                            },
                          })}
                          className="rounded border border-emerald-300 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-50 transition-colors"
                          title="Inspect this NIfTI file's header, statistics, and warnings"
                        >
                          Inspect
                        </button>
                      )}
                      {!isRoiExRun && hostPath && (
                        <button
                          onClick={() => navigate("/pipelines", {
                            state: {
                              selectPipeline: "atlas-roi-extraction",
                              prefill: {
                                runId,
                                sourcePipelineId: results.metadata?.pipeline_id ?? "",
                                sourceDisplayName: results.metadata?.pipeline_id ?? "",
                                artifactType: "nifti_raw",
                                artifactLabel: f.name,
                                param: "input-file",
                                path: hostPath,
                                isDatasetSlot: false,
                              },
                            },
                          })}
                          className="rounded border border-violet-300 px-2.5 py-1 text-xs text-violet-700 hover:bg-violet-50 transition-colors"
                          title="Extract per-ROI atlas statistics from this NIfTI file"
                        >
                          Analyze
                        </button>
                      )}
                      <button
                        onClick={() => {
                          const enrichLayer = (layer: NiivueLayer): NiivueLayer => {
                            const runRelativePath = layer.url.split("/files/")[1] ?? layer.name;
                            const artifact = (results.artifacts ?? []).find((candidate) =>
                              candidate.paths?.some((path) => layer.url.endsWith(path) || path.endsWith(runRelativePath))
                            );
                            return {
                              ...layer,
                              artifactType: artifact?.type,
                              pipelineId: results.metadata?.pipeline_id,
                              metadata: results.metadata?.params,
                            };
                          };
                          if (pair && pair.memberNames.includes(f.name)) {
                            setViewerLayers(pair.layers.map(enrichLayer));
                          } else {
                            setViewerLayers([enrichLayer({
                              url: `/api/runs/${runId}/files/${f.path}`,
                              name: f.name,
                              artifactType: matchingArtifact?.type,
                            })]);
                          }
                        }}
                        className="rounded border border-blue-300 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 transition-colors"
                      >
                        View
                      </button>
                    </div>
                  </div>
                );
              })}
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
