import { useState } from "react";
import { useRunFile, useRunResults, useRuns } from "../../hooks/useRuns";
import NiivueViewer, { type NiivueLayer } from "./NiivueViewer";
import RunMetadataPanel from "./RunMetadataPanel";
import RunNextCard from "./RunNextCard";
import { findVerifiedSibling } from "../../lib/comparisonEligibility";

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

  // Smart Compare button: detect single verified sibling for this run
  const thisRun = allRuns?.find((r) => r.id === runId) ?? null;
  const otherSuccessRuns = (allRuns ?? []).filter((r) => r.id !== runId && r.status === "success");
  const verifiedSibling = thisRun ? findVerifiedSibling(thisRun, otherSuccessRuns) : null;

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
  const hasFiles = results.reports.length > 0 || results.metrics.length > 0 || niftis.length > 0;
  // Show Download All when any surfaced file or resolved artifact exists.
  // Resolved artifacts may live in output_dir (e.g. bids-validator writes validation-report.txt)
  // even when they aren't classified as report/metric/nifti.
  const hasDownloadable = hasFiles || (results.artifacts ?? []).some((a) => a.resolved);

  const currentReport = results.reports[activeReport];
  const reportUrl = currentReport
    ? `/api/runs/${runId}/files/${currentReport.path}`
    : null;

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-gray-100">Results</h2>
        <div className="flex items-center gap-2">
          {/* Compare button — shown when this run produced volumetric outputs.
              When exactly one verified sibling exists, pre-fills Run B in the URL. */}
          {niftis.length > 0 && (
            <a
              href={
                verifiedSibling
                  ? `/compare?a=${runId}&b=${verifiedSibling.id}`
                  : `/compare?a=${runId}`
              }
              title={verifiedSibling ? `Comparable: verified same-source run found (run #${verifiedSibling.id})` : undefined}
              className="flex items-center gap-1.5 rounded border border-violet-600/50 bg-violet-600/10 px-3 py-1.5 text-xs font-medium text-violet-300 hover:border-violet-500 hover:text-violet-200 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path d="M6.5 2.75a.75.75 0 0 0-1.5 0v10.5a.75.75 0 0 0 1.5 0V2.75ZM11 5.5a.75.75 0 0 0-1.5 0v7.75a.75.75 0 0 0 1.5 0V5.5ZM2 8.25a.75.75 0 0 0 0 1.5h12a.75.75 0 0 0 0-1.5H2Z" />
              </svg>
              {verifiedSibling
                ? `Compare with ${verifiedSibling.pipeline_manifest_id}`
                : "Compare"}
            </a>
          )}
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
