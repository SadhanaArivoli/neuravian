import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CornerDownLeft, ArrowUp } from "lucide-react";
import {
  fetchPipelinePreflight,
  type Pipeline,
  type PipelineParameter,
  type PipelinePreflightResult,
  type PrefillContext,
} from "../../api/client";
import { useDatasets } from "../../hooks/useDatasets";
import { useRemoteHosts } from "../../hooks/useRemoteHosts";
import { useCreateRun, useRuns } from "../../hooks/useRuns";
import { PipelinePreflightPanel } from "./PipelinePreflightPanel";
import { PipelineLaunchReview } from "./PipelineLaunchReview";

interface Props {
  pipeline: Pipeline;
  prefill?: PrefillContext | null;
  paramsOverride?: Record<string, unknown> | null;
  datasetOverride?: number | null;
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
      <div className="rounded-lg border border-white/10 bg-white/[0.035] px-3 py-3 text-sm text-gray-400">
        No successful functional-connectivity runs found. Run the Functional
        Connectivity pipeline first.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="max-h-64 divide-y divide-white/5 overflow-y-auto rounded-lg border border-white/10 bg-surface-raised">
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
                checked ? "bg-accent/15" : "hover:bg-white/5"
              }`}
            >
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/20 bg-surface-overlay text-accent focus:ring-accent"
                checked={checked}
                onChange={() => toggle(run.id)}
              />
              <span className={`text-sm ${checked ? "font-medium text-violet-200" : "text-gray-300"}`}>
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
        className="rounded text-gray-500 transition-colors hover:text-violet-300 focus:outline-none"
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
          className="absolute left-5 top-0 z-50 w-72 rounded-lg border border-white/10 bg-surface-raised p-3 text-xs leading-relaxed text-gray-200 shadow-2xl shadow-black/50"
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
    "w-full rounded-md border border-white/15 bg-surface-overlay px-3 py-2 text-sm text-gray-100 shadow-inner shadow-black/10 placeholder:text-gray-500 focus:border-accent/70 focus:outline-none focus:ring-2 focus:ring-accent/25";

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
          className="h-4 w-4 rounded border-white/20 bg-surface-overlay text-accent focus:ring-accent"
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
                    ? "border-accent/60 bg-accent/15 font-medium text-violet-200"
                    : "border-white/15 bg-white/[0.035] text-gray-400 hover:border-white/25 hover:bg-white/[0.06]"
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
          {prefillOverridden ? <><CornerDownLeft className="mr-1 inline h-3 w-3" />Overridden — was: </> : <ArrowUp className="mr-1 inline h-3 w-3" />}
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

export default function PipelineParameterForm({ pipeline, prefill, paramsOverride, datasetOverride }: Props) {
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

  const [selectedDatasetId, setSelectedDatasetId] = useState<number | "">(datasetOverride ?? "");
  const [remoteHostId, setRemoteHostId] = useState<number | null>(null);
  const [values, setValues] = useState<FormValues>(() => {
    const defaults = buildDefaults(pipeline.parameters);
    // Pre-populate the prefilled parameter from the upstream run artifact.
    if (prefill?.param && prefill.path) {
      defaults[prefill.param] = prefill.path;
    }
    // Duplicate Run: override all params from a prior run.
    if (paramsOverride) {
      for (const [k, v] of Object.entries(paramsOverride)) {
        if (v !== null && v !== undefined) {
          defaults[k] = v as string | boolean | string[];
        }
      }
    }
    return defaults;
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PipelinePreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  // Track whether the user has edited a prefilled field away from its prefilled value.
  const [prefillOverridden, setPrefillOverridden] = useState(false);
  // Review step
  const [showReview, setShowReview] = useState(false);

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

  useEffect(() => {
    if (!selectedDatasetId || remoteHostId) {
      setPreflight(null);
      setPreflightLoading(false);
      setPreflightError(null);
      return;
    }
    const controller = new AbortController();
    setPreflightLoading(true);
    setPreflightError(null);
    const timer = window.setTimeout(() => {
      fetchPipelinePreflight(
        pipeline.id,
        { dataset_id: selectedDatasetId, params: buildParams() },
        controller.signal,
      )
        .then((result) => setPreflight(result))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setPreflight(null);
          setPreflightError(error instanceof Error ? error.message : "Could not run preflight checks.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreflightLoading(false);
        });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [pipeline.id, selectedDatasetId, remoteHostId, values]);

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

    // Show review page — let the user confirm before launching.
    setShowReview(true);
  }

  async function handleLaunchFromReview() {
    setSubmitError(null);
    if (!remoteHostId && preflight && !preflight.can_launch) {
      setSubmitError("Resolve the blocking preflight checks before starting this run.");
      return;
    }
    await doSubmit();
  }

  // Count existing runs for this pipeline + dataset combination
  const { data: allRuns } = useRuns();
  const existingRunCount = (allRuns ?? []).filter(
    (r) =>
      r.pipeline_manifest_id === pipeline.id &&
      r.dataset_id === selectedDatasetId &&
      (r.status === "success" || r.status === "running"),
  ).length;

  const remoteHost = enabledHosts.find((h) => h.id === remoteHostId);

  if (showReview && selectedDataset) {
    return (
      <PipelineLaunchReview
        pipeline={pipeline}
        dataset={selectedDataset}
        subjects={String(values["participant-label"] ?? "")}
        remoteHostName={remoteHost?.display_name ?? null}
        preflight={preflight}
        existingRunCount={existingRunCount}
        launching={createRun.isPending}
        launchError={submitError}
        onBack={() => { setShowReview(false); setSubmitError(null); }}
        onLaunch={() => void handleLaunchFromReview()}
        paramsSnapshot={buildParams()}
      />
    );
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
          className="w-full rounded-md border border-white/15 bg-surface-overlay px-3 py-2 text-sm text-gray-100 shadow-inner shadow-black/10 focus:border-accent/70 focus:outline-none focus:ring-2 focus:ring-accent/25"
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
            className="w-full rounded-md border border-white/15 bg-surface-overlay px-3 py-2 text-sm text-gray-100 shadow-inner shadow-black/10 focus:border-accent/70 focus:outline-none focus:ring-2 focus:ring-accent/25"
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

      <hr className="border-white/8" />

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
            className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-white/[0.035] px-4 py-2.5 text-sm font-medium text-gray-200 transition-colors hover:border-white/20 hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-accent/40"
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
          className="flex gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200"
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

      <PipelinePreflightPanel
        result={preflight}
        loading={preflightLoading}
        error={preflightError}
        remote={remoteHostId !== null}
      />

      {/* Submit error */}
      {submitError && (
        <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {submitError}
        </p>
      )}

      <div className="pt-1">
        <button
          type="submit"
          disabled={createRun.isPending || preflightLoading}
          className="rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-accent/15 transition-all hover:-translate-y-px hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          Review & Launch →
        </button>
      </div>

    </form>
  );
}
