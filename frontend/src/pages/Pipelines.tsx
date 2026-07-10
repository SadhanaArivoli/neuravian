import { useState, useMemo, useEffect } from "react";
import { useLocation } from "react-router-dom";
import type {
  ComputeProfile,
  PipelineCategory,
  PipelineInputType,
  PipelineSummary,
  PrefillContext,
} from "../api/client";
import PipelineParameterForm from "../components/domain/PipelineParameterForm";
import { usePipeline, usePipelines } from "../hooks/usePipelines";

// ── Badge configs ─────────────────────────────────────────────────────────────

const COMPUTE_PROFILE_BADGE: Record<ComputeProfile, { label: string; className: string }> = {
  "local-ok": {
    label: "Local OK",
    className: "bg-green-100 text-green-700 border border-green-200",
  },
  "local-slow": {
    label: "Slow locally",
    className: "bg-amber-100 text-amber-700 border border-amber-200",
  },
  "local-unsafe": {
    label: "Cloud recommended",
    className: "bg-red-100 text-red-700 border border-red-200",
  },
};

const CATEGORY_LABEL: Record<PipelineCategory, string> = {
  conversion: "Conversion",
  validation: "Validation",
  quality_control: "Quality control",
  segmentation: "Segmentation",
  preprocessing: "Preprocessing",
  deidentification: "De-identification",
  connectivity: "Connectivity",
};

const INPUT_TYPE_LABEL: Record<PipelineInputType, { label: string; className: string }> = {
  dicom: {
    label: "DICOM",
    className: "bg-blue-50 text-blue-700 border border-blue-200",
  },
  nifti: {
    label: "NIfTI",
    className: "bg-violet-50 text-violet-700 border border-violet-200",
  },
  bids_dataset: {
    label: "BIDS dataset",
    className: "bg-teal-50 text-teal-700 border border-teal-200",
  },
};

// ── Filter chip ───────────────────────────────────────────────────────────────

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 ${
        active
          ? "border-blue-500 bg-blue-500 text-white"
          : "border-gray-200 bg-white text-gray-600 hover:border-gray-400 hover:text-gray-800"
      }`}
    >
      {label}
    </button>
  );
}

// ── Pipeline card ─────────────────────────────────────────────────────────────

function PipelineCard({
  pipeline,
  selected,
  onSelect,
}: {
  pipeline: PipelineSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-4 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${
        selected
          ? "border-blue-500 bg-blue-50"
          : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-gray-900">{pipeline.display_name}</h3>
            {pipeline.compute_profile && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  COMPUTE_PROFILE_BADGE[pipeline.compute_profile].className
                }`}
              >
                {COMPUTE_PROFILE_BADGE[pipeline.compute_profile].label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {pipeline.category && (
              <span className="text-xs text-gray-400">
                {CATEGORY_LABEL[pipeline.category]}
              </span>
            )}
            {pipeline.category && pipeline.input_type && (
              <span className="text-gray-300 text-xs">·</span>
            )}
            {pipeline.input_type && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                  INPUT_TYPE_LABEL[pipeline.input_type].className
                }`}
              >
                {INPUT_TYPE_LABEL[pipeline.input_type].label}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-gray-500 line-clamp-2">{pipeline.description}</p>
        </div>
        {pipeline.container ? (
          <span
            className="shrink-0 max-w-[40%] truncate rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 font-mono"
            title={`${pipeline.container.image}:${pipeline.container.tag}`}
          >
            {pipeline.container.image}:{pipeline.container.tag}
          </span>
        ) : (
          <span className="shrink-0 rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700 font-mono">
            native
          </span>
        )}
      </div>
      {pipeline.homepage && (
        <a
          href={pipeline.homepage}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-2 inline-block text-xs text-blue-600 hover:underline"
        >
          Documentation ↗
        </a>
      )}
    </button>
  );
}

// ── Pipeline detail panel ─────────────────────────────────────────────────────

function PipelineDetail({ pipelineId, prefill }: { pipelineId: string; prefill: PrefillContext | null }) {
  const { data, isLoading, error } = usePipeline(pipelineId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
        Loading…
      </div>
    );
  }
  if (error || !data) {
    return (
      <p className="text-sm text-red-600">
        {error ? (error as Error).message : "Pipeline not found."}
      </p>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-gray-100 mb-1">{data.display_name}</h2>
      <p className="text-sm text-gray-400 mb-6">{data.description}</p>
      <PipelineParameterForm pipeline={data} prefill={prefill} />
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

const ALL_CATEGORIES = Object.keys(CATEGORY_LABEL) as PipelineCategory[];
const ALL_INPUT_TYPES = Object.keys(INPUT_TYPE_LABEL) as PipelineInputType[];

// ── Main page ─────────────────────────────────────────────────────────────────

type IncomingState = { selectPipeline?: string; prefill?: PrefillContext } | null;

export default function Pipelines() {
  const { data: pipelines, isLoading, error } = usePipelines();
  const location = useLocation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activePrefill, setActivePrefill] = useState<PrefillContext | null>(null);

  // If navigated here from a "Configure →" button on a run results page,
  // auto-select the requested pipeline and store any prefill context.
  // Uses React Router state (not URL params) so no JSON appears in the URL.
  useEffect(() => {
    const state = location.state as IncomingState;
    if (state?.selectPipeline) {
      setSelectedId(state.selectPipeline);
      setActivePrefill(state.prefill ?? null);
      // Clear state so navigating back/forward doesn't re-apply unexpectedly.
      window.history.replaceState({}, "");
    }
  }, [location.state]);

  // Filter state
  const [query, setQuery] = useState("");
  const [activeCategories, setActiveCategories] = useState<Set<PipelineCategory>>(new Set());
  const [activeInputTypes, setActiveInputTypes] = useState<Set<PipelineInputType>>(new Set());
  const [localOkOnly, setLocalOkOnly] = useState(false);

  function toggleCategory(c: PipelineCategory) {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      next.has(c) ? next.delete(c) : next.add(c);
      return next;
    });
  }

  function toggleInputType(t: PipelineInputType) {
    setActiveInputTypes((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  }

  const filtered = useMemo(() => {
    if (!pipelines) return [];
    const q = query.trim().toLowerCase();
    return pipelines.filter((p) => {
      if (q && !p.display_name.toLowerCase().includes(q) && !p.description.toLowerCase().includes(q))
        return false;
      if (activeCategories.size > 0 && (!p.category || !activeCategories.has(p.category)))
        return false;
      if (activeInputTypes.size > 0 && (!p.input_type || !activeInputTypes.has(p.input_type)))
        return false;
      if (localOkOnly && p.compute_profile !== "local-ok") return false;
      return true;
    });
  }, [pipelines, query, activeCategories, activeInputTypes, localOkOnly]);

  const filtersActive =
    query.trim() !== "" ||
    activeCategories.size > 0 ||
    activeInputTypes.size > 0 ||
    localOkOnly;

  function clearFilters() {
    setQuery("");
    setActiveCategories(new Set());
    setActiveInputTypes(new Set());
    setLocalOkOnly(false);
  }

  return (
    <div className="flex h-full">
      {/* Pipeline list + filter bar */}
      <aside className="w-80 shrink-0 border-r border-white/10 flex flex-col">
        {/* Header + search */}
        <div className="p-4 border-b border-white/10 space-y-3">
          <h1 className="text-lg font-semibold text-gray-100">Pipelines</h1>

          {/* Search */}
          <div className="relative">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
            >
              <path
                fillRule="evenodd"
                d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
                clipRule="evenodd"
              />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pipelines…"
              className="w-full rounded-md border border-gray-200 bg-white pl-8 pr-3 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          {/* Category chips */}
          <div>
            <p className="text-xs font-medium text-gray-400 mb-1.5">Category</p>
            <div className="flex flex-wrap gap-1.5">
              {ALL_CATEGORIES.map((c) => (
                <FilterChip
                  key={c}
                  label={CATEGORY_LABEL[c]}
                  active={activeCategories.has(c)}
                  onClick={() => toggleCategory(c)}
                />
              ))}
            </div>
          </div>

          {/* Input type chips */}
          <div>
            <p className="text-xs font-medium text-gray-400 mb-1.5">Input data</p>
            <div className="flex flex-wrap gap-1.5">
              {ALL_INPUT_TYPES.map((t) => (
                <FilterChip
                  key={t}
                  label={INPUT_TYPE_LABEL[t].label}
                  active={activeInputTypes.has(t)}
                  onClick={() => toggleInputType(t)}
                />
              ))}
            </div>
          </div>

          {/* Local-OK toggle */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <button
              type="button"
              role="switch"
              aria-checked={localOkOnly}
              onClick={() => setLocalOkOnly((v) => !v)}
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1 ${
                localOkOnly ? "bg-green-500" : "bg-gray-200"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  localOkOnly ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
            <span className="text-xs text-gray-300">
              Local OK only
            </span>
          </label>

          {/* Clear filters */}
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-blue-400 hover:text-blue-200 focus:outline-none"
            >
              Clear all filters
            </button>
          )}
        </div>

        {/* Pipeline list */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && (
            <p className="text-sm text-gray-400">Loading manifests…</p>
          )}
          {error && (
            <p className="text-sm text-red-600">{(error as Error).message}</p>
          )}

          {!isLoading && !error && (
            <>
              {filtered.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="text-sm text-gray-400">No pipelines match these filters.</p>
                  {filtersActive && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="mt-2 text-xs text-blue-400 hover:text-blue-200 focus:outline-none"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              ) : (
                <ul className="space-y-2">
                  {filtered.map((p) => (
                    <li key={p.id}>
                      <PipelineCard
                        pipeline={p}
                        selected={selectedId === p.id}
                        onSelect={() => {
                          const next = selectedId === p.id ? null : p.id;
                          setSelectedId(next);
                          // Clicking a card manually clears any Router-state prefill.
                          setActivePrefill(null);
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {pipelines && filtered.length > 0 && filtered.length < (pipelines.length) && (
                <p className="mt-3 text-xs text-center text-gray-400">
                  {filtered.length} of {pipelines.length} pipelines
                </p>
              )}
            </>
          )}
        </div>
      </aside>

      {/* Detail / parameter form panel */}
      <main className="flex-1 overflow-y-auto p-8">
        {selectedId ? (
          <PipelineDetail pipelineId={selectedId} prefill={activePrefill} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-gray-500">
              Select a pipeline on the left to configure a run.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
