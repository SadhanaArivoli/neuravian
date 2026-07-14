import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { scoutDicom, launchDcm2bids } from "../api/client";
import type { WizardDiscoveredSeries, WizardScoutResponse } from "../api/client";

// ── Mapping types ─────────────────────────────────────────────────────────────

interface SeriesMapping {
  included: boolean;
  datatype: string;
  suffix: string;
  taskName: string;
}

type MappingMap = Record<number, SeriesMapping>;

// ── Datatype / suffix options ─────────────────────────────────────────────────

const DATATYPES = ["anat", "func", "dwi", "fmap", "perf", "beh"] as const;

const SUFFIXES: Record<string, string[]> = {
  anat: ["T1w", "T2w", "FLAIR", "T2starw", "PDw", "T1map", "T2map", "MEGRE", "inplaneT1"],
  func: ["bold", "sbref", "cbv"],
  dwi:  ["dwi", "sbref"],
  fmap: ["phasediff", "magnitude1", "magnitude2", "phase1", "phase2", "fieldmap", "epi", "TB1map"],
  perf: ["asl", "m0scan"],
  beh:  ["events", "physio", "stim", "beh"],
};

function defaultSuffix(datatype: string, current: string): string {
  const opts = SUFFIXES[datatype] ?? [];
  return opts.includes(current) ? current : (opts[0] ?? "");
}

// ── Config generation ─────────────────────────────────────────────────────────

interface ConfigDescription {
  datatype: string;
  suffix: string;
  criteria: Record<string, string>;
  custom_entities?: string;
  sidecar_changes?: Record<string, unknown>;
}

interface GeneratedConfig {
  descriptions: ConfigDescription[];
}

function generateConfig(
  series: WizardDiscoveredSeries[],
  mappings: MappingMap,
): GeneratedConfig {
  const descriptions: ConfigDescription[] = [];

  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const m = mappings[i];
    if (!m?.included) continue;

    const entry: ConfigDescription = {
      datatype: m.datatype,
      suffix: m.suffix,
      criteria: {
        SeriesDescription: s.series_description ?? "",
      },
    };

    const sidecar_changes: Record<string, unknown> = {};

    if (m.datatype === "anat" && m.suffix === "T1w") {
      sidecar_changes["SkullStripped"] = false;
    }

    const task = m.taskName.trim();
    if (m.datatype === "func" && m.suffix === "bold" && task) {
      entry.custom_entities = `task-${task}`;
      sidecar_changes["TaskName"] = task;
    }

    if (Object.keys(sidecar_changes).length > 0) {
      entry.sidecar_changes = sidecar_changes;
    }

    descriptions.push(entry);
  }

  return { descriptions };
}

// ── Validation ────────────────────────────────────────────────────────────────

interface ValidationIssue {
  index: number;
  message: string;
}

function validateMappings(
  series: WizardDiscoveredSeries[],
  mappings: MappingMap,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (let i = 0; i < series.length; i++) {
    const m = mappings[i];
    if (!m?.included) continue;
    if (m.datatype === "func" && m.suffix === "bold" && !m.taskName.trim()) {
      issues.push({ index: i, message: "Task name required for BOLD series" });
    }
  }
  return issues;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function initMappings(series: WizardDiscoveredSeries[]): MappingMap {
  const m: MappingMap = {};
  for (let i = 0; i < series.length; i++) {
    const c = series[i].classification;
    const datatype = c.suggested_datatype ?? "anat";
    const suffix = c.suggested_suffix ?? (SUFFIXES[datatype]?.[0] ?? "");
    m[i] = {
      included: !c.skip_recommended && c.confidence !== "low",
      datatype,
      suffix,
      taskName: "",
    };
  }
  return m;
}

// ── Confidence badge ──────────────────────────────────────────────────────────

const CONFIDENCE: Record<string, { label: string; className: string }> = {
  high:   { label: "High confidence",   className: "bg-green-100 text-green-700 border border-green-200" },
  medium: { label: "Medium confidence", className: "bg-amber-100 text-amber-700 border border-amber-200" },
  low:    { label: "Low confidence",    className: "bg-red-100 text-red-700 border border-red-200" },
};

// ── Modality icon ─────────────────────────────────────────────────────────────

function ModalityIcon({ modality }: { modality: string }) {
  const m = modality.toLowerCase();
  if (m.includes("t1") || m.includes("structural")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5 text-violet-400">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (m.includes("flair") || m.includes("t2")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5 text-blue-400">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (m.includes("fmri") || m.includes("bold") || m.includes("resting") || m.includes("task")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5 text-emerald-400">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
      </svg>
    );
  }
  if (m.includes("diffusion") || m.includes("dwi") || m.includes("dti")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5 text-cyan-400">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    );
  }
  if (m.includes("fieldmap") || m.includes("fmap")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5 text-orange-400">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
      </svg>
    );
  }
  if (m.includes("localizer") || m.includes("scout")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5 text-gray-500">
        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5 text-gray-500">
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
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2">
        Raw DICOM metadata
      </p>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, val]) =>
          val != null ? (
            <div key={label} className="contents">
              <dt className="text-[11px] text-gray-500 self-start">{label}</dt>
              <dd className="text-[11px] font-mono text-gray-300 break-all">{String(val)}</dd>
            </div>
          ) : null,
        )}
      </dl>
    </div>
  );
}

// ── Select primitive ──────────────────────────────────────────────────────────

const selectCls =
  "rounded border border-white/10 bg-surface-overlay px-2 py-1 text-xs text-gray-200 focus:outline-none focus:ring-1 focus:ring-accent/50 cursor-pointer";

// ── Mapping card ──────────────────────────────────────────────────────────────

function MappingCard({
  s,
  index,
  mapping,
  validationIssue,
  showAdvanced,
  onChange,
}: {
  s: WizardDiscoveredSeries;
  index: number;
  mapping: SeriesMapping;
  validationIssue: string | null;
  showAdvanced: boolean;
  onChange: (patch: Partial<SeriesMapping>) => void;
}) {
  const { classification: c } = s;
  const badge = CONFIDENCE[c.confidence] ?? CONFIDENCE.low;
  const suffixOptions = SUFFIXES[mapping.datatype] ?? [];
  const needsTaskName = mapping.datatype === "func" && mapping.suffix === "bold";

  function handleDatatypeChange(dt: string) {
    const newSuffix = defaultSuffix(dt, mapping.suffix);
    onChange({ datatype: dt, suffix: newSuffix });
  }

  return (
    <div
      className={`rounded-lg border transition-colors ${
        mapping.included
          ? "border-white/10 bg-surface-raised"
          : "border-white/5 bg-surface-raised opacity-50"
      }`}
    >
      {/* ── Top bar: include toggle + modality label ── */}
      <div className="flex items-center gap-3 px-4 pt-3 pb-2 border-b border-white/5">
        {/* Toggle */}
        <button
          type="button"
          aria-label={mapping.included ? "Skip this series" : "Include this series"}
          onClick={() => onChange({ included: !mapping.included })}
          className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
            mapping.included ? "bg-accent" : "bg-gray-700"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              mapping.included ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
        <span className="text-xs font-medium text-gray-400 w-12 shrink-0">
          {mapping.included ? "Include" : "Skip"}
        </span>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <ModalityIcon modality={c.modality} />
          <span className="text-sm font-semibold text-gray-100 truncate">{c.modality}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}>
            {badge.label}
          </span>
        </div>

        <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-mono text-gray-500">
          {String(index + 1).padStart(2, "0")}
        </span>
      </div>

      {/* ── Body ── */}
      <div className="px-4 py-3 space-y-3">
        {/* Series description + reason */}
        <div>
          <p className="text-xs text-gray-400">
            {s.series_description ? (
              <span className="font-mono text-gray-300">{s.series_description}</span>
            ) : (
              <span className="italic text-gray-600">No series description</span>
            )}
            {s.series_number != null && (
              <span className="ml-2 text-gray-600">· #{s.series_number}</span>
            )}
          </p>
          <p className="text-[11px] text-gray-500 italic mt-0.5">{c.reason}</p>
        </div>

        {/* Quick stats */}
        {(s.tr != null || s.te != null) && (
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            {s.tr != null && (
              <span className="text-[11px] text-gray-500">
                TR <span className="text-gray-300 font-mono">{s.tr}s</span>
              </span>
            )}
            {s.te != null && (
              <span className="text-[11px] text-gray-500">
                TE <span className="text-gray-300 font-mono">{s.te}s</span>
              </span>
            )}
            {s.manufacturer && (
              <span className="text-[11px] text-gray-500">{s.manufacturer}</span>
            )}
          </div>
        )}

        {/* Mapping controls — only when included */}
        {mapping.included && (
          <div className="rounded border border-white/10 bg-surface-overlay px-3 py-2.5 space-y-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              BIDS mapping
            </p>

            <div className="flex flex-wrap items-center gap-3">
              {/* Datatype */}
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-gray-500 shrink-0">Datatype</label>
                <select
                  aria-label="Datatype"
                  value={mapping.datatype}
                  onChange={(e) => handleDatatypeChange(e.target.value)}
                  className={selectCls}
                >
                  {DATATYPES.map((dt) => (
                    <option key={dt} value={dt}>{dt}</option>
                  ))}
                </select>
              </div>

              {/* Suffix */}
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-gray-500 shrink-0">Suffix</label>
                <select
                  aria-label="Suffix"
                  value={mapping.suffix}
                  onChange={(e) => onChange({ suffix: e.target.value })}
                  className={selectCls}
                >
                  {suffixOptions.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              {/* BIDS path preview */}
              <span className="text-[11px] font-mono text-gray-500 truncate">
                → {mapping.datatype}/{mapping.suffix}
              </span>
            </div>

            {/* Task name — only for func/bold */}
            {needsTaskName && (
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-gray-500 shrink-0">
                  Task name <span className="text-red-400">*</span>
                </label>
                <input
                  aria-label="Task name"
                  type="text"
                  value={mapping.taskName}
                  onChange={(e) => onChange({ taskName: e.target.value })}
                  placeholder="rest, learning, memory…"
                  className="rounded border border-white/10 bg-surface-raised px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-accent/50 w-40"
                />
                <span className="text-[11px] text-gray-600 font-mono">
                  {mapping.taskName.trim() ? `task-${mapping.taskName.trim()}` : "task-?"}
                </span>
              </div>
            )}

            {/* Validation warning */}
            {validationIssue && (
              <div className="flex items-center gap-1.5 text-amber-400 text-[11px]">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                  <path fillRule="evenodd" d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                </svg>
                {validationIssue}
              </div>
            )}

            {/* Injected sidecar_changes preview */}
            {mapping.datatype === "anat" && mapping.suffix === "T1w" && (
              <p className="text-[11px] text-gray-500">
                Injects <code className="font-mono text-gray-400">SkullStripped: false</code> into sidecar automatically.
              </p>
            )}
          </div>
        )}

        {/* Advanced metadata */}
        {showAdvanced && <AdvancedMetadata s={s} />}
      </div>
    </div>
  );
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function SummaryBar({
  series,
  mappings,
}: {
  series: WizardDiscoveredSeries[];
  mappings: MappingMap;
}) {
  const counts: Record<string, number> = {};
  for (const s of series) {
    counts[s.classification.confidence] = (counts[s.classification.confidence] ?? 0) + 1;
  }
  const includedCount = Object.values(mappings).filter((m) => m.included).length;

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
      <span className="ml-auto text-xs text-gray-500">
        {includedCount} of {series.length} included
      </span>
    </div>
  );
}

// ── Config preview ────────────────────────────────────────────────────────────

function ConfigPreview({
  series,
  mappings,
}: {
  series: WizardDiscoveredSeries[];
  mappings: MappingMap;
}) {
  const issues = validateMappings(series, mappings);
  const config = generateConfig(series, mappings);
  const json = JSON.stringify(config, null, 2);
  const includedCount = config.descriptions.length;

  function download() {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dcm2bids_config.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-xl border border-white/10 bg-surface-raised overflow-hidden mt-6">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-gray-400">
            <path fillRule="evenodd" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h7A2.5 2.5 0 0 1 14 2.5v11a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 13.5v-11Zm2.5-1a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-11a1 1 0 0 0-1-1h-7ZM5 5.75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 5.75Zm0 3a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 8.75Zm0 3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5h-2A.75.75 0 0 1 5 11.75Z" clipRule="evenodd" />
          </svg>
          <h3 className="text-sm font-semibold text-gray-200">Preview Config</h3>
          <span className="text-xs text-gray-500">dcm2bids_config.json</span>
        </div>
        <button
          type="button"
          onClick={download}
          disabled={includedCount === 0 || issues.length > 0}
          aria-label="Download config.json"
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M8.75 2.75a.75.75 0 0 0-1.5 0v5.69L5.03 6.22a.75.75 0 0 0-1.06 1.06l3.5 3.5a.75.75 0 0 0 1.06 0l3.5-3.5a.75.75 0 0 0-1.06-1.06L8.75 8.44V2.75Z" />
            <path d="M3.5 9.75a.75.75 0 0 0-1.5 0v1.5A2.75 2.75 0 0 0 4.75 14h6.5A2.75 2.75 0 0 0 14 11.25v-1.5a.75.75 0 0 0-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-1.5Z" />
          </svg>
          Download config.json
        </button>
      </div>

      {/* Validation warnings */}
      {issues.length > 0 && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20">
          {issues.map((iss) => (
            <div key={iss.index} className="flex items-center gap-1.5 text-amber-400 text-xs">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                <path fillRule="evenodd" d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
              </svg>
              Series {iss.index + 1}: {iss.message}
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {includedCount === 0 && issues.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-gray-500">
          No series included — toggle at least one series to generate a config.
        </div>
      )}

      {/* JSON preview */}
      {includedCount > 0 && (
        <pre
          aria-label="config preview"
          className="px-4 py-3 text-[11px] font-mono text-gray-300 overflow-x-auto whitespace-pre leading-relaxed max-h-96 overflow-y-auto"
        >
          {json}
        </pre>
      )}
    </div>
  );
}

// ── Input field helper ────────────────────────────────────────────────────────

function Field({
  htmlFor,
  label,
  hint,
  required,
  children,
}: {
  htmlFor: string;
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-200 mb-1">
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WizardDcm2bids() {
  const navigate = useNavigate();
  const [dicomPath, setDicomPath] = useState("");
  const [participantId, setParticipantId] = useState("sub-01");
  const [sessionId, setSessionId] = useState("");
  const [datasetName, setDatasetName] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [scoutResult, setScoutResult] = useState<WizardScoutResponse | null>(null);
  const [mappings, setMappings] = useState<MappingMap>({});

  const scout = useMutation({
    mutationFn: () =>
      scoutDicom(dicomPath.trim(), participantId.trim(), sessionId.trim() || undefined),
    onSuccess: (data) => {
      setScoutResult(data);
    },
  });

  const launch = useMutation({
    mutationFn: () => {
      const config = generateConfig(scoutResult!.series, mappings);
      return launchDcm2bids(
        dicomPath.trim(),
        participantId.trim(),
        sessionId.trim() || null,
        datasetName.trim(),
        config as unknown as Record<string, unknown>,
      );
    },
    onSuccess: (data) => {
      navigate(`/runs/${data.run_id}`);
    },
  });

  // Initialise mappings whenever new scout results arrive
  useEffect(() => {
    if (scoutResult) {
      setMappings(initMappings(scoutResult.series));
    }
  }, [scoutResult]);

  const updateMapping = useCallback(
    (index: number, patch: Partial<SeriesMapping>) => {
      setMappings((prev) => ({
        ...prev,
        [index]: { ...prev[index], ...patch },
      }));
    },
    [],
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setScoutResult(null);
    setMappings({});
    scout.mutate();
  }

  const issues = scoutResult
    ? validateMappings(scoutResult.series, mappings)
    : [];
  const issueMap: Record<number, string> = {};
  for (const iss of issues) issueMap[iss.index] = iss.message;

  return (
    <div className="p-6 max-w-3xl">
      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-6 h-6 text-accent">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
          </svg>
          <h1 className="text-2xl font-semibold text-white">DICOM Mapping Wizard</h1>
        </div>
        <p className="text-sm text-gray-400 max-w-xl">
          Convert raw DICOM scans into a BIDS dataset without manually writing a config.json.
          Start by selecting your DICOM folder — NeuroForge will discover and classify every series automatically.
        </p>
      </div>

      {/* Step 1 — Input form */}
      <div className="rounded-xl border border-white/10 bg-surface-raised p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-200 mb-4">Step 1 — Choose DICOM source</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field
            htmlFor="dicom-path"
            label="DICOM folder"
            required
            hint="Full path to the folder containing DICOM files from the scanner. Must be inside your configured data directory."
          >
            <input
              id="dicom-path"
              className={inputCls}
              type="text"
              value={dicomPath}
              onChange={(e) => setDicomPath(e.target.value)}
              placeholder="/Users/you/Documents/MRI/DICOM"
              required
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field
              htmlFor="participant-id"
              label="Participant ID"
              required
              hint="BIDS subject label (e.g. sub-01)"
            >
              <input
                id="participant-id"
                className={inputCls}
                type="text"
                value={participantId}
                onChange={(e) => setParticipantId(e.target.value)}
                placeholder="sub-01"
                required
              />
            </Field>

            <Field
              htmlFor="session-id"
              label="Session ID"
              hint="Optional BIDS session label (e.g. ses-01)"
            >
              <input
                id="session-id"
                className={inputCls}
                type="text"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder="ses-01 (optional)"
              />
            </Field>
          </div>

          <Field
            htmlFor="dataset-name"
            label="Dataset name"
            hint="A friendly name for this study — used in dataset_description.json"
          >
            <input
              id="dataset-name"
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
                onClick={() => { setScoutResult(null); setMappings({}); }}
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

      {/* Step 2 — Review mappings */}
      {scoutResult && (
        <div>
          {/* Section header + advanced toggle */}
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-200">
              Step 2 — Review Mappings
            </h3>
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

          <SummaryBar series={scoutResult.series} mappings={mappings} />

          {/* Mapping cards */}
          <div className="space-y-3">
            {scoutResult.series.length === 0 ? (
              <div className="rounded-lg border border-white/10 bg-surface-raised p-6 text-center text-sm text-gray-500">
                No series were discovered. Check that the DICOM folder contains valid .dcm files.
              </div>
            ) : (
              scoutResult.series.map((s, i) => (
                <MappingCard
                  key={`${s.series_number}-${s.acquisition_time}-${i}`}
                  s={s}
                  index={i}
                  mapping={mappings[i] ?? { included: false, datatype: "anat", suffix: "T1w", taskName: "" }}
                  validationIssue={issueMap[i] ?? null}
                  showAdvanced={showAdvanced}
                  onChange={(patch) => updateMapping(i, patch)}
                />
              ))
            )}
          </div>

          {/* Config preview */}
          <ConfigPreview series={scoutResult.series} mappings={mappings} />

          {/* Step 3 — Run dcm2bids */}
          {(() => {
            const config = generateConfig(scoutResult.series, mappings);
            const validationIssues = validateMappings(scoutResult.series, mappings);
            const canLaunch =
              config.descriptions.length > 0 &&
              validationIssues.length === 0 &&
              !launch.isPending;
            return (
              <div className="mt-6 rounded-xl border border-white/10 bg-surface-raised overflow-hidden">
                <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-gray-400">
                    <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z" />
                  </svg>
                  <h3 className="text-sm font-semibold text-gray-200">Step 3 — Run dcm2bids</h3>
                </div>

                <div className="px-4 py-4 space-y-3">
                  {/* Summary of what will run */}
                  <div className="rounded-lg border border-white/10 bg-surface-overlay px-3 py-2.5 space-y-1.5 text-xs text-gray-400">
                    <div className="flex gap-2">
                      <span className="text-gray-600 w-28 shrink-0">DICOM folder</span>
                      <span className="font-mono text-gray-300 break-all">{dicomPath.trim()}</span>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-gray-600 w-28 shrink-0">Participant</span>
                      <span className="font-mono text-gray-300">{participantId.trim()}</span>
                    </div>
                    {sessionId.trim() && (
                      <div className="flex gap-2">
                        <span className="text-gray-600 w-28 shrink-0">Session</span>
                        <span className="font-mono text-gray-300">{sessionId.trim()}</span>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <span className="text-gray-600 w-28 shrink-0">Series to convert</span>
                      <span className="text-gray-300">{config.descriptions.length} included</span>
                    </div>
                  </div>

                  <p className="text-xs text-gray-500">
                    NeuroForge will save the generated config and launch dcm2bids in Docker.
                    The output BIDS dataset will be available as a run artifact — you can then
                    chain to BIDS Validator directly from the run results page.
                  </p>

                  {/* Blockers */}
                  {config.descriptions.length === 0 && (
                    <div className="flex items-center gap-1.5 text-amber-400 text-xs">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                        <path fillRule="evenodd" d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                      </svg>
                      Include at least one series above to enable the run.
                    </div>
                  )}
                  {validationIssues.length > 0 && (
                    <div className="flex items-center gap-1.5 text-amber-400 text-xs">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                        <path fillRule="evenodd" d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
                      </svg>
                      Fix {validationIssues.length} mapping issue{validationIssues.length !== 1 ? "s" : ""} above before running.
                    </div>
                  )}

                  {/* Launch error */}
                  {launch.isError && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
                      <p className="font-medium mb-0.5">Launch failed</p>
                      <p className="text-red-400">
                        {launch.error instanceof Error ? launch.error.message : String(launch.error)}
                      </p>
                    </div>
                  )}

                  {/* Launch button */}
                  <button
                    type="button"
                    aria-label="Run dcm2bids"
                    disabled={!canLaunch}
                    onClick={() => launch.mutate()}
                    className="flex items-center gap-2 rounded-md bg-accent px-5 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {launch.isPending ? (
                      <>
                        <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Launching…
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                          <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z" />
                        </svg>
                        Run dcm2bids
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })()}

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
