import { useState } from "react";
import type { PipelineSummary } from "../api/client";
import PipelineParameterForm from "../components/domain/PipelineParameterForm";
import { usePipeline, usePipelines } from "../hooks/usePipelines";

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
          <h3 className="font-semibold text-gray-900">{pipeline.display_name}</h3>
          <p className="mt-1 text-sm text-gray-500 line-clamp-2">
            {pipeline.description}
          </p>
        </div>
        <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 font-mono">
          {pipeline.container.image}:{pipeline.container.tag}
        </span>
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

function PipelineDetail({ pipelineId }: { pipelineId: string }) {
  const { data, isLoading, error } = usePipeline(pipelineId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
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
      <h2 className="text-xl font-semibold text-gray-900 mb-1">
        {data.display_name}
      </h2>
      <p className="text-sm text-gray-500 mb-6">{data.description}</p>
      <PipelineParameterForm pipeline={data} />
    </div>
  );
}

export default function Pipelines() {
  const { data: pipelines, isLoading, error } = usePipelines();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="flex h-full">
      {/* Pipeline list */}
      <aside className="w-80 shrink-0 border-r border-gray-200 overflow-y-auto p-4">
        <h1 className="text-lg font-semibold text-gray-900 mb-4">Pipelines</h1>

        {isLoading && (
          <p className="text-sm text-gray-500">Loading manifests…</p>
        )}
        {error && (
          <p className="text-sm text-red-600">{(error as Error).message}</p>
        )}
        {pipelines && pipelines.length === 0 && (
          <p className="text-sm text-gray-500">No pipeline manifests found.</p>
        )}
        {pipelines && (
          <ul className="space-y-2">
            {pipelines.map((p) => (
              <li key={p.id}>
                <PipelineCard
                  pipeline={p}
                  selected={selectedId === p.id}
                  onSelect={() =>
                    setSelectedId(selectedId === p.id ? null : p.id)
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Detail / parameter form panel */}
      <main className="flex-1 overflow-y-auto p-8">
        {selectedId ? (
          <PipelineDetail pipelineId={selectedId} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-gray-400">
              Select a pipeline on the left to configure a run.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
