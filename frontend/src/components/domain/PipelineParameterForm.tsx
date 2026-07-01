import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Pipeline, PipelineParameter } from "../../api/client";
import { useDatasets } from "../../hooks/useDatasets";
import { useCreateRun } from "../../hooks/useRuns";

interface Props {
  pipeline: Pipeline;
}

type FormValues = Record<string, string | boolean | string[]>;

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

  if (param.type === "boolean") {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={value as boolean}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-700">Enabled</span>
      </label>
    );
  }

  if (param.type === "select") {
    return (
      <select
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
    return (
      <div className="flex flex-wrap gap-2">
        {(param.options ?? []).map((opt) => {
          const checked = selected.includes(opt);
          return (
            <label
              key={opt}
              className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-sm cursor-pointer transition-colors ${
                checked
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-gray-300 bg-white text-gray-700 hover:border-gray-400"
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
              {opt}
            </label>
          );
        })}
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
      value={value as string}
      onChange={(e) => onChange(e.target.value)}
      placeholder={
        param.default !== undefined && param.default !== null
          ? String(param.default)
          : undefined
      }
      className={baseInput}
    />
  );
}

function buildDefaults(params: PipelineParameter[]): FormValues {
  const out: FormValues = {};
  for (const p of params) {
    if (p.type === "boolean") {
      out[p.name] = (p.default as boolean) ?? false;
    } else if (p.type === "multiselect") {
      out[p.name] = (p.default as string[]) ?? [];
    } else {
      out[p.name] = p.default !== undefined && p.default !== null ? String(p.default) : "";
    }
  }
  return out;
}

export default function PipelineParameterForm({ pipeline }: Props) {
  const navigate = useNavigate();
  const { data: datasets } = useDatasets();
  const createRun = useCreateRun();

  const basicParams = pipeline.parameters.filter((p) => !p.advanced);
  const advancedParams = pipeline.parameters.filter((p) => p.advanced);

  const [selectedDatasetId, setSelectedDatasetId] = useState<number | "">("");
  const [values, setValues] = useState<FormValues>(() =>
    buildDefaults(pipeline.parameters)
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const set = (name: string, val: string | boolean | string[]) =>
    setValues((prev) => ({ ...prev, [name]: val }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (!selectedDatasetId) {
      setSubmitError("Please select a dataset before starting a run.");
      return;
    }

    // Coerce form values back to native types for the API
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

    try {
      const run = await createRun.mutateAsync({
        pipeline_id: pipeline.id,
        dataset_id: selectedDatasetId as number,
        params,
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to start run.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Dataset selector */}
      <div>
        <label className="block text-sm font-medium text-gray-800 mb-1">
          Dataset <span className="text-red-500">*</span>
        </label>
        <p className="text-xs text-gray-500 mb-1.5">
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

      <hr className="border-gray-200" />

      {/* Pipeline parameters */}
      {basicParams.map((param) => (
        <div key={param.name}>
          <label className="block text-sm font-medium text-gray-800 mb-1">
            {param.name}
            {param.required && (
              <span className="ml-1 text-red-500" aria-label="required">
                *
              </span>
            )}
          </label>
          {param.help && (
            <p className="text-xs text-gray-500 mb-1.5">{param.help}</p>
          )}
          <ParameterField
            param={param}
            value={values[param.name]}
            onChange={(v) => set(param.name, v)}
          />
        </div>
      ))}

      {advancedParams.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="text-sm text-blue-600 hover:underline focus:outline-none"
          >
            {showAdvanced ? "Hide" : "Show"} advanced options (
            {advancedParams.length})
          </button>
          {showAdvanced && (
            <div className="mt-4 space-y-5 border-l-2 border-gray-200 pl-4">
              {advancedParams.map((param) => (
                <div key={param.name}>
                  <label className="block text-sm font-medium text-gray-800 mb-1">
                    {param.name}
                    {param.required && (
                      <span className="ml-1 text-red-500">*</span>
                    )}
                  </label>
                  {param.help && (
                    <p className="text-xs text-gray-500 mb-1.5">{param.help}</p>
                  )}
                  <ParameterField
                    param={param}
                    value={values[param.name]}
                    onChange={(v) => set(param.name, v)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {submitError && (
        <p className="rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {submitError}
        </p>
      )}

      <div className="pt-2">
        <button
          type="submit"
          disabled={createRun.isPending}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {createRun.isPending ? "Starting…" : "Start run"}
        </button>
      </div>
    </form>
  );
}
