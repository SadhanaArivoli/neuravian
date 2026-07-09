import { useState } from "react";
import { useRunFile, useRunResults } from "../../hooks/useRuns";
import NiivueViewer, { type NiivueLayer } from "./NiivueViewer";

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

/** Detect a FastSurfer base+segmentation pair and return pre-wired NiivueLayer[].
 *  Returns null when the file list doesn't look like FastSurfer output. */
function detectFastSurferLayers(
  niftis: RunResultFile[],
  runId: number
): NiivueLayer[] | null {
  const base = niftis.find(
    (f) => f.name === "orig.mgz" || f.name === "T1.mgz"
  );
  const seg = niftis.find(
    (f) =>
      f.name === "aseg.auto.mgz" ||
      (f.name.includes("aseg") && f.name.endsWith(".mgz")) ||
      (f.name.includes("aparc") && f.name.endsWith(".mgz"))
  );
  if (!base || !seg) return null;
  return [
    { url: `/api/runs/${runId}/files/${base.path}`, name: base.name },
    {
      url: `/api/runs/${runId}/files/${seg.path}`,
      name: seg.name,
      isSegmentation: true,
      opacity: 0.7,
    },
  ];
}

interface Props {
  runId: number;
}

export default function RunResults({ runId }: Props) {
  const { data: results, isLoading, error } = useRunResults(runId, true);
  const [activeReport, setActiveReport] = useState(0);
  const [viewerLayers, setViewerLayers] = useState<NiivueLayer[] | null>(null);

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

  if (results.reports.length === 0 && results.metrics.length === 0 && niftis.length === 0) {
    return (
      <div className="mt-4 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Run completed but no output files were found in the output directory.
        This may indicate the pipeline exited before writing its outputs — check the log above.
      </div>
    );
  }

  const currentReport = results.reports[activeReport];
  const reportUrl = currentReport
    ? `/api/runs/${runId}/files/${currentReport.path}`
    : null;

  return (
    <div className="mt-4">
      <h2 className="text-base font-semibold text-gray-100 mb-3">Results</h2>

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
          FastSurfer pairs (orig.mgz + aseg) are opened as a 2-layer overlay;
          all other files open as single-volume. */}
      {niftis.length > 0 && (
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
                    const fastSurferLayers = detectFastSurferLayers(niftis, runId);
                    if (
                      fastSurferLayers &&
                      (f.name === fastSurferLayers[0].name || f.name === fastSurferLayers[1].name)
                    ) {
                      setViewerLayers(fastSurferLayers);
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
          {(() => {
            const fastSurferLayers = detectFastSurferLayers(niftis, runId);
            return fastSurferLayers ? (
              <p className="mt-2 text-xs text-gray-400">
                FastSurfer output detected — clicking orig.mgz or aseg files opens base + segmentation overlay.
              </p>
            ) : null;
          })()}
        </div>
      )}

      {/* NiivueViewer modal */}
      {viewerLayers && (
        <NiivueViewer
          layers={viewerLayers}
          onClose={() => setViewerLayers(null)}
        />
      )}
    </div>
  );
}
