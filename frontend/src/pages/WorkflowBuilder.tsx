import { useMemo, useState } from "react";
import {
  createRun,
  fetchCompatiblePipelines,
  fetchPipeline,
  fetchRun,
  fetchRunResults,
  type CompatiblePipeline,
  type ComputeProfile,
  type DatasetSummary,
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
  computeProfile: ComputeProfile | null;
  inputArtifactType: string;
  produced: PipelineProduceSlot[];
  params: Record<string, unknown>;
  datasetId: number | "";
  edge: WorkflowEdge;
  status: WorkflowNodeStatus;
  runId?: number;
  error?: string;
}

interface SourceArtifacts {
  artifacts: RunArtifact[];
  metadata?: RunMetadata;
  sourceRun?: Run | RunSummary;
}

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

const STATUS_BADGE: Record<WorkflowNodeStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-gray-100 text-gray-600 border border-gray-200" },
  ready: { label: "Ready", className: "bg-blue-50 text-blue-700 border border-blue-200" },
  running: { label: "Running", className: "bg-amber-50 text-amber-700 border border-amber-200" },
  success: { label: "Success", className: "bg-green-50 text-green-700 border border-green-200" },
  failed: { label: "Failed", className: "bg-red-50 text-red-700 border border-red-200" },
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

function ProfileBadge({ profile }: { profile: ComputeProfile | null }) {
  if (!profile) return null;
  const badge = COMPUTE_PROFILE_BADGE[profile];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}

function StatusPill({ status }: { status: WorkflowNodeStatus }) {
  const badge = STATUS_BADGE[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
}

function SourceCard({
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
  const artifacts =
    source.kind === "dataset" && selectedDataset
      ? ["bids_dataset"]
      : source.kind === "run"
        ? resolvedArtifactTypes(sourceRunResults?.artifacts ?? [])
        : [];
  const emptyArtifactText =
    source.kind === "dataset"
      ? "Select a dataset to expose bids_dataset"
      : "Select a successful run with resolved artifacts";

  return (
    <section className="w-72 shrink-0 rounded-lg border border-white/10 bg-surface-raised p-4 sm:w-80">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Start</p>
          <h2 className="mt-1 text-base font-semibold text-gray-100">
            {source.kind === "dataset" ? "Dataset" : "Completed run"}
          </h2>
        </div>
        <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          Source
        </span>
      </div>

      <p className="mt-3 text-sm text-gray-300">
        {source.kind === "dataset"
          ? selectedDataset?.name ?? selectedDataset?.path ?? "Choose a dataset"
          : selectedRun
            ? `Run #${selectedRun.id} · ${selectedRun.pipeline_manifest_id}`
            : "Choose a completed run"}
      </p>

      <div className="mt-4 space-y-2">
        <p className="text-xs font-medium text-gray-500">Produced artifacts</p>
        <div className="flex flex-wrap gap-1.5">
          {artifacts.length > 0 ? (
            artifacts.map((type) => (
              <span key={type} className="rounded bg-white/10 px-2 py-1 font-mono text-xs text-gray-200">
                {type}
              </span>
            ))
          ) : (
            <span className="text-xs text-gray-500">{emptyArtifactText}</span>
          )}
        </div>
      </div>
    </section>
  );
}

function NodeCard({
  node,
  selected,
  onSelect,
}: {
  node: WorkflowNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-72 shrink-0 rounded-lg border p-4 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 sm:w-80 ${
        selected
          ? "border-blue-400 bg-blue-500/10"
          : "border-white/10 bg-surface-raised hover:border-white/20"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Pipeline</p>
          <h3 className="mt-1 truncate text-base font-semibold text-gray-100">{node.displayName}</h3>
        </div>
        <StatusPill status={node.status} />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <ProfileBadge profile={node.computeProfile} />
        {node.runId && (
          <a
            href={`/runs/${node.runId}`}
            onClick={(e) => e.stopPropagation()}
            className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs font-medium text-blue-300 hover:text-blue-200"
          >
            Run #{node.runId}
          </a>
        )}
      </div>

      <dl className="mt-4 space-y-3 text-xs">
        <div>
          <dt className="text-gray-500">Input artifact</dt>
          <dd className="mt-1 break-all font-mono text-gray-200">{node.inputArtifactType}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Produced artifacts</dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {node.produced.length > 0 ? (
              node.produced.map((p) => (
                <span key={`${node.id}-${p.type}`} className="break-all rounded bg-white/10 px-2 py-1 font-mono text-gray-200">
                  {p.type}
                </span>
              ))
            ) : (
              <span className="text-gray-500">None declared</span>
            )}
          </dd>
        </div>
      </dl>

      {node.error && (
        <p className="mt-3 rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-200">
          {node.error}
        </p>
      )}
    </button>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex w-20 shrink-0 flex-col items-center justify-center text-center sm:w-28">
      <div className="h-px w-full bg-white/20" />
      <span className="mt-2 max-w-full break-all rounded bg-surface-overlay px-2 py-1 font-mono text-[11px] text-gray-300">
        {label}
      </span>
    </div>
  );
}

export default function WorkflowBuilder() {
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

  const completedRuns = useMemo(
    () => runs.filter((r) => r.status === "success"),
    [runs],
  );
  const selectedDataset = datasets.find((d) => d.id === source.datasetId);
  const selectedRunId = typeof source.runId === "number" ? source.runId : 0;
  const selectedRun = completedRuns.find((r) => r.id === source.runId);
  const { data: sourceRunResults } = useRunResults(
    selectedRunId,
    source.kind === "run" && selectedRunId > 0,
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  function resetWorkflow(nextSource: Partial<WorkflowSource>) {
    setSource((prev) => ({ ...prev, ...nextSource }));
    setNodes([]);
    setSelectedNodeId(null);
    setCompatibles([]);
    setCompatError(null);
    setRunMessage(null);
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
        if (finished.status === "failed") {
          updateNode(node.id, {
            status: "failed",
            error: finished.error_message ?? `Run #${finished.id} failed.`,
          });
          setRunMessage(`Stopped at ${node.displayName}.`);
          return;
        }
        updateNode(node.id, { status: "success", runId: finished.id });
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
    if (isRunning) return "Wait for the current workflow run to finish.";
    if (!sourceReady()) {
      return source.kind === "dataset"
        ? "Select a starting dataset to find compatible pipelines."
        : "Select a successful run before loading compatible pipelines.";
    }
    if (currentArtifactTypes().length === 0) {
      return "The current endpoint has no resolved artifact types.";
    }
    return "Compatibility is checked against manifest-declared artifact types.";
  }

  const runButtonText =
    nodes.length === 0
      ? "Run workflow"
      : `Run ${nodes.length}-step workflow`;

  return (
    <div className="min-h-full bg-surface p-4 sm:p-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-100">Workflow Builder</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-400">
            Build a linear manifest-driven pipeline chain from datasets or completed runs.
          </p>
        </div>
        <button
          type="button"
          onClick={runWorkflow}
          disabled={isRunning || nodes.length === 0}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isRunning ? "Running workflow..." : runButtonText}
        </button>
      </header>

      <section className="mb-5 rounded-lg border border-white/10 bg-surface-raised p-4">
        <div className="grid gap-4 lg:grid-cols-[12rem_1fr_1fr]">
          <div>
            <label className="block text-xs font-medium text-gray-500">Start from</label>
            <select
              value={source.kind}
              onChange={(e) =>
                resetWorkflow({
                  kind: e.target.value as SourceKind,
                  datasetId: "",
                  runId: "",
                })
              }
              className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-800"
            >
              <option value="dataset">Existing Dataset</option>
              <option value="run">Completed Run</option>
            </select>
          </div>

          {source.kind === "dataset" ? (
            <div className="lg:col-span-2">
              <label className="block text-xs font-medium text-gray-500">Starting dataset</label>
              <select
                value={source.datasetId}
                onChange={(e) => resetWorkflow({ datasetId: e.target.value ? Number(e.target.value) : "" })}
                className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-800"
              >
                <option value="">Choose a dataset</option>
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name ?? dataset.path} ({dataset.subject_count} subjects · {dataset.validation_status})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="lg:col-span-2">
              <label className="block text-xs font-medium text-gray-500">Starting completed run</label>
              <select
                value={source.runId}
                onChange={(e) => resetWorkflow({ runId: e.target.value ? Number(e.target.value) : "" })}
                className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-800"
              >
                <option value="">Choose a successful run</option>
                {completedRuns.map((run) => (
                  <option key={run.id} value={run.id}>
                    Run #{run.id} · {run.pipeline_manifest_id}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
        <section className="overflow-hidden rounded-lg border border-white/10 bg-surface-overlay">
          <div className="border-b border-white/10 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-100">Canvas</h2>
          </div>
          <div className="overflow-x-auto p-5">
            <div className="flex min-h-72 items-stretch">
              <SourceCard
                source={source}
                datasets={datasets}
                completedRuns={completedRuns}
                sourceRunResults={sourceRunResults}
              />
              {nodes.map((node) => (
                <div key={node.id} className="flex items-stretch">
                  <Arrow label={node.edge.artifactType} />
                  <NodeCard
                    node={node}
                    selected={selectedNodeId === node.id}
                    onSelect={() => setSelectedNodeId(node.id)}
                  />
                </div>
              ))}
              {nodes.length === 0 && (
                <div className="flex max-w-xs items-center pl-6 text-sm text-gray-500">
                  {sourceReady()
                    ? "Find a compatible next step from the controls panel."
                    : "Choose a starting dataset or completed run first."}
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="rounded-lg border border-white/10 bg-surface-raised p-4">
          <h2 className="text-sm font-semibold text-gray-100">Builder Controls</h2>
          <button
            type="button"
            onClick={loadCompatibleNext}
            disabled={!sourceReady() || isLoadingCompat || isRunning}
            className="mt-4 w-full rounded-lg border border-blue-400/40 bg-blue-500/10 px-3 py-2 text-sm font-medium text-blue-200 transition-colors hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoadingCompat ? "Checking manifests..." : "Find compatible next step"}
          </button>
          <p className="mt-2 text-xs leading-relaxed text-gray-400">{addNextHelpText()}</p>

          {compatError && (
            <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {compatError}
            </p>
          )}

          {compatibles.length > 0 && (
            <div className="mt-4 space-y-2">
              {compatibles.map((option) => (
                <button
                  key={`${option.pipeline_id}-${option.accept_type}-${option.accept_param ?? "dataset"}`}
                  type="button"
                  onClick={() => void addPipelineNode(option)}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-left transition-colors hover:border-blue-400/40 hover:bg-blue-500/10"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-100">{option.display_name}</span>
                    <ProfileBadge profile={option.compute_profile} />
                  </div>
                  <p className="mt-1 font-mono text-xs text-gray-400">
                    accepts {option.accept_type}
                    {option.accept_param ? ` -> ${option.accept_param}` : " -> dataset"}
                  </p>
                  <p className="mt-2 text-xs font-medium text-blue-300">Add this step</p>
                </button>
              ))}
            </div>
          )}

          {selectedNode && (
            <div className="mt-6 border-t border-white/10 pt-4">
              <h3 className="text-sm font-semibold text-gray-100">{selectedNode.displayName}</h3>
              <label className="mt-4 block text-xs font-medium text-gray-500">
                Dataset for this step
              </label>
              <select
                value={selectedNode.datasetId}
                onChange={(e) =>
                  updateNode(selectedNode.id, {
                    datasetId: e.target.value ? Number(e.target.value) : "",
                  })
                }
                className="mt-1 w-full rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-800"
              >
                <option value="">Use upstream/starting dataset when possible</option>
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name ?? dataset.path}
                  </option>
                ))}
              </select>
              {selectedNode.edge.acceptDatasetSlot && (
                <p className="mt-2 text-xs text-gray-400">
                  Dataset-slot steps use the registered upstream dataset first; select one only if that is missing.
                </p>
              )}
            </div>
          )}

          {runMessage && (
            <p className="mt-4 rounded border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-200">
              {runMessage}
            </p>
          )}

          <div className="mt-6 rounded border border-white/10 bg-white/5 px-3 py-2 text-xs leading-relaxed text-gray-400">
            Review compute profile badges before running. Cloud recommended steps may be slow or unsafe locally.
          </div>
        </aside>
      </div>

      <section className="mt-5 rounded-lg border border-white/10 bg-surface-raised p-4">
        <h2 className="text-sm font-semibold text-gray-100">Manifest-driven rules</h2>
        <div className="mt-3 grid gap-3 text-sm text-gray-400 md:grid-cols-3">
          <p>Connections are created only from declared artifact types.</p>
          <p>Compatible next steps come from the backend compatibility endpoint.</p>
          <p>Lineage is passed to created runs when the upstream node is a run.</p>
        </div>
      </section>
    </div>
  );
}
