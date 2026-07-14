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
import { pipelineIcon, WorkbenchIcons } from "../lib/iconRegistry";

// ── Badge configs ─────────────────────────────────────────────────────────────

const COMPUTE_PROFILE_BADGE: Record<ComputeProfile, { label: string; className: string }> = {
  "local-ok": {
    label: "Local OK",
    className: "bg-green-500/10 text-green-300 border border-green-500/20",
  },
  "local-slow": {
    label: "Slow locally",
    className: "bg-amber-500/10 text-amber-300 border border-amber-500/20",
  },
  "local-unsafe": {
    label: "Cloud recommended",
    className: "bg-red-500/10 text-red-300 border border-red-500/20",
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
    className: "bg-blue-500/10 text-blue-300 border border-blue-500/20",
  },
  nifti: {
    label: "NIfTI",
    className: "bg-violet-500/10 text-violet-300 border border-violet-500/20",
  },
  bids_dataset: {
    label: "BIDS dataset",
    className: "bg-teal-500/10 text-teal-300 border border-teal-500/20",
  },
  matrix: {
    label: "Matrix",
    className: "bg-orange-500/10 text-orange-300 border border-orange-500/20",
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
      className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
        active
          ? "border-accent/60 bg-accent/20 text-gray-100"
          : "border-white/15 bg-white/5 text-gray-400 hover:border-white/30 hover:text-gray-200"
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
  const PipelineIcon = pipelineIcon(pipeline.category ?? "", pipeline.id);
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-4 transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
        selected
          ? "border-accent/60 bg-accent/10"
          : "border-white/10 bg-surface-raised hover:border-white/20 hover:bg-surface-overlay"
      }`}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] text-violet-300">
          <PipelineIcon className="h-[18px] w-[18px]" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-gray-100 text-sm">{pipeline.display_name}</h3>
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
              <span className="text-xs text-gray-500">
                {CATEGORY_LABEL[pipeline.category]}
              </span>
            )}
            {pipeline.category && pipeline.input_type && (
              <span className="text-gray-700 text-xs">·</span>
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
          <p className="mt-1.5 text-xs text-gray-400 line-clamp-2 leading-relaxed">
            {pipeline.description}
          </p>
        </div>
        {/* Container badge — capped width to prevent overflow */}
        <div className="shrink-0 max-w-[38%] overflow-hidden">
          {pipeline.container ? (
            <span
              className="block truncate rounded bg-white/8 px-2 py-0.5 text-xs text-gray-400 font-mono border border-white/10"
              title={`${pipeline.container.image}:${pipeline.container.tag}`}
            >
              {pipeline.container.image}:{pipeline.container.tag}
            </span>
          ) : (
            <span className="block rounded bg-violet-500/10 px-2 py-0.5 text-xs text-violet-300 font-mono border border-violet-500/20">
              native
            </span>
          )}
        </div>
      </div>
      {pipeline.homepage && (
        <a
          href={pipeline.homepage}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="mt-2 inline-block text-xs text-accent hover:text-accent-hover transition-colors"
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
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-accent" />
        Loading…
      </div>
    );
  }
  if (error || !data) {
    return (
      <p className="text-sm text-red-400">
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
  useEffect(() => {
    const state = location.state as IncomingState;
    if (state?.selectPipeline) {
      setSelectedId(state.selectPipeline);
      setActivePrefill(state.prefill ?? null);
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
      {/* Sidebar: filter + pipeline list */}
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
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500"
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
              className="w-full rounded-md border border-white/15 bg-surface-overlay pl-8 pr-3 py-1.5 text-sm text-gray-200 placeholder:text-gray-500 focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
          </div>

          {/* Category chips */}
          <div>
            <p className="text-xs font-medium text-gray-500 mb-1.5">Category</p>
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
            <p className="text-xs font-medium text-gray-500 mb-1.5">Input data</p>
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
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                localOkOnly ? "bg-green-500" : "bg-white/15"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  localOkOnly ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
            <span className="text-xs text-gray-400">Local OK only</span>
          </label>

          {/* Clear filters */}
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-accent hover:text-accent-hover focus:outline-none"
            >
              Clear all filters
            </button>
          )}
        </div>

        {/* Pipeline list */}
        <div className="flex-1 overflow-y-auto p-3">
          {isLoading && (
            <div className="flex items-center gap-2 p-2 text-sm text-gray-400">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-accent shrink-0" />
              Loading manifests…
            </div>
          )}
          {error && (
            <p className="p-2 text-sm text-red-400">{(error as Error).message}</p>
          )}

          {!isLoading && !error && (
            <>
              {filtered.length === 0 ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-gray-500">No pipelines match these filters.</p>
                  {filtersActive && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="mt-2 text-xs text-accent hover:text-accent-hover focus:outline-none"
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
                          setSelectedId(selectedId === p.id ? null : p.id);
                          setActivePrefill(null);
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {pipelines && filtered.length > 0 && filtered.length < pipelines.length && (
                <p className="mt-3 text-xs text-center text-gray-600">
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
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-surface-raised text-accent shadow-xl shadow-black/20">
              <WorkbenchIcons.pipeline className="h-6 w-6" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-300">Select a pipeline</p>
              <p className="text-xs text-gray-500 mt-0.5">Choose a pipeline on the left to configure and launch a run.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
