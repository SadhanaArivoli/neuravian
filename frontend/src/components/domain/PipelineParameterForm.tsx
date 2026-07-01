import { useState } from "react";
import type { Pipeline, PipelineParameter } from "../../api/client";

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
      placeholder={param.default !== undefined ? String(param.default) : undefined}
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
      out[p.name] = p.default !== undefined ? String(p.default) : "";
    }
  }
  return out;
}

export default function PipelineParameterForm({ pipeline }: Props) {
  const basicParams = pipeline.parameters.filter((p) => !p.advanced);
  const advancedParams = pipeline.parameters.filter((p) => p.advanced);
  const [values, setValues] = useState<FormValues>(() =>
    buildDefaults(pipeline.parameters)
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const set = (name: string, val: string | boolean | string[]) =>
    setValues((prev) => ({ ...prev, [name]: val }));

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Execution is out of scope for M3 — just preview the values.
    setSubmitted(true);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
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
            </div>
          )}
        </div>
      )}

      <div className="pt-2 flex items-center gap-3">
        <button
          type="submit"
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Configure run
        </button>
        {submitted && (
          <p className="text-sm text-gray-500">
            Run execution will be wired up in M4.
          </p>
        )}
      </div>
    </form>
  );
}
