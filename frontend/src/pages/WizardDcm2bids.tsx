import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { scoutDicom } from "../api/client";
import type { WizardDiscoveredSeries, WizardScoutResponse } from "../api/client";

// ── Confidence badge ──────────────────────────────────────────────────────────

const CONFIDENCE: Record<string, { label: string; className: string }> = {
  high:   { label: "High confidence",   className: "bg-green-100 text-green-700 border border-green-200" },
  medium: { label: "Medium confidence", className: "bg-amber-100 text-amber-700 border border-amber-200" },
  low:    { label: "Low confidence",    className: "bg-red-100 text-red-700 border border-red-200" },
};

// ── Modality icon ─────────────────────────────────────────────────────────────

function ModalityIcon({ modality }: { modality: string }) {
  const m = modality.toLowerCase();
  // Brain outline SVG for structural; wave for functional; dots for diffusion; etc.
  if (m.includes("t1") || m.includes("structural")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-violet-400">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (m.includes("flair") || m.includes("t2")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-blue-400">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (m.includes("fmri") || m.includes("bold") || m.includes("resting") || m.includes("task")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-emerald-400">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    );
  }
  if (m.includes("diffusion") || m.includes("dwi") || m.includes("dti")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-cyan-400">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    );
  }
  if (m.includes("fieldmap") || m.includes("fmap")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-orange-400">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
      </svg>
    );
  }
  if (m.includes("localizer") || m.includes("scout")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-gray-500">
        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
      </svg>
    );
  }
  // Unknown / default
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-gray-500">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
    </svg>
  );
}

// ── Advanced metadata table ───────────────────────────────────────────────────

function AdvancedMetadata({ s }: { s: WizardDiscoveredSeries }) {
  const rows: Array<[string, string | number | null | undefined]> = [
    ["SeriesDescription", s.series_description],
    ["ProtocolName", s.protocol_name],
    ["SeriesNumber", s.series_number],
    ["AcquisitionTime", s.acquisition_time],
    ["TR (RepetitionTime)", s.tr != null ? `${s.tr} s` : null],
    ["TE (EchoTime)", s.te != null ? `${s.te} s` : null],
    ["InversionTime", s.inversion_time != null ? `${s.inversion_time} s` : null],
    ["FlipAngle", s.flip_angle != null ? `${s.flip_angle}°` : null],
    ["EchoNumber", s.echo_number],
    ["PhaseEncodingDirection", s.phase_encoding_direction],
    ["ImageType", s.image_type?.join(" / ")],
    ["Manufacturer", s.manufacturer],
    ["ManufacturersModelName", s.manufacturers_model_name],
    ["MagneticFieldStrength", s.magnetic_field_strength != null ? `${s.magnetic_field_strength} T` : null],
    ["SliceThickness", s.slice_thickness != null ? `${s.slice_thickness} mm` : null],
  ];

  return (
    <div className="mt-3 rounded border border-white/10 bg-surface-overlay p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">Raw DICOM metadata</p>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, val]) =>
          val != null ? (
            <div key={label} className="contents">
              <dt className="text-[11px] text-gray-500 self-start">{label}</dt>
              <dd className="text-[11px] font-mono text-gray-300 break-all">{String(val)}</dd>
            </div>
          ) : null
        )}
      </dl>
    </div>
  );
}

// ── Series card ───────────────────────────────────────────────────────────────

function SeriesCard({
  s,
  index,
  showAdvanced,
}: {
  s: WizardDiscoveredSeries;
  index: number;
  showAdvanced: boolean;
}) {
  const { classification: c } = s;
  const badge = CONFIDENCE[c.confidence] ?? CONFIDENCE.low;
  const isSkip = c.skip_recommended;

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        isSkip
          ? "border-white/5 bg-surface-raised opacity-60"
          : "border-white/10 bg-surface-raised"
      }`}
    >
      {/* Header row */}
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <ModalityIcon modality={c.modality} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-sm font-semibold text-gray-100 truncate">
              {c.modality}
            </span>
            {isSkip && (
              <span className="rounded-full bg-gray-700/60 px-2 py-0.5 text-[10px] font-medium text-gray-400 border border-white/10">
                Skip recommended
              </span>
            )}
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}>
              {badge.label}
            </span>
          </div>

          <p className="text-xs text-gray-400 mb-1">
            {s.series_description
              ? <><span className="text-gray-300 font-mono">{s.series_description}</span></>
              : <span className="italic text-gray-500">No series description</span>
            }
            {s.series_number != null && (
              <span className="ml-2 text-gray-600">· #{s.series_number}</span>
            )}
          </p>

          <p className="text-[11px] text-gray-500 italic">{c.reason}</p>

          {/* Quick stats (always visible) */}
          {(s.tr != null || s.te != null || (s.image_type?.length ?? 0) > 0) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {s.tr != null && (
                <span className="text-[11px] text-gray-500">TR <span className="text-gray-300 font-mono">{s.tr}s</span></span>
              )}
              {s.te != null && (
                <span className="text-[11px] text-gray-500">TE <span className="text-gray-300 font-mono">{s.te}s</span></span>
              )}
              {s.manufacturer && (
                <span className="text-[11px] text-gray-500">{s.manufacturer}</span>
              )}
            </div>
          )}
        </div>

        {/* Series index badge */}
        <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-mono text-gray-500">
          {String(index + 1).padStart(2, "0")}
        </span>
      </div>

      {/* Advanced metadata — only when toggle is on */}
      {showAdvanced && <AdvancedMetadata s={s} />}
    </div>
  );
}

// ── Input field helper ────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-200 mb-1">
        {label}
        {required && <span className="ml-1 text-red-400">*</span>}
      </label>
      {hint && <p className="text-xs text-gray-500 mb-1.5">{hint}</p>}
      {children}
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-white/10 bg-surface-overlay px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent/50";

// ── Summary bar ───────────────────────────────────────────────────────────────

function SummaryBar({ series }: { series: WizardDiscoveredSeries[] }) {
  const counts: Record<string, number> = {};
  for (const s of series) {
    counts[s.classification.confidence] = (counts[s.classification.confidence] ?? 0) + 1;
  }

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-white/10 bg-surface-raised px-4 py-3 mb-4">
      <span className="text-sm font-medium text-gray-200">
        {series.length} series discovered
      </span>
      <div className="flex gap-2">
        {counts.high != null && (
          <span className="rounded-full bg-green-100 text-green-700 border border-green-200 px-2 py-0.5 text-xs font-medium">
            {counts.high} high
          </span>
        )}
        {counts.medium != null && (
          <span className="rounded-full bg-amber-100 text-amber-700 border border-amber-200 px-2 py-0.5 text-xs font-medium">
            {counts.medium} medium
          </span>
        )}
        {counts.low != null && (
          <span className="rounded-full bg-red-100 text-red-700 border border-red-200 px-2 py-0.5 text-xs font-medium">
            {counts.low} low / unknown
          </span>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WizardDcm2bids() {
  const [dicomPath, setDicomPath] = useState("");
  const [participantId, setParticipantId] = useState("sub-01");
  const [sessionId, setSessionId] = useState("");
  const [datasetName, setDatasetName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [scoutResult, setScoutResult] = useState<WizardScoutResponse | null>(null);

  const scout = useMutation({
    mutationFn: () => scoutDicom(dicomPath.trim(), participantId.trim(), sessionId.trim() || undefined),
    onSuccess: (data) => setScoutResult(data),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setScoutResult(null);
    scout.mutate();
  }

  return (
    <div className="p-6 max-w-3xl">
      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-accent">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
          </svg>
          <h2 className="text-2xl font-semibold text-white">DICOM Mapping Wizard</h2>
        </div>
        <p className="text-sm text-gray-400 max-w-xl">
          Convert raw DICOM scans into a BIDS dataset without manually writing a config.json.
          Start by selecting your DICOM folder — NeuroForge will discover and classify every series automatically.
        </p>
      </div>

      {/* Input form */}
      <div className="rounded-xl border border-white/10 bg-surface-raised p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-200 mb-4">Step 1 — Choose DICOM source</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field
            label="DICOM folder"
            required
            hint="Full path to the folder containing DICOM files from the scanner. Must be inside your configured data directory."
          >
            <input
              className={inputCls}
              type="text"
              value={dicomPath}
              onChange={(e) => setDicomPath(e.target.value)}
              placeholder="/Users/you/Documents/MRI/sub-01/DICOM"
              required
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Participant ID"
              required
              hint="BIDS subject label (e.g. sub-01)"
            >
              <input
                className={inputCls}
                type="text"
                value={participantId}
                onChange={(e) => setParticipantId(e.target.value)}
                placeholder="sub-01"
                required
              />
            </Field>

            <Field
              label="Session ID"
              hint="Optional BIDS session label (e.g. ses-01)"
            >
              <input
                className={inputCls}
                type="text"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder="ses-01 (optional)"
              />
            </Field>
          </div>

          <Field
            label="Dataset name"
            hint="A friendly name for this study — used in dataset_description.json"
          >
            <input
              className={inputCls}
              type="text"
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
              placeholder="My MRI Study"
            />
          </Field>

          <div className="pt-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={scout.isPending || !dicomPath.trim() || !participantId.trim()}
              className="rounded-md bg-accent px-5 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {scout.isPending ? (
                <>
                  <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Scanning series…
                </>
              ) : (
                <>
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" />
                  </svg>
                  Scout DICOM Series
                </>
              )}
            </button>

            {scoutResult && (
              <button
                type="button"
                onClick={() => setScoutResult(null)}
                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                Clear results
              </button>
            )}
          </div>

          {scout.isError && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              <p className="font-medium mb-1">Scout failed</p>
              <p className="text-xs text-red-400">
                {scout.error instanceof Error ? scout.error.message : String(scout.error)}
              </p>
            </div>
          )}
        </form>
      </div>

      {/* Results */}
      {scoutResult && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-200">Discovered series</h3>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                showAdvanced
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-white/10 bg-surface-raised text-gray-400 hover:text-gray-200"
              }`}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                <path fillRule="evenodd" d="M6.5 1.75a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5H8.75V4h.75a3.5 3.5 0 1 1 0 7h-.75v1.25h.25a.75.75 0 0 1 0 1.5h-1.5a.75.75 0 0 1 0-1.5H7.75V11H7a3.5 3.5 0 1 1 0-7h.75V2.5H7.25a.75.75 0 0 1-.75-.75ZM7 5.5a2 2 0 1 0 0 4h.75v-4H7Zm1.75 4h.75a2 2 0 0 0 0-4h-.75v4Z" clipRule="evenodd" />
              </svg>
              {showAdvanced ? "Hide advanced details" : "Show advanced details"}
            </button>
          </div>

          <SummaryBar series={scoutResult.series} />

          <div className="space-y-3">
            {scoutResult.series.length === 0 ? (
              <div className="rounded-lg border border-white/10 bg-surface-raised p-6 text-center text-sm text-gray-500">
                No series were discovered. Check that the DICOM folder contains valid .dcm files.
              </div>
            ) : (
              scoutResult.series.map((s, i) => (
                <SeriesCard
                  key={`${s.series_number}-${s.acquisition_time}-${i}`}
                  s={s}
                  index={i}
                  showAdvanced={showAdvanced}
                />
              ))
            )}
          </div>

          {/* dcm2bids_helper log — collapsed */}
          {scoutResult.helper_log && (
            <details className="mt-4 rounded-lg border border-white/10 overflow-hidden">
              <summary className="cursor-pointer select-none px-4 py-2 text-xs text-gray-500 hover:bg-white/5 transition-colors list-none">
                Show dcm2bids_helper log
              </summary>
              <pre className="px-4 py-3 text-[11px] font-mono text-gray-400 bg-surface-overlay whitespace-pre-wrap break-all overflow-x-auto max-h-64 overflow-y-auto">
                {scoutResult.helper_log}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
