import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  createRun,
  createWorkflow,
  fetchCompatiblePipelines,
  fetchPipeline,
  fetchRun,
  fetchRunResults,
  fetchWorkflow,
  updateWorkflow,
  type CompatiblePipeline,
  type ComputeProfile,
  type DatasetSummary,
  type Pipeline,
  type PipelineCategory,
  type PipelineParameter,
  type PipelineProduceSlot,
  type Run,
  type RunArtifact,
  type RunLineage,
  type RunMetadata,
  type RunSummary,
} from "../api/client";
import { useDatasets } from "../hooks/useDatasets";
import { useRunResults, useRuns } from "../hooks/useRuns";
import {
  WORKFLOW_TEMPLATES,
  filterRunsByArtifact,
  validateTemplateEdges,
  type ManifestSlim,
  type WorkflowTemplate,
} from "../lib/workflowTemplates";
import {
  deserializeWorkflowState,
  serializeWorkflowState,
  type SerializedSource,
} from "../lib/workflowPersistence";

type SourceKind = "dataset" | "run";
type WorkflowNodeStatus = "draft" | "ready" | "running" | "success" | "failed";

interface WorkflowSource {
  kind: SourceKind;
  datasetId: number | "";
  runId: number | "";
}

interface WorkflowEdge {
  artifactType: string;
  acceptParam: string | null;
  acceptDatasetSlot: boolean;
  acceptLabel: string | null;
}

interface WorkflowNode {
  id: string;
  pipelineId: string;
  displayName: string;
  category: PipelineCategory | null;
  computeProfile: ComputeProfile | null;
  inputArtifactType: string;
  produced: PipelineProduceSlot[];
  params: Record<string, unknown>;
  datasetId: number | "";
  edge: WorkflowEdge;
  status: WorkflowNodeStatus;
  runId?: number;
  error?: string;
  resolvedOutputs?: RunArtifact[];
}

interface SourceArtifacts {
  artifacts: RunArtifact[];
  metadata?: RunMetadata;
  sourceRun?: Run | RunSummary;
}

// ── Badge configs — match Welcome.tsx dark-theme palette ─────────────────────

const COMPUTE_PROFILE_BADGE: Record<ComputeProfile, { label: string; className: string }> = {
  "local-ok": {
    label: "Local OK",
    className: "bg-green-900/50 text-green-300 border border-green-800",
  },
  "local-slow": {
    label: "Slow locally",
    className: "bg-amber-900/50 text-amber-300 border border-amber-800",
  },
  "local-unsafe": {
    label: "Cloud recommended",
    className: "bg-red-900/50 text-red-300 border border-red-800",
  },
};

const STATUS_BADGE: Record<WorkflowNodeStatus, { label: string; className: string; icon: string }> = {
  draft:   { label: "Draft",    className: "border-white/15 bg-white/5 text-gray-400",        icon: "D"  },
  ready:   { label: "Ready",    className: "border-accent/30 bg-accent/10 text-accent",        icon: "R"  },
  running: { label: "Running",  className: "border-amber-800 bg-amber-900/50 text-amber-300",  icon: "…"  },
  success: { label: "Complete", className: "border-green-800 bg-green-900/50 text-green-300",  icon: "OK" },
  failed:  { label: "Failed",   className: "border-red-800 bg-red-900/50 text-red-300",        icon: "!"  },
};

// Category metadata — single icon per category, subdued per-category text tint,
// app-standard surface backgrounds. No gradient tints or per-category colored glows.
const CATEGORY_META: Record<
  PipelineCategory | "dataset" | "run" | "unknown",
  { label: string; icon: string; iconColor: string; iconBg: string }
> = {
  dataset:          { label: "Dataset",           icon: "DS", iconColor: "text-accent",     iconBg: "bg-accent/10 border-accent/20"  },
  run:              { label: "Run",               icon: "RN", iconColor: "text-accent",     iconBg: "bg-accent/10 border-accent/20"  },
  conversion:       { label: "Conversion",        icon: "CV", iconColor: "text-cyan-300",   iconBg: "bg-surface-overlay border-white/8" },
  validation:       { label: "Validation",        icon: "VA", iconColor: "text-green-300",  iconBg: "bg-surface-overlay border-white/8" },
  quality_control:  { label: "Quality control",   icon: "QC", iconColor: "text-amber-300",  iconBg: "bg-surface-overlay border-white/8" },
  segmentation:     { label: "Segmentation",      icon: "SG", iconColor: "text-accent",     iconBg: "bg-surface-overlay border-white/8" },
  preprocessing:    { label: "Preprocessing",     icon: "PR", iconColor: "text-orange-300", iconBg: "bg-surface-overlay border-white/8" },
  deidentification: { label: "De-identification", icon: "DI", iconColor: "text-red-300",    iconBg: "bg-surface-overlay border-white/8" },
  connectivity:     { label: "Connectivity",      icon: "CN", iconColor: "text-sky-300",    iconBg: "bg-surface-overlay border-white/8" },
  unknown:          { label: "Pipeline",          icon: "PL", iconColor: "text-gray-400",   iconBg: "bg-surface-raised border-white/8"  },
};

const RUNTIME_HINT_BY_CATEGORY: Partial<Record<PipelineCategory, string>> = {
  conversion: "usually seconds-minutes",
  validation: "usually seconds",
  quality_control: "often minutes",
  segmentation: "varies by tool",
  preprocessing: "long running",
  deidentification: "varies locally",
  connectivity: "usually minutes",
};

function buildDefaults(params: PipelineParameter[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (p.type === "boolean") {
      out[p.name] = (p.default as boolean) ?? false;
    } else if (p.type === "multiselect") {
      out[p.name] = (p.default as string[]) ?? [];
    } else if (p.default !== undefined && p.default !== null) {
      out[p.name] = p.default;
    }
  }
  return out;
}

function formatParameterLabel(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function editableNodeParameters(
  params: PipelineParameter[],
  node: WorkflowNode,
): PipelineParameter[] {
  return params.filter((param) => {
    if (param.advanced) return false;
    if (param.name === "output-dir") return false;
    if (node.edge.acceptParam && param.name === node.edge.acceptParam) return false;
    return true;
  });
}

function artifactTypesFromProduces(produces: PipelineProduceSlot[] | undefined): string[] {
  return [...new Set((produces ?? []).map((p) => p.type).filter(Boolean))];
}

function resolvedArtifactTypes(artifacts: RunArtifact[]): string[] {
  return [...new Set(artifacts.filter((a) => a.resolved).map((a) => a.type))];
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForRun(runId: number): Promise<Run> {
  for (let i = 0; i < 900; i++) {
    const run = await fetchRun(runId);
    if (run.status === "success" || run.status === "failed") return run;
    await wait(2000);
  }
  throw new Error(`Run #${runId} did not finish before the workflow timeout.`);
}

function firstArtifactPath(artifact: RunArtifact | undefined): string | null {
  return artifact?.host_paths?.[0] ?? artifact?.paths?.[0] ?? null;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function categoryMeta(category: PipelineCategory | null | undefined) {
  return CATEGORY_META[category ?? "unknown"];
}

function runtimeHint(category: PipelineCategory | null, profile: ComputeProfile | null) {
  if (profile === "local-unsafe") return "not laptop-safe";
  if (profile === "local-slow") return "long local run";
  return category ? RUNTIME_HINT_BY_CATEGORY[category] ?? "runtime varies" : "runtime varies";
}

function compactPath(value: string) {
  const parts = value.split("/");
  if (parts.length <= 3) return value;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function ProfileBadge({ profile }: { profile: ComputeProfile | null }) {
  if (!profile) return null;
  const badge = COMPUTE_PROFILE_BADGE[profile];
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}

function StatusPill({ status }: { status: WorkflowNodeStatus }) {
  const badge = STATUS_BADGE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}>
      {status === "running" ? (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      ) : (
        <span>{badge.icon}</span>
      )}
      {badge.label}
    </span>
  );
}

// Category icon — app-standard surface with per-category text tint, no gradients.
function CategoryIcon({
  category,
  size = "md",
}: {
  category: PipelineCategory | "dataset" | "run" | null;
  size?: "sm" | "md" | "lg";
}) {
  const meta = CATEGORY_META[category ?? "unknown"];
  return (
    <span
      className={classNames(
        "grid shrink-0 place-items-center rounded-xl border font-bold",
        meta.iconBg,
        meta.iconColor,
        size === "sm" && "h-9 w-9 text-[11px]",
        size === "md" && "h-11 w-11 text-sm",
        size === "lg" && "h-12 w-12 text-sm",
      )}
    >
      {meta.icon}
    </span>
  );
}

function ArtifactChip({ type, muted = false }: { type: string; muted?: boolean }) {
  return (
    <span
      className={classNames(
        "max-w-full break-all rounded-full border px-2 py-0.5 font-mono text-[11px]",
        muted
          ? "border-white/8 bg-surface text-gray-500"
          : "border-white/10 bg-surface-raised text-gray-300",
      )}
    >
      {type}
    </span>
  );
}

// ── Canvas nodes ──────────────────────────────────────────────────────────────

function SourceNode({
  source,
  datasets,
  completedRuns,
  sourceRunResults,
}: {
  source: WorkflowSource;
  datasets: DatasetSummary[];
  completedRuns: RunSummary[];
  sourceRunResults?: SourceArtifacts;
}) {
  const selectedDataset = datasets.find((d) => d.id === source.datasetId);
  const selectedRun = completedRuns.find((r) => r.id === source.runId);
  const sourceCategory = source.kind === "dataset" ? "dataset" : "run";
  const artifacts =
    source.kind === "dataset" && selectedDataset
      ? ["bids_dataset"]
      : source.kind === "run"
        ? resolvedArtifactTypes(sourceRunResults?.artifacts ?? [])
        : [];
  const title =
    source.kind === "dataset"
      ? selectedDataset?.name ?? (selectedDataset ? compactPath(selectedDataset.path) : "Choose a dataset")
      : selectedRun
        ? `Run #${selectedRun.id}`
        : "Choose a completed run";
  const subtitle =
    source.kind === "dataset"
      ? selectedDataset?.path ?? "Start from a registered BIDS dataset."
      : selectedRun
        ? selectedRun.pipeline_manifest_id
        : "Start from a successful run with resolved artifacts.";

  return (
    <article className="relative w-[19rem] shrink-0 rounded-xl border border-white/8 bg-surface-raised p-5 transition-colors duration-200 hover:border-white/15">
      <div className="flex items-start gap-4">
        <CategoryIcon category={sourceCategory} size="lg" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Start</p>
          <h2 className="mt-2 truncate text-lg font-semibold text-white">{title}</h2>
          <p className="mt-1 line-clamp-2 break-all text-xs leading-5 text-gray-400">{subtitle}</p>
        </div>
      </div>

      <div className="mt-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Available artifacts</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {artifacts.length > 0 ? (
            artifacts.map((type) => <ArtifactChip key={type} type={type} />)
          ) : (
            <span className="text-xs text-gray-500">
              {source.kind === "dataset" ? "Select a dataset to expose BIDS artifacts." : "Select a successful run."}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function ConnectionEdge({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="flex w-28 shrink-0 flex-col items-center justify-center px-2 sm:w-36">
      <div className="relative h-10 w-full">
        <div className="absolute left-0 right-3 top-1/2 h-px -translate-y-1/2 overflow-hidden bg-white/10">
          <div
            className={classNames(
              "h-full w-full bg-gradient-to-r from-accent/40 via-accent/60 to-accent/40",
              active && "workflow-edge-flow",
            )}
          />
        </div>
        <div className="absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 border-r border-t border-white/20" />
      </div>
      <span className="max-w-full break-all rounded-full border border-white/8 bg-surface-raised px-2 py-0.5 font-mono text-[10px] text-gray-500">
        {label}
      </span>
    </div>
  );
}

function PipelineNode({
  node,
  selected,
  disabled,
  onSelect,
}: {
  node: WorkflowNode;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const meta = categoryMeta(node.category);
  const declaredOutputs = artifactTypesFromProduces(node.produced);
  const resolvedOutputs = resolvedArtifactTypes(node.resolvedOutputs ?? []);
  const visibleOutputs = resolvedOutputs.length > 0 ? resolvedOutputs : declaredOutputs;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={classNames(
        "relative w-[20rem] shrink-0 rounded-xl border p-5 text-left transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent/50 focus:ring-offset-1 focus:ring-offset-surface",
        selected
          ? "border-accent/40 bg-accent/[0.07]"
          : "border-white/8 bg-surface-raised hover:border-white/15 hover:bg-surface-overlay",
        disabled && "opacity-55",
        node.status === "running" && "workflow-node-running border-amber-800",
        node.status === "success" && "border-green-800 bg-green-900/15",
        node.status === "failed" && "border-red-800 bg-red-900/15",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <CategoryIcon category={node.category} size="lg" />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">{meta.label}</p>
            <h3 className="mt-2 truncate text-lg font-semibold text-white">{node.displayName}</h3>
            <p className="mt-1 text-xs text-gray-500">Runtime: {runtimeHint(node.category, node.computeProfile)}</p>
          </div>
        </div>
        <StatusPill status={node.status} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <ProfileBadge profile={node.computeProfile} />
        {node.runId && (
          <a
            href={`/runs/${node.runId}`}
            onClick={(e) => e.stopPropagation()}
            className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent hover:border-accent/50 hover:bg-accent/15 transition-colors"
          >
            Run #{node.runId}
          </a>
        )}
      </div>

      <div className="mt-4 grid gap-3 text-xs">
        <div>
          <p className="font-semibold uppercase tracking-widest text-gray-500">Input</p>
          <div className="mt-1.5">
            <ArtifactChip type={node.inputArtifactType} />
          </div>
        </div>
        <div>
          <p className="font-semibold uppercase tracking-widest text-gray-500">
            {resolvedOutputs.length > 0 ? "Outputs" : "Produces"}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {visibleOutputs.length > 0 ? (
              visibleOutputs.map((type) => <ArtifactChip key={`${node.id}-${type}`} type={type} />)
            ) : (
              <span className="text-gray-500">No artifacts declared</span>
            )}
          </div>
        </div>
      </div>

      {node.status === "running" && (
        <div className="mt-4 h-1 overflow-hidden rounded-full bg-white/10">
          <div className="workflow-progress h-full w-2/3 rounded-full bg-accent" />
        </div>
      )}

      {node.error && (
        <p className="mt-4 rounded-md border border-red-800 bg-red-900/30 px-3 py-2 text-xs leading-5 text-red-300">
          {node.error}
        </p>
      )}
    </button>
  );
}

function EmptyCanvas({ sourceReady }: { sourceReady: boolean }) {
  return (
    <div className="flex min-w-[18rem] max-w-md shrink-0 items-center pl-4">
      <div className="rounded-xl border border-dashed border-white/10 bg-surface p-6 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-xl border border-accent/20 bg-accent/10 text-lg font-bold text-accent">
          +
        </div>
        <h3 className="mt-4 text-sm font-semibold text-white">
          {sourceReady ? "Add the next compatible tool" : "Choose a starting point"}
        </h3>
        <p className="mt-2 text-sm leading-6 text-gray-400">
          {sourceReady
            ? "Recommendations appear in the right rail from the artifacts currently on the canvas."
            : "Start with a registered dataset or a completed run, then NeuroForge will suggest what can run next."}
        </p>
      </div>
    </div>
  );
}

function RecommendationCard({
  option,
  index,
  onAdd,
}: {
  option: CompatiblePipeline;
  index: number;
  onAdd: () => void;
}) {
  const category = option.category as PipelineCategory | null;
  const meta = categoryMeta(category);
  const recommended = option.compute_profile === "local-ok" && index === 0;

  return (
    <article className="rounded-xl border border-white/8 bg-surface-raised p-4 transition-colors duration-200 hover:border-white/15 hover:bg-surface-overlay">
      <div className="flex items-start gap-3">
        <CategoryIcon category={category} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {recommended && (
              <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-accent">
                Recommended
              </span>
            )}
            <span className={`rounded-full border border-white/8 px-2 py-0.5 text-[10px] font-medium ${meta.iconColor}`}>
              {meta.label}
            </span>
          </div>
          <h3 className="mt-2.5 truncate text-sm font-semibold text-white">{option.display_name}</h3>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-400">
            {option.pipeline_description ?? "Compatible with the current artifact endpoint."}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 rounded-lg border border-white/5 bg-surface p-3 text-xs text-gray-400">
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-500">Accepts</span>
          <span className="break-all font-mono text-gray-300">{option.accept_type}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-500">Profile</span>
          <ProfileBadge profile={option.compute_profile} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-gray-500">Runtime</span>
          <span className="text-gray-300">{runtimeHint(category, option.compute_profile)}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="mt-3 w-full rounded-md border border-white/15 px-3 py-2 text-sm font-medium text-gray-300 transition-colors hover:border-white/30 hover:text-white focus:outline-none focus:ring-2 focus:ring-accent/50"
      >
        Add Step
      </button>
    </article>
  );
}

// ── Template picker ───────────────────────────────────────────────────────────

function TemplatePicker({
  onBlank,
  onTemplate,
  loading,
  loadError,
  datasets,
  completedRuns,
  pipelineProducesCache,
}: {
  onBlank: () => void;
  onTemplate: (t: WorkflowTemplate) => void;
  loading: boolean;
  loadError: string | null;
  datasets: DatasetSummary[];
  completedRuns: RunSummary[];
  pipelineProducesCache: Record<string, string[]>;
}) {
  function templateAvailable(template: WorkflowTemplate): boolean {
    if (template.disabled) return false;
    if (template.requiredSourceKind === "dataset") return datasets.length > 0;
    return filterRunsByArtifact(completedRuns, template.requiredSourceArtifact, pipelineProducesCache).length > 0;
  }

  function unavailableReason(template: WorkflowTemplate): string {
    if (template.disabled) return template.disabledReason ?? "Not available yet.";
    if (template.requiredSourceKind === "dataset" && datasets.length === 0)
      return "Register a BIDS dataset in the Datasets tab first.";
    return `No completed run producing "${template.requiredSourceArtifact}" found. Check the Runs tab.`;
  }

  return (
    <div className="flex min-h-full flex-col px-4 sm:px-6 py-6">
      <header className="mb-8 pb-5 border-b border-white/5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-block w-1.5 h-4 rounded-full bg-accent" />
          <span className="rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-accent">
            Workflow Studio
          </span>
        </div>
        <h1 className="mt-4 text-xl sm:text-2xl font-bold tracking-tight text-white">
          Start with a template or build from scratch.
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-400">
          Templates pre-fill the canvas with connected, manifest-validated pipeline steps. You can add, remove, or reconfigure any step before running.
        </p>
        {loadError && (
          <p className="mt-4 rounded-md border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-300">
            {loadError}
          </p>
        )}
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {/* Blank workflow */}
        <button
          type="button"
          onClick={onBlank}
          disabled={loading}
          className="rounded-lg border border-dashed border-white/15 bg-surface p-5 text-left transition-colors hover:border-white/30 hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-accent/50 disabled:opacity-50"
        >
          <div className="grid h-11 w-11 place-items-center rounded-xl border border-white/10 bg-surface-overlay text-xl font-bold text-gray-400">
            +
          </div>
          <h3 className="mt-4 text-base font-semibold text-white">Blank Workflow</h3>
          <p className="mt-1.5 text-sm leading-5 text-gray-400">
            Start from scratch and build your own pipeline chain step by step.
          </p>
          <div className="mt-4 text-xs text-gray-500">0 steps · manual configuration · any source</div>
        </button>

        {/* Template cards */}
        {WORKFLOW_TEMPLATES.map((template) => {
          const meta = CATEGORY_META[template.categoryKey];
          const available = templateAvailable(template);
          const computeBadge = COMPUTE_PROFILE_BADGE[template.worstComputeProfile];
          const isDisabled = template.disabled;

          return (
            <div
              key={template.id}
              className={classNames(
                "flex flex-col rounded-lg border p-5 transition-colors",
                isDisabled
                  ? "border-white/5 bg-surface opacity-50"
                  : available
                    ? "border-white/8 bg-surface-raised hover:border-white/20 hover:bg-surface-overlay"
                    : "border-white/5 bg-surface",
              )}
            >
              {/* Icon + name */}
              <div className="flex items-start gap-3">
                <div
                  className={classNames(
                    "grid h-11 w-11 shrink-0 place-items-center rounded-xl border text-sm font-bold",
                    meta.iconBg,
                    meta.iconColor,
                    (isDisabled || !available) && "opacity-60",
                  )}
                >
                  {meta.icon}
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-white leading-tight">{template.name}</h3>
                  <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${computeBadge.className}`}>
                    {computeBadge.label}
                  </span>
                </div>
              </div>

              {/* Description */}
              <p className="mt-3 text-sm leading-5 text-gray-400">{template.description}</p>

              {/* Required source */}
              <div className="mt-3 rounded-md border border-white/5 bg-surface px-3 py-2 text-xs text-gray-500">
                <span className="font-semibold text-gray-400">Needs: </span>
                {template.requiredSourceLabel}
              </div>

              {/* Compute warning */}
              {template.computeWarning && (
                <p className="mt-2 text-[11px] leading-4 text-amber-400">{template.computeWarning}</p>
              )}

              {/* Footer: steps + runtime + action */}
              <div className="mt-4 flex items-center justify-between gap-2 text-xs text-gray-500">
                <span>
                  {template.steps.length} step{template.steps.length !== 1 ? "s" : ""} · {template.estimatedRuntime}
                </span>
              </div>

              {isDisabled ? (
                <p className="mt-3 text-xs text-gray-600">{template.disabledReason}</p>
              ) : available ? (
                <button
                  type="button"
                  onClick={() => onTemplate(template)}
                  disabled={loading}
                  className="mt-4 w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 disabled:opacity-50"
                >
                  {loading ? "Loading…" : "Use template"}
                </button>
              ) : (
                <div className="mt-4 rounded-md border border-white/8 px-3 py-2 text-xs text-gray-500">
                  {unavailableReason(template)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function WorkflowBuilder() {
  const [searchParams] = useSearchParams();
  const { data: datasets = [] } = useDatasets();
  const { data: runs = [] } = useRuns();
  const [source, setSource] = useState<WorkflowSource>({
    kind: "dataset",
    datasetId: "",
    runId: "",
  });
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [compatibles, setCompatibles] = useState<CompatiblePipeline[]>([]);
  const [compatError, setCompatError] = useState<string | null>(null);
  const [isLoadingCompat, setIsLoadingCompat] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [templateChosen, setTemplateChosen] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null);
  const [activeTemplate, setActiveTemplate] = useState<WorkflowTemplate | null>(null);

  // ── Persistence state ──────────────────────────────────────────────────────
  const [savedWorkflowId, setSavedWorkflowId] = useState<number | null>(null);
  const [workflowName, setWorkflowName] = useState<string>("Untitled Workflow");
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [_isLoadingWorkflow, setIsLoadingWorkflow] = useState(false);
  const [showRenameInput, setShowRenameInput] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const saveSuccessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load a saved workflow from ?open=<id> param
  useEffect(() => {
    const openId = searchParams.get("open");
    if (!openId) return;
    const id = Number(openId);
    if (!id) return;
    setIsLoadingWorkflow(true);
    fetchWorkflow(id)
      .then((wf) => {
        const state = deserializeWorkflowState(wf.state);
        if (!state) {
          console.warn("Could not deserialize workflow state", wf.state);
          return;
        }
        suppressDirty.current = true;
        const src = state.source as WorkflowSource;
        setSource(src);
        setNodes(state.nodes.map((n) => ({ ...n, status: "draft" as const })));
        setActiveTemplate(null);
        setSavedWorkflowId(wf.id);
        setWorkflowName(wf.name);
        setIsDirty(false);
        setTemplateChosen(true);
        // Re-enable dirty tracking after React flushes the state updates
        setTimeout(() => { suppressDirty.current = false; }, 50);
      })
      .catch((err) => {
        console.error("Failed to load workflow", err);
      })
      .finally(() => setIsLoadingWorkflow(false));
  // Only run once on mount when ?open param is present
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mark dirty when canvas changes. suppressDirty is true during load operations.
  const suppressDirty = useRef(true); // start suppressed until first user interaction
  useEffect(() => {
    if (suppressDirty.current) return;
    setIsDirty(true);
  }, [source, nodes]);

  async function saveWorkflow(asNew = false) {
    setIsSaving(true);
    setSaveError(null);
    try {
      const state = serializeWorkflowState(
        source as SerializedSource,
        nodes,
        activeTemplate?.id ?? null,
      );
      const datasetId =
        source.kind === "dataset" && source.datasetId ? (source.datasetId as number) : null;

      if (savedWorkflowId && !asNew) {
        await updateWorkflow(savedWorkflowId, { name: workflowName, state: state as unknown as Record<string, unknown>, dataset_id: datasetId });
      } else {
        const created = await createWorkflow({
          name: workflowName,
          state: state as unknown as Record<string, unknown>,
          dataset_id: datasetId,
        });
        setSavedWorkflowId(created.id);
        // Update URL without triggering a reload
        const url = new URL(window.location.href);
        url.searchParams.set("open", String(created.id));
        window.history.replaceState({}, "", url.toString());
      }
      setIsDirty(false);
      setSaveSuccess(true);
      if (saveSuccessTimer.current) clearTimeout(saveSuccessTimer.current);
      saveSuccessTimer.current = setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setIsSaving(false);
    }
  }

  function startRename() {
    setRenameValue(workflowName);
    setShowRenameInput(true);
  }

  function commitRename() {
    const trimmed = renameValue.trim();
    if (trimmed) {
      setWorkflowName(trimmed);
      setIsDirty(true);
    }
    setShowRenameInput(false);
  }

  const completedRuns = useMemo(
    () => runs.filter((r) => r.status === "success"),
    [runs],
  );

  // Maps pipeline ID → artifact types it declares in produces[]. Populated
  // lazily by fetching the full manifest for each unique pipeline ID seen in
  // completed runs so run-sourced template filters are manifest-driven, not
  // hardcoded to specific pipeline IDs.
  const [pipelineProducesCache, setPipelineProducesCache] = useState<Record<string, string[]>>({});
  const [pipelineManifestCache, setPipelineManifestCache] = useState<Record<string, Pipeline>>({});

  useEffect(() => {
    const uniqueIds = [...new Set(completedRuns.map((r) => r.pipeline_manifest_id))];
    const uncached = uniqueIds.filter((id) => !(id in pipelineProducesCache));
    if (uncached.length === 0) return;
    Promise.all(uncached.map((id) => fetchPipeline(id)))
      .then((pipelines) => {
        setPipelineProducesCache((prev) => {
          const updates: Record<string, string[]> = {};
          for (const p of pipelines) {
            updates[p.id] = (p.produces ?? []).map((s) => s.type);
          }
          return { ...prev, ...updates };
        });
      })
      .catch(() => {
        // Uncached pipelines simply won't appear as compatible sources yet.
      });
  // pipelineProducesCache excluded to avoid a refetch loop — the effect only
  // needs to re-run when the set of completed runs changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedRuns]);

  const templateSourceRuns = useMemo(() => {
    if (!activeTemplate || activeTemplate.requiredSourceKind !== "run") return completedRuns;
    return filterRunsByArtifact(completedRuns, activeTemplate.requiredSourceArtifact, pipelineProducesCache);
  }, [activeTemplate, completedRuns, pipelineProducesCache]);

  const selectedDataset = datasets.find((d) => d.id === source.datasetId);
  const selectedRunId = typeof source.runId === "number" ? source.runId : 0;
  const selectedRun = completedRuns.find((r) => r.id === source.runId);
  const { data: sourceRunResults } = useRunResults(
    selectedRunId,
    source.kind === "run" && selectedRunId > 0,
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedPipelineManifest = selectedNode ? pipelineManifestCache[selectedNode.pipelineId] : null;
  const selectedEditableParams =
    selectedNode && selectedPipelineManifest
      ? editableNodeParameters(selectedPipelineManifest.parameters, selectedNode)
      : [];
  const readyCount = nodes.filter((node) => node.status === "ready").length;
  const completeCount = nodes.filter((node) => node.status === "success").length;

  useEffect(() => {
    if (!selectedNode || pipelineManifestCache[selectedNode.pipelineId]) return;
    fetchPipeline(selectedNode.pipelineId)
      .then((pipeline) => {
        setPipelineManifestCache((prev) => ({ ...prev, [pipeline.id]: pipeline }));
      })
      .catch(() => {
        // The node can still run with stored params; the inspector just won't
        // show editable manifest parameters until the manifest loads.
      });
  }, [pipelineManifestCache, selectedNode]);

  function resetWorkflow(nextSource: Partial<WorkflowSource>) {
    setSource((prev) => ({ ...prev, ...nextSource }));
    setNodes([]);
    setSelectedNodeId(null);
    setCompatibles([]);
    setCompatError(null);
    setRunMessage(null);
  }

  function startBlank() {
    resetWorkflow({ kind: "dataset", datasetId: "", runId: "" });
    setActiveTemplate(null);
    setTemplateLoadError(null);
    setTemplateChosen(true);
    setTimeout(() => { suppressDirty.current = false; }, 50);
  }

  async function loadTemplate(template: WorkflowTemplate) {
    setTemplateLoading(true);
    setTemplateLoadError(null);
    try {
      // Fetch all pipeline manifests in parallel
      const pipelines = await Promise.all(
        template.steps.map((step) => fetchPipeline(step.pipelineId)),
      );

      // Build slim manifest map for edge validation
      const manifestMap: Record<string, ManifestSlim> = {};
      for (const p of pipelines) {
        manifestMap[p.id] = {
          id: p.id,
          accepts: (p.accepts ?? []) as ManifestSlim["accepts"],
          produces: (p.produces ?? []) as ManifestSlim["produces"],
        };
      }

      // Validate every edge against the live manifests — fail loudly
      const validation = validateTemplateEdges(template, manifestMap);
      if (!validation.valid) {
        const detail = validation.errors.map((e) => e.message).join(" | ");
        console.error("Template validation failed:", template.id, validation.errors);
        throw new Error(`Template "${template.name}" has invalid edges: ${detail}`);
      }

      const newNodes: WorkflowNode[] = template.steps.map((step, i) => ({
        id: `${step.pipelineId}-${Date.now()}-${i}`,
        pipelineId: pipelines[i].id,
        displayName: pipelines[i].display_name,
        category: pipelines[i].category ?? null,
        computeProfile: pipelines[i].compute_profile ?? null,
        inputArtifactType: step.inputArtifactType,
        produced: pipelines[i].produces ?? [],
        params: buildDefaults(pipelines[i].parameters),
        datasetId: "",
        edge: step.edge,
        status: "draft",
      }));

      resetWorkflow({ kind: template.requiredSourceKind, datasetId: "", runId: "" });
      setNodes(newNodes);
      setActiveTemplate(template);
      setTemplateChosen(true);
      setTimeout(() => { suppressDirty.current = false; }, 50);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load template.";
      setTemplateLoadError(message);
      // Stay on picker — do not transition to the builder with a broken chain
    } finally {
      setTemplateLoading(false);
    }
  }

  function currentArtifactTypes(): string[] {
    const lastNode = nodes[nodes.length - 1];
    if (lastNode) return artifactTypesFromProduces(lastNode.produced);
    if (source.kind === "dataset") return selectedDataset ? ["bids_dataset"] : [];
    return resolvedArtifactTypes(sourceRunResults?.artifacts ?? []);
  }

  async function loadCompatibleNext() {
    setCompatError(null);
    setIsLoadingCompat(true);
    try {
      const types = currentArtifactTypes();
      if (types.length === 0) {
        setCompatibles([]);
        setCompatError("The current endpoint has no resolved artifact types.");
        return;
      }
      const batches = await Promise.all(types.map((type) => fetchCompatiblePipelines(type)));
      const seen = new Set<string>();
      const merged: CompatiblePipeline[] = [];
      for (const batch of batches) {
        for (const item of batch) {
          const key = `${item.pipeline_id}:${item.accept_type}:${item.accept_param ?? "dataset"}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(item);
          }
        }
      }
      setCompatibles(merged);
      if (merged.length === 0) setCompatError("No compatible next pipeline was declared for these artifacts.");
    } catch (err) {
      setCompatError(err instanceof Error ? err.message : "Could not load compatible pipelines.");
    } finally {
      setIsLoadingCompat(false);
    }
  }

  async function addPipelineNode(option: CompatiblePipeline) {
    const pipeline = await fetchPipeline(option.pipeline_id);
    const id = `${option.pipeline_id}-${Date.now()}`;
    const node: WorkflowNode = {
      id,
      pipelineId: pipeline.id,
      displayName: pipeline.display_name,
      category: pipeline.category ?? null,
      computeProfile: pipeline.compute_profile ?? null,
      inputArtifactType: option.accept_type ?? "",
      produced: pipeline.produces ?? [],
      params: buildDefaults(pipeline.parameters),
      datasetId: "",
      edge: {
        artifactType: option.accept_type ?? "",
        acceptParam: option.accept_param,
        acceptDatasetSlot: option.accept_dataset_slot,
        acceptLabel: option.accept_label,
      },
      status: "ready",
    };
    setNodes((prev) => [...prev, node]);
    setSelectedNodeId(id);
    setCompatibles([]);
    setCompatError(null);
  }

  function updateNode(nodeId: string, patch: Partial<WorkflowNode>) {
    setNodes((prev) =>
      prev.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
    );
  }

  async function getArtifactsForIndex(index: number): Promise<SourceArtifacts> {
    if (index === 0) {
      if (source.kind === "dataset") {
        if (!selectedDataset) throw new Error("Choose a starting dataset.");
        return {
          artifacts: [
            {
              type: "bids_dataset",
              label: "BIDS Dataset",
              description: "Selected dataset",
              resolved: true,
              multiple: false,
              resolution_source: "dataset",
              paths: [selectedDataset.path],
              host_paths: [selectedDataset.path],
            },
          ],
        };
      }
      if (!selectedRun) throw new Error("Choose a completed starting run.");
      if (!sourceRunResults) throw new Error("Starting run artifacts are still loading.");
      return {
        artifacts: sourceRunResults.artifacts ?? [],
        metadata: sourceRunResults.metadata,
        sourceRun: selectedRun,
      };
    }

    const previous = nodes[index - 1];
    if (!previous.runId) throw new Error(`${previous.displayName} has not produced a run yet.`);
    const results = await fetchRunResults(previous.runId);
    const previousRun = await fetchRun(previous.runId);
    return {
      artifacts: results.artifacts ?? [],
      metadata: results.metadata,
      sourceRun: previousRun,
    };
  }

  function resolveDatasetId(node: WorkflowNode, upstream: SourceArtifacts): number {
    if (node.edge.acceptDatasetSlot) {
      if (upstream.metadata?.registered_dataset_id) return upstream.metadata.registered_dataset_id;
      if (node.datasetId) return node.datasetId;
      if (source.kind === "dataset" && selectedDataset) return selectedDataset.id;
      throw new Error(
        `${node.displayName} needs a dataset selection because the upstream run did not expose a registered dataset.`,
      );
    }
    if (upstream.metadata?.registered_dataset_id) return upstream.metadata.registered_dataset_id;
    if (node.datasetId) return node.datasetId;
    if (source.kind === "dataset" && selectedDataset) return selectedDataset.id;
    if (upstream.metadata?.dataset_id) return upstream.metadata.dataset_id;
    throw new Error(`${node.displayName} needs a dataset selection.`);
  }

  function buildLineage(node: WorkflowNode, upstream: SourceArtifacts, artifactPath: string | null): RunLineage | null {
    if (!upstream.sourceRun) return null;
    return {
      upstream_run_id: upstream.sourceRun.id,
      upstream_pipeline_id: upstream.sourceRun.pipeline_manifest_id,
      upstream_pipeline_display_name: upstream.sourceRun.pipeline_manifest_id,
      artifact_type: node.edge.artifactType,
      artifact_label: node.edge.acceptLabel ?? node.edge.artifactType,
      injected_param: node.edge.acceptParam,
      injected_path: artifactPath,
    };
  }

  async function runWorkflow() {
    if (nodes.length === 0) {
      setRunMessage("Add at least one compatible pipeline node.");
      return;
    }
    setIsRunning(true);
    setRunMessage(null);

    try {
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        updateNode(node.id, { status: "running", error: undefined });

        const upstream = await getArtifactsForIndex(i);
        const artifact = upstream.artifacts.find(
          (a) => a.resolved && a.type === node.edge.artifactType,
        );
        const artifactPath = firstArtifactPath(artifact);
        const params = { ...node.params };
        if (node.edge.acceptParam) {
          if (!artifactPath) {
            throw new Error(`${node.displayName} needs a resolved ${node.edge.artifactType} artifact.`);
          }
          params[node.edge.acceptParam] = artifactPath;
        }

        const datasetId = resolveDatasetId(node, upstream);
        const created = await createRun({
          pipeline_id: node.pipelineId,
          dataset_id: datasetId,
          params,
          lineage: buildLineage(node, upstream, artifactPath),
        });
        updateNode(node.id, { runId: created.id });

        const finished = await waitForRun(created.id);
        const results = await fetchRunResults(created.id).catch(() => null);
        if (finished.status === "failed") {
          updateNode(node.id, {
            status: "failed",
            runId: finished.id,
            resolvedOutputs: results?.artifacts ?? [],
            error: finished.error_message ?? `Run #${finished.id} failed.`,
          });
          setRunMessage(`Stopped at ${node.displayName}.`);
          return;
        }
        updateNode(node.id, {
          status: "success",
          runId: finished.id,
          resolvedOutputs: results?.artifacts ?? [],
        });
      }
      setRunMessage("Workflow completed.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Workflow failed.";
      const runningNode = nodes.find((n) => n.status === "running");
      if (runningNode) updateNode(runningNode.id, { status: "failed", error: message });
      setRunMessage(message);
    } finally {
      setIsRunning(false);
    }
  }

  function sourceReady() {
    if (source.kind === "dataset") return Boolean(selectedDataset);
    return Boolean(selectedRun && sourceRunResults);
  }

  function addNextHelpText() {
    if (isRunning) return "Workflow is running. Future nodes stay dimmed until their turn.";
    if (!sourceReady()) {
      return source.kind === "dataset"
        ? "Select a starting dataset to unlock recommendations."
        : "Select a successful run with resolved artifacts.";
    }
    if (currentArtifactTypes().length === 0) {
      return "The current endpoint has no resolved artifact types.";
    }
    return "Recommendations come from manifest-declared artifact compatibility.";
  }

  const runButtonText =
    nodes.length === 0
      ? "Run workflow"
      : `Run ${nodes.length}-step workflow`;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!templateChosen) {
    return (
      <div className="min-h-full text-gray-100">
        {templateLoading ? (
          <div className="flex min-h-[50vh] items-center justify-center">
            <p className="text-sm text-gray-400">Loading template…</p>
          </div>
        ) : (
          <TemplatePicker
            onBlank={startBlank}
            onTemplate={(t) => void loadTemplate(t)}
            loading={templateLoading}
            loadError={templateLoadError}
            datasets={datasets}
            completedRuns={completedRuns}
            pipelineProducesCache={pipelineProducesCache}
          />
        )}
      </div>
    );
  }

  return (
    <div className="min-h-full text-gray-100">
      <div className="flex min-h-full flex-col px-4 sm:px-6 py-6">

        {/* ── Page header ───────────────────────────────────────────────── */}
        <header className="mb-5 pb-5 border-b border-white/5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl">
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-block w-1.5 h-4 rounded-full bg-accent" />
                <span className="rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-accent">
                  Workflow Studio
                </span>
                <button
                  type="button"
                  onClick={() => setTemplateChosen(false)}
                  className="rounded-full border border-white/10 px-3 py-1 text-xs font-medium text-gray-400 transition-colors hover:border-white/25 hover:text-gray-200 focus:outline-none"
                >
                  ← Templates
                </button>
                {activeTemplate && (
                  <span className="rounded-full border border-white/8 bg-surface-raised px-3 py-1 text-xs text-gray-400">
                    {activeTemplate.name} · needs {activeTemplate.requiredSourceLabel}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setShowRules((value) => !value)}
                  className="rounded-full border border-white/10 px-3 py-1 text-xs font-medium text-gray-400 transition-colors hover:border-white/25 hover:text-gray-200 focus:outline-none"
                >
                  {showRules ? "Hide rules" : "How chaining works"}
                </button>
              </div>

              {/* ── Workflow name + save toolbar ─────────────────────── */}
              <div className="flex flex-wrap items-center gap-2 mt-3">
                {showRenameInput ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setShowRenameInput(false); }}
                    className="rounded-md border border-accent/40 bg-surface px-3 py-1 text-sm font-semibold text-white outline-none focus:border-accent/70 w-56"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={startRename}
                    title="Click to rename"
                    className="group flex items-center gap-1.5 rounded-md border border-white/10 bg-surface-raised px-3 py-1 text-sm font-semibold text-gray-200 transition-colors hover:border-white/25 hover:text-white"
                  >
                    {workflowName}
                    {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="Unsaved changes" />}
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3 text-gray-500 group-hover:text-gray-300">
                      <path d="M8 1.5l2.5 2.5-6 6H2V7.5l6-6z" />
                    </svg>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => void saveWorkflow(false)}
                  disabled={isSaving || !templateChosen}
                  className={classNames(
                    "rounded-md border px-3 py-1 text-xs font-medium transition-colors focus:outline-none",
                    saveSuccess
                      ? "border-green-700 bg-green-900/30 text-green-300"
                      : "border-white/15 bg-white/5 text-gray-300 hover:border-white/30 hover:text-white disabled:opacity-40",
                  )}
                >
                  {isSaving ? "Saving…" : saveSuccess ? "Saved ✓" : savedWorkflowId ? "Save" : "Save"}
                </button>

                <button
                  type="button"
                  onClick={() => void saveWorkflow(true)}
                  disabled={isSaving || !templateChosen}
                  className="rounded-md border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-gray-400 transition-colors hover:border-white/25 hover:text-gray-200 focus:outline-none disabled:opacity-40"
                >
                  Save As…
                </button>

                <Link
                  to="/workflows/library"
                  className="rounded-md border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-gray-400 transition-colors hover:border-white/25 hover:text-gray-200"
                >
                  Library
                </Link>

                {saveError && (
                  <span className="text-xs text-red-400">{saveError}</span>
                )}
              </div>
              <h1 className="mt-4 text-xl sm:text-2xl font-bold tracking-tight text-white">
                Build a neuroimaging workflow visually.
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-400">
                Choose a source, follow compatible recommendations, then run the chain one verified step at a time.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="min-w-40">
                <span className="block text-xs font-semibold uppercase tracking-widest text-gray-500">Start from</span>
                <select
                  value={source.kind}
                  onChange={(e) =>
                    resetWorkflow({
                      kind: e.target.value as SourceKind,
                      datasetId: "",
                      runId: "",
                    })
                  }
                  className="mt-2 w-full rounded-md border border-white/10 bg-surface px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-accent/50"
                >
                  <option value="dataset">Existing Dataset</option>
                  <option value="run">Completed Run</option>
                </select>
              </label>

              {source.kind === "dataset" ? (
                <label className="min-w-0 flex-1 sm:w-[26rem]">
                  <span className="block text-xs font-semibold uppercase tracking-widest text-gray-500">Dataset</span>
                  <select
                    value={source.datasetId}
                    onChange={(e) => resetWorkflow({ datasetId: e.target.value ? Number(e.target.value) : "" })}
                    className="mt-2 w-full rounded-md border border-white/10 bg-surface px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-accent/50"
                  >
                    <option value="">Choose a dataset</option>
                    {datasets.map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name ?? dataset.path} ({dataset.subject_count} subjects - {dataset.validation_status})
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="min-w-0 flex-1 sm:w-[26rem]">
                  <span className="block text-xs font-semibold uppercase tracking-widest text-gray-500">
                    Completed run
                    {activeTemplate?.requiredSourceKind === "run" && (
                      <span className="ml-2 font-normal normal-case tracking-normal text-gray-600">
                        (filtered to {activeTemplate.requiredSourceArtifact} producers)
                      </span>
                    )}
                  </span>
                  <select
                    value={source.runId}
                    onChange={(e) => resetWorkflow({ runId: e.target.value ? Number(e.target.value) : "" })}
                    className="mt-2 w-full rounded-md border border-white/10 bg-surface px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-accent/50"
                  >
                    <option value="">Choose a successful run</option>
                    {templateSourceRuns.map((run) => (
                      <option key={run.id} value={run.id}>
                        Run #{run.id} – {run.pipeline_manifest_id}
                      </option>
                    ))}
                  </select>
                  {activeTemplate?.requiredSourceKind === "run" && templateSourceRuns.length === 0 && (
                    <p className="mt-1 text-xs text-amber-400">
                      No run producing "{activeTemplate.requiredSourceArtifact}" found. Check the Runs tab.
                    </p>
                  )}
                </label>
              )}

              <button
                type="button"
                onClick={runWorkflow}
                disabled={isRunning || nodes.length === 0}
                className="rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover transition-colors disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-surface"
              >
                {isRunning ? "Running..." : runButtonText}
              </button>
            </div>
          </div>

          {showRules && (
            <div className="mt-5 grid gap-3 rounded-lg border border-white/8 bg-surface-raised p-4 text-sm text-gray-400 md:grid-cols-3">
              <p>Connections are created only from declared artifact types.</p>
              <p>Compatible recommendations come from <code className="font-mono text-xs text-gray-500">/api/pipelines/compatible</code>.</p>
              <p>Lineage is attached when a node starts from an upstream run.</p>
            </div>
          )}
        </header>

        {/* ── Canvas + rail ─────────────────────────────────────────────── */}
        <main className="grid flex-1 min-h-[34rem] gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">

          {/* Canvas */}
          <section className="relative overflow-hidden rounded-lg border border-white/8 bg-surface-raised">
            <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
              <div>
                <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">Canvas</h2>
                <p className="mt-1 text-xs text-gray-600">
                  {nodes.length === 0
                    ? "A clean slate for your chain."
                    : `${nodes.length} node${nodes.length === 1 ? "" : "s"} · ${completeCount} complete · ${readyCount} ready`}
                </p>
              </div>
              <div className="hidden rounded-full border border-white/8 bg-surface px-3 py-1 text-xs text-gray-500 sm:block">
                Sequential V1
              </div>
            </div>

            <div className="workflow-canvas-grid h-full min-h-[29rem] overflow-x-auto p-5 sm:p-7">
              <div className="flex min-w-max items-stretch py-4">
                <SourceNode
                  source={source}
                  datasets={datasets}
                  completedRuns={completedRuns}
                  sourceRunResults={sourceRunResults}
                />
                {nodes.map((node, index) => (
                  <div key={node.id} className="flex items-stretch">
                    <ConnectionEdge
                      label={node.edge.artifactType}
                      active={isRunning || node.status === "running" || node.status === "success"}
                    />
                    <PipelineNode
                      node={node}
                      selected={selectedNodeId === node.id}
                      disabled={isRunning && node.status === "ready" && index > nodes.findIndex((n) => n.status === "running")}
                      onSelect={() => setSelectedNodeId(node.id)}
                    />
                  </div>
                ))}
                {nodes.length === 0 && <EmptyCanvas sourceReady={sourceReady()} />}
              </div>
            </div>
          </section>

          {/* Right rail */}
          <aside className="flex min-h-0 flex-col rounded-lg border border-white/8 bg-surface-raised">

            {/* Recommendations header */}
            <div className="border-b border-white/5 p-5">
              <h2 className="text-sm font-semibold text-gray-100">Next recommendations</h2>
              <p className="mt-1.5 text-xs leading-5 text-gray-400">{addNextHelpText()}</p>
              <button
                type="button"
                onClick={loadCompatibleNext}
                disabled={!sourceReady() || isLoadingCompat || isRunning}
                className="mt-4 w-full rounded-md border border-accent/30 bg-accent/10 px-4 py-2.5 text-sm font-medium text-accent transition-colors hover:border-accent/50 hover:bg-accent/15 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                {isLoadingCompat ? "Finding matches…" : "Find compatible steps"}
              </button>

              {compatError && (
                <p className="mt-3 rounded-md border border-amber-800 bg-amber-900/30 px-3 py-2 text-xs leading-5 text-amber-300">
                  {compatError}
                </p>
              )}
            </div>

            {/* Recommendation list */}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
              {compatibles.length > 0 ? (
                compatibles.map((option, index) => (
                  <RecommendationCard
                    key={`${option.pipeline_id}-${option.accept_type}-${option.accept_param ?? "dataset"}`}
                    option={option}
                    index={index}
                    onAdd={() => void addPipelineNode(option)}
                  />
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-white/10 bg-surface p-5 text-center">
                  <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-white/8 bg-surface-overlay text-xs font-bold text-gray-500">
                    REC
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-gray-100">
                    {sourceReady() ? "Ready to recommend" : "Waiting for a source"}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-gray-400">
                    {sourceReady()
                      ? "Click Find compatible steps to see pipelines that accept the current artifact."
                      : "Pick a dataset or completed run first."}
                  </p>
                </div>
              )}
            </div>

            {/* Node settings footer */}
            <div className="border-t border-white/5 p-5">
              {selectedNode ? (
                <div>
                  <div className="flex items-center gap-3">
                    <CategoryIcon category={selectedNode.category} size="sm" />
                    <div>
                      <h3 className="text-sm font-semibold text-gray-100">{selectedNode.displayName}</h3>
                      <p className="text-xs text-gray-500">Node settings</p>
                    </div>
                  </div>
                  <label className="mt-4 block text-xs font-semibold uppercase tracking-widest text-gray-500">
                    Dataset for this step
                  </label>
                  <select
                    value={selectedNode.datasetId}
                    onChange={(e) =>
                      updateNode(selectedNode.id, {
                        datasetId: e.target.value ? Number(e.target.value) : "",
                      })
                    }
                    className="mt-2 w-full rounded-md border border-white/10 bg-surface px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-accent/50"
                  >
                    <option value="">Use upstream/starting dataset when possible</option>
                    {datasets.map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name ?? dataset.path}
                      </option>
                    ))}
                  </select>
                  {selectedNode.edge.acceptDatasetSlot && (
                    <p className="mt-2 text-xs leading-5 text-gray-400">
                      Dataset-slot steps use the registered upstream dataset first.
                    </p>
                  )}

                  {selectedEditableParams.length > 0 && (
                    <div className="mt-5 space-y-4 border-t border-white/5 pt-4">
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                          Parameters
                        </h4>
                        <p className="mt-1 text-xs leading-5 text-gray-500">
                          Manifest-declared options for this workflow node.
                        </p>
                      </div>
                      {selectedEditableParams.map((param) => {
                        const value = selectedNode.params[param.name];
                        return (
                          <label key={param.name} className="block">
                            <span className="text-xs font-medium text-gray-300">
                              {formatParameterLabel(param.name)}
                            </span>
                            {param.type === "select" && Array.isArray(param.options) ? (
                              <select
                                value={String(value ?? param.default ?? "")}
                                onChange={(e) =>
                                  updateNode(selectedNode.id, {
                                    params: {
                                      ...selectedNode.params,
                                      [param.name]: e.target.value,
                                    },
                                  })
                                }
                                className="mt-2 w-full rounded-md border border-white/10 bg-surface px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-accent/50"
                              >
                                {param.options.map((option) => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            ) : param.type === "boolean" ? (
                              <input
                                type="checkbox"
                                checked={Boolean(value)}
                                onChange={(e) =>
                                  updateNode(selectedNode.id, {
                                    params: {
                                      ...selectedNode.params,
                                      [param.name]: e.target.checked,
                                    },
                                  })
                                }
                                className="mt-2 h-4 w-4 rounded border-white/20 bg-surface text-accent focus:ring-accent/50"
                              />
                            ) : (
                              <input
                                type={param.type === "integer" || param.type === "float" ? "number" : "text"}
                                value={String(value ?? "")}
                                onChange={(e) =>
                                  updateNode(selectedNode.id, {
                                    params: {
                                      ...selectedNode.params,
                                      [param.name]:
                                        param.type === "integer" || param.type === "float"
                                          ? Number(e.target.value)
                                          : e.target.value,
                                    },
                                  })
                                }
                                className="mt-2 w-full rounded-md border border-white/10 bg-surface px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-accent/50"
                              />
                            )}
                            {param.help && (
                              <span className="mt-1 block text-xs leading-5 text-gray-500">
                                {param.help}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm leading-6 text-gray-400">
                  Select a node to inspect its dataset handoff and run link.
                </p>
              )}

              {runMessage && (
                <p className="mt-4 rounded-md border border-white/8 bg-surface px-3 py-2 text-sm text-gray-200">
                  {runMessage}
                </p>
              )}
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}
