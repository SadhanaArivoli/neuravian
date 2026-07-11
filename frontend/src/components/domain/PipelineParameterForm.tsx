import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { ComputeProfile, Pipeline, PipelineParameter, PrefillContext } from "../../api/client";
import { useDatasets } from "../../hooks/useDatasets";
import { useRemoteHosts } from "../../hooks/useRemoteHosts";
import { useCreateRun, useRuns } from "../../hooks/useRuns";

interface Props {
  pipeline: Pipeline;
  prefill?: PrefillContext | null;
}

type FormValues = Record<string, string | boolean | string[]>;

// ── Multi-run selector (for group-functional-connectivity input-run-ids) ──────

function MultiRunSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const { data: allRuns } = useRuns();
  const selectedIds = new Set(
    value.split(",").map((s) => s.trim()).filter(Boolean).map(Number)
  );

  // Filter for successful functional-connectivity runs only
  const fcRuns = (allRuns ?? []).filter(
    (r) =>
      r.status === "success" &&
      r.pipeline_manifest_id === "functional-connectivity",
  );

  function toggle(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(Array.from(next).sort((a, b) => a - b).join(","));
  }

  if (fcRuns.length === 0) {
    return (
      <div className="rounded border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-500">
        No successful functional-connectivity runs found. Run the Functional
        Connectivity pipeline first.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="rounded border border-gray-200 bg-white divide-y divide-gray-100 max-h-64 overflow-y-auto">
        {fcRuns.map((run) => {
          const checked = selectedIds.has(run.id);
          const date = run.finished_at
            ? new Date(run.finished_at.endsWith("Z") ? run.finished_at : run.finished_at + "Z")
                .toLocaleDateString()
            : "—";
          return (
            <label
              key={run.id}
              className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors ${
                checked ? "bg-blue-50" : "hover:bg-gray-50"
              }`}
            >
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                checked={checked}
                onChange={() => toggle(run.id)}
              />
              <span className={`text-sm ${checked ? "text-blue-700 font-medium" : "text-gray-700"}`}>
                Run #{run.id}
              </span>
              <span className="text-xs text-gray-400 ml-auto">{date}</span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-gray-400">
        {selectedIds.size} of {fcRuns.length} selected
        {selectedIds.size < 2 && selectedIds.size > 0 && (
          <span className="ml-1 text-amber-600">— select at least 2 runs</span>
        )}
      </p>
    </div>
  );
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

function HelpTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex items-center ml-1.5 align-middle">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className="text-gray-400 hover:text-blue-500 focus:outline-none transition-colors"
        aria-label="Help"
      >
        {/* Info circle icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="w-3.5 h-3.5"
        >
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div
          className="absolute left-5 top-0 z-50 w-72 rounded-lg border border-gray-200 bg-white p-3 text-xs leading-relaxed text-gray-700 shadow-lg"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          {text}
        </div>
      )}
    </span>
  );
}

// ── Field control ─────────────────────────────────────────────────────────────

function ParameterField({
  param,
  value,
  onChange,
}: {
  param: PipelineParameter;
  value: string | boolean | string[];
  onChange: (val: string | boolean | string[]) => void;
}) {
  const baseInput =
    "w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

  // Special case: multi-run selector for group FC input
  if (param.name === "input-run-ids") {
    return (
      <MultiRunSelector
        value={value as string}
        onChange={(v) => onChange(v)}
      />
    );
  }

  if (param.type === "boolean") {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          id={`param-${param.name}`}
          name={param.name}
          checked={value as boolean}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-200">Enabled</span>
      </label>
    );
  }

  if (param.type === "select") {
    return (
      <select
        id={`param-${param.name}`}
        name={param.name}
        value={value as string}
        onChange={(e) => onChange(e.target.value)}
        className={baseInput}
      >
        {!param.required && <option value="">— not set —</option>}
        {(param.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (param.type === "multiselect") {
    const selected = (value as string[]) ?? [];
    const options = param.options ?? [];
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-2">
          {options.map((opt) => {
            const checked = selected.includes(opt);
            return (
              <label
                key={opt}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm cursor-pointer transition-colors select-none ${
                  checked
                    ? "border-blue-500 bg-blue-50 text-blue-700 font-medium"
                    : "border-gray-300 bg-white text-gray-600 hover:border-blue-300 hover:bg-blue-50/50"
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  onChange={() => {
                    const next = checked
                      ? selected.filter((s) => s !== opt)
                      : [...selected, opt];
                    onChange(next);
                  }}
                />
                {checked && (
                  <svg className="w-3 h-3 shrink-0" viewBox="0 0 12 12" fill="currentColor">
                    <path d="M10.28 2.28a.75.75 0 0 0-1.06 0L4.5 6.997 2.78 5.28a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.06 0l5.25-5.25a.75.75 0 0 0 0-1.06Z" />
                  </svg>
                )}
                {opt}
              </label>
            );
          })}
        </div>
        {selected.length === 0 && (
          <p className="text-xs text-amber-600">Nothing selected — leave blank to use tool default.</p>
        )}
        {selected.length > 0 && (
          <p className="text-xs text-gray-400">
            {selected.length} of {options.length} selected
          </p>
        )}
      </div>
    );
  }

  const inputType =
    param.type === "integer" || param.type === "float" ? "number" : "text";
  const step = param.type === "float" ? "any" : undefined;

  return (
    <input
      type={inputType}
      step={step}
      id={`param-${param.name}`}
      name={param.name}
      autoComplete="off"
      value={value as string}
      onChange={(e) => onChange(e.target.value)}
      placeholder={
        param.default !== undefined && param.default !== null
          ? `default: ${String(param.default)}`
          : undefined
      }
      className={baseInput}
    />
  );
}

// ── Parameter row (label + tooltip + field) ───────────────────────────────────

function ParameterRow({
  param,
  value,
  onChange,
  prefillText,
  prefillOverridden,
}: {
  param: PipelineParameter;
  value: string | boolean | string[];
  onChange: (val: string | boolean | string[]) => void;
  prefillText?: string;
  prefillOverridden?: boolean;
}) {
  return (
    <div>
      <label htmlFor={`param-${param.name}`} className="flex items-center text-sm font-medium text-gray-200 mb-1.5">
        <span>{param.name}</span>
        {param.required && (
          <span className="ml-1 text-red-500" aria-label="required">*</span>
        )}
        {param.help && <HelpTooltip text={param.help} />}
      </label>
      <ParameterField param={param} value={value} onChange={onChange} />
      {prefillText && (
        <p className={`mt-1 text-xs ${prefillOverridden ? "text-amber-600" : "text-purple-500"}`}>
          {prefillOverridden ? "↩ Overridden — was: " : "↑ "}
          {prefillText}
          {prefillOverridden && ""}
        </p>
      )}
    </div>
  );
}

// ── Warnings ─────────────────────────────────────────────────────────────────

function buildWarnings(
  pipeline: Pipeline,
  values: FormValues,
  selectedDataset: { subject_count: number } | undefined,
): { key: string; message: React.ReactNode }[] {
  const warnings: { key: string; message: React.ReactNode }[] = [];
  const params = pipeline.parameters;

  // participant-label blank on multi-subject dataset
  const hasParticipantLabel = params.some((p) => p.name === "participant-label");
  if (hasParticipantLabel && selectedDataset) {
    const val = String(values["participant-label"] ?? "").trim();
    const count = selectedDataset.subject_count;
    if (!val && count > 1) {
      const nprocs = Math.max(1, Number(values["nprocs"]) || 1);
      const totalMin = Math.ceil(count / nprocs) * 20;
      const runtime =
        totalMin < 60
          ? `~${totalMin} min`
          : `~${Math.floor(totalMin / 60)}h${totalMin % 60 > 0 ? ` ${totalMin % 60}m` : ""}`;
      warnings.push({
        key: "participant-label-blank",
        message: (
          <>
            <span className="font-semibold">No participant label set</span> —{" "}
            {pipeline.display_name} will process all {count} subjects. Estimated
            runtime: <span className="font-semibold">{runtime}</span> at nprocs=
            {String(values["nprocs"] ?? 1)}. Set{" "}
            <code className="font-mono text-xs bg-amber-100 px-1 rounded">
              participant-label
            </code>{" "}
            to a single subject ID (e.g.{" "}
            <code className="font-mono text-xs bg-amber-100 px-1 rounded">01</code>)
            to test on one subject first.
          </>
        ),
      });
    }
  }

  // mem too low for pipelines that declare it (fMRIPrep, etc.)
  const memParam = params.find((p) => p.name === "mem");
  if (memParam) {
    const memVal = parseInt(String(values["mem"] ?? ""), 10);
    if (!isNaN(memVal) && memVal < 4000) {
      warnings.push({
        key: "mem-too-low",
        message: (
          <>
            <span className="font-semibold">
              mem={memVal} MB is likely too low
            </span>{" "}
            — {pipeline.display_name} needs at least 6000 MB (6 GB) to avoid
            out-of-memory crashes. The default of 6000 is calibrated for a 7.8 GB
            Docker allocation. Increase Docker memory in Docker Desktop → Settings
            → Resources if you want to raise this.
          </>
        ),
      });
    }
  }

  return warnings;
}

// ── Pre-flight confirmation dialog ────────────────────────────────────────────

const PREFLIGHT_COPY: Record<
  "local-slow" | "local-unsafe",
  { title: string; body: string; cta: string }
> = {
  "local-slow": {
    title: "This pipeline will run slowly on Apple Silicon",
    body:
      "FastSurfer's CNN inference runs under Rosetta 2 x86_64 emulation on Apple Silicon Macs. " +
      "Confirmed runtime is ~154 seconds per batch × 256 batches × 3 orientations = approximately 33 hours " +
      "per subject (vs 30–90 minutes on native x86_64 Linux). " +
      "The run is healthy and will eventually complete — just plan for an overnight computation. " +
      "If you need results sooner, run on native x86_64 hardware.",
    cta: "Start anyway (will take ~33h)",
  },
  "local-unsafe": {
    title: "This pipeline may hang indefinitely on Apple Silicon",
    body:
      "fMRIPrep's spatial normalisation step (ANTs SyN registration with correlation-coefficient metric) " +
      "requires AVX2/AVX-512 SIMD instructions. Under Rosetta 2 emulation these instructions are not fully " +
      "supported: confirmed runs 14–15 stalled at 99.9% CPU utilisation for over 6 hours with no progress. " +
      "The run will likely never complete on this machine. Consider using native x86_64 hardware " +
      "or a cloud/HPC environment.",
    cta: "Start anyway (may hang)",
  },
};

function PreflightDialog({
  pipeline,
  onConfirm,
  onCancel,
}: {
  pipeline: Pipeline;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const profile = pipeline.compute_profile as "local-slow" | "local-unsafe" | undefined;
  if (!profile || !(profile in PREFLIGHT_COPY)) return null;
  const copy = PREFLIGHT_COPY[profile];
  const isUnsafe = profile === "local-unsafe";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl border border-gray-200 mx-4">
        <div className={`flex items-start gap-3 rounded-t-xl px-5 pt-5 pb-4 ${isUnsafe ? "bg-red-50" : "bg-amber-50"}`}>
          <span className="text-xl mt-0.5">{isUnsafe ? "⛔" : "⏱"}</span>
          <div>
            <h3 className={`font-semibold text-base ${isUnsafe ? "text-red-800" : "text-amber-800"}`}>
              {copy.title}
            </h3>
            <p className="mt-1 text-sm text-gray-700 leading-relaxed">{copy.body}</p>
          </div>
        </div>
        <div className="flex justify-end gap-3 px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-1 transition-colors ${
              isUnsafe
                ? "bg-red-600 hover:bg-red-700 focus:ring-red-500"
                : "bg-amber-600 hover:bg-amber-700 focus:ring-amber-500"
            }`}
          >
            {copy.cta}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Defaults ──────────────────────────────────────────────────────────────────

function buildDefaults(params: PipelineParameter[]): FormValues {
  const out: FormValues = {};
  for (const p of params) {
    if (p.type === "boolean") {
      out[p.name] = (p.default as boolean) ?? false;
    } else if (p.type === "multiselect") {
      out[p.name] = (p.default as string[]) ?? [];
    } else {
      out[p.name] =
        p.default !== undefined && p.default !== null ? String(p.default) : "";
    }
  }
  return out;
}

// ── Main form ─────────────────────────────────────────────────────────────────

export default function PipelineParameterForm({ pipeline, prefill }: Props) {
  const navigate = useNavigate();
  const { data: datasets } = useDatasets();
  const createRun = useCreateRun();

  // Positional params with only one option are not user-configurable — hide them
  const visibleParams = pipeline.parameters.filter(
    (p) =>
      !p.internal &&
      !(
        p.positional_index !== undefined &&
        (p.options ?? []).length <= 1
      )
  );

  const basicParams = visibleParams.filter((p) => !p.advanced);
  const advancedParams = visibleParams.filter((p) => p.advanced);

  const { data: remoteHosts = [] } = useRemoteHosts();
  const enabledHosts = remoteHosts.filter((h) => h.enabled);

  const [selectedDatasetId, setSelectedDatasetId] = useState<number | "">("");
  const [remoteHostId, setRemoteHostId] = useState<number | null>(null);
  const [values, setValues] = useState<FormValues>(() => {
    const defaults = buildDefaults(pipeline.parameters);
    // Pre-populate the prefilled parameter from the upstream run artifact.
    if (prefill?.param && prefill.path) {
      defaults[prefill.param] = prefill.path;
    }
    return defaults;
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showPreflightDialog, setShowPreflightDialog] = useState(false);
  // Track whether the user has edited a prefilled field away from its prefilled value.
  const [prefillOverridden, setPrefillOverridden] = useState(false);

  const set = (name: string, val: string | boolean | string[]) => {
    setValues((prev) => ({ ...prev, [name]: val }));
    if (prefill?.param === name) {
      setPrefillOverridden(val !== prefill.path);
    }
  };

  const selectedDataset = (datasets ?? []).find(
    (ds) => ds.id === selectedDatasetId
  );

  const warnings = buildWarnings(pipeline, values, selectedDataset);

  function buildParams(): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    for (const p of pipeline.parameters) {
      const raw = values[p.name];
      if (p.type === "integer") {
        const n = parseInt(raw as string, 10);
        if (!isNaN(n)) params[p.name] = n;
      } else if (p.type === "float") {
        const n = parseFloat(raw as string);
        if (!isNaN(n)) params[p.name] = n;
      } else if (raw !== "" && raw !== undefined) {
        params[p.name] = raw;
      }
    }
    return params;
  }

  async function doSubmit() {
    setSubmitError(null);
    try {
      const run = await createRun.mutateAsync({
        pipeline_id: pipeline.id,
        dataset_id: selectedDatasetId as number,
        params: buildParams(),
        lineage: prefill
          ? {
              upstream_run_id: prefill.runId,
              upstream_pipeline_id: prefill.sourcePipelineId,
              upstream_pipeline_display_name: prefill.sourceDisplayName,
              artifact_type: prefill.artifactType,
              artifact_label: prefill.artifactLabel,
              injected_param: prefill.param ?? null,
              injected_path: prefill.path ?? null,
            }
          : null,
        remote_host_id: remoteHostId,
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to start run."
      );
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (!selectedDatasetId) {
      setSubmitError("Please select a dataset before starting a run.");
      return;
    }

    // Skip the local performance warning when running on a remote host
    const profile = pipeline.compute_profile as ComputeProfile | undefined;
    if (!remoteHostId && (profile === "local-slow" || profile === "local-unsafe")) {
      setShowPreflightDialog(true);
      return;
    }

    // TODO: Pre-flight BIDS validation suggestion
    // Before submitting MRIQC, fMRIPrep, FastSurfer, or any pipeline that
    // requires a valid BIDS dataset, check whether the selected dataset has a
    // recent successful BIDS Validator run (within the last N days). If not,
    // surface a non-blocking suggestion: "This pipeline works best with a
    // validated BIDS dataset. Run BIDS Validator first?" with a "Skip" option.
    // Implementation: query GET /api/runs?pipeline_id=bids-validator&dataset_id=X
    // and check for a recent status=success entry. The manifest can declare
    // `preflight_for: ["mriqc", "fmriprep", "fastsurfer"]` to drive this logic
    // without hardcoding pipeline IDs here.

    void doSubmit();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Dataset selector */}
      <div>
        <label className="block text-sm font-medium text-gray-200 mb-1">
          Dataset <span className="text-red-400">*</span>
        </label>
        <p className="text-xs text-gray-400 mb-1.5">
          Select which imported dataset to run {pipeline.display_name} on.
        </p>
        <select
          value={selectedDatasetId}
          onChange={(e) =>
            setSelectedDatasetId(e.target.value ? Number(e.target.value) : "")
          }
          className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          required
        >
          <option value="">— choose a dataset —</option>
          {(datasets ?? []).map((ds) => (
            <option key={ds.id} value={ds.id}>
              {ds.name ?? ds.path} ({ds.subject_count} subjects ·{" "}
              {ds.validation_status})
            </option>
          ))}
        </select>
      </div>

      {/* Provenance note for dataset-slot pipelines (MRIQC, fMRIPrep) navigated from Run Next.
          These pipelines receive input via the dataset selector, not a named parameter,
          so path prefill is not possible — prompt the user to select manually. */}
      {prefill?.isDatasetSlot && (
        <div className="flex gap-2.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2.5 text-sm text-purple-800">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 shrink-0 mt-0.5 text-purple-500">
            <path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.253a.25.25 0 0 1 .244.304l-.459 2.066A1.75 1.75 0 0 0 10.747 15H11a.75.75 0 0 0 0-1.5h-.253a.25.25 0 0 1-.244-.304l.459-2.066A1.75 1.75 0 0 0 9.253 9H9Z" clipRule="evenodd" />
          </svg>
          <span>
            Suggested from run #{prefill.runId} ({prefill.sourceDisplayName} · {prefill.artifactLabel}).
            Select the appropriate BIDS dataset in the selector above.
          </span>
        </div>
      )}

      {/* Execution target — only shown for Docker pipelines when remote hosts exist */}
      {pipeline.container && enabledHosts.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-gray-200 mb-1">
            Execution target
          </label>
          <p className="text-xs text-gray-400 mb-1.5">
            Run locally in Docker or offload to a configured remote host via SSH.
          </p>
          <select
            value={remoteHostId ?? ""}
            onChange={(e) => setRemoteHostId(e.target.value ? Number(e.target.value) : null)}
            className="w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Local (this machine)</option>
            {enabledHosts.map((h) => (
              <option key={h.id} value={h.id}>
                Remote: {h.display_name} ({h.hostname})
              </option>
            ))}
          </select>
          {remoteHostId && (pipeline.compute_profile === "local-slow" || pipeline.compute_profile === "local-unsafe") && (
            <p className="mt-1 text-xs text-green-400">
              Remote execution recommended for this pipeline.
            </p>
          )}
        </div>
      )}

      <hr className="border-gray-200" />

      {/* Basic parameters */}
      {basicParams.map((param) => {
        const isPrefilled = prefill?.param === param.name && !prefill.isDatasetSlot;
        const helperText = isPrefilled
          ? `From run #${prefill!.runId} · ${prefill!.sourceDisplayName} · ${prefill!.artifactLabel}`
          : undefined;
        return (
          <ParameterRow
            key={param.name}
            param={param}
            value={values[param.name]}
            onChange={(v) => set(param.name, v)}
            prefillText={helperText}
            prefillOverridden={isPrefilled && prefillOverridden}
          />
        );
      })}

      {/* Advanced parameters accordion */}
      {advancedParams.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-400 transition-colors"
            aria-expanded={showAdvanced}
          >
            <span>Advanced options</span>
            <span className="flex items-center gap-2 text-gray-400 text-xs font-normal">
              {advancedParams.length} parameters
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className={`w-4 h-4 transition-transform duration-150 ${showAdvanced ? "rotate-180" : ""}`}
              >
                <path
                  fillRule="evenodd"
                  d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
                  clipRule="evenodd"
                />
              </svg>
            </span>
          </button>

          {showAdvanced && (
            <div className="mt-2 rounded-lg border border-white/10 bg-white/5 p-4 space-y-5">
              <p className="text-xs text-gray-400 -mt-1">
                These settings are safe to leave at their defaults for most runs.
                Change them only if you know what you need.
              </p>
              {advancedParams.map((param) => {
                const isPrefilled = prefill?.param === param.name && !prefill.isDatasetSlot;
                const helperText = isPrefilled
                  ? `From run #${prefill!.runId} · ${prefill!.sourceDisplayName} · ${prefill!.artifactLabel}`
                  : undefined;
                return (
                  <ParameterRow
                    key={param.name}
                    param={param}
                    value={values[param.name]}
                    onChange={(v) => set(param.name, v)}
                    prefillText={helperText}
                    prefillOverridden={isPrefilled && prefillOverridden}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Warnings */}
      {warnings.map((w) => (
        <div
          key={w.key}
          className="flex gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4 shrink-0 mt-0.5 text-amber-500"
          >
            <path
              fillRule="evenodd"
              d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
              clipRule="evenodd"
            />
          </svg>
          <span>{w.message}</span>
        </div>
      ))}

      {/* Submit error */}
      {submitError && (
        <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {submitError}
        </p>
      )}

      <div className="pt-1">
        <button
          type="submit"
          disabled={createRun.isPending}
          className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {createRun.isPending ? "Starting…" : "Start run"}
        </button>
      </div>

      {/* Pre-flight confirmation dialog for local-slow / local-unsafe pipelines */}
      {showPreflightDialog && (
        <PreflightDialog
          pipeline={pipeline}
          onConfirm={() => {
            setShowPreflightDialog(false);
            void doSubmit();
          }}
          onCancel={() => setShowPreflightDialog(false)}
        />
      )}
    </form>
  );
}
