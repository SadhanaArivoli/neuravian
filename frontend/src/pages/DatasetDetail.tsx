import { Link, useParams } from "react-router-dom";
import { DatasetMeta } from "../components/domain/DatasetMeta";
import { useDataset } from "../hooks/useDatasets";

export default function DatasetDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, isError } = useDataset(Number(id));

  if (isLoading) {
    return (
      <div className="p-8">
        <p className="text-sm text-gray-400 animate-pulse">Loading…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-8">
        <p className="text-sm text-red-400">Dataset not found.</p>
        <Link to="/datasets" className="mt-2 text-xs text-accent hover:underline block">
          ← Back to datasets
        </Link>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl">
      <Link
        to="/datasets"
        className="text-xs text-gray-500 hover:text-gray-300 mb-4 block"
      >
        ← Datasets
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-semibold mb-1">{data.name ?? data.path}</h2>
          <p className="text-xs text-gray-500 font-mono">{data.path}</p>
        </div>
        <Link
          to={`/datasets/${data.id}/graph`}
          className="flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent hover:border-accent/60 hover:bg-accent/15 transition-colors"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
            <circle cx="8" cy="3" r="2" />
            <circle cx="3" cy="13" r="2" />
            <circle cx="13" cy="13" r="2" />
            <line x1="8" y1="5" x2="5" y2="11" />
            <line x1="8" y1="5" x2="11" y2="11" />
          </svg>
          Workflow Graph
        </Link>
      </div>
      <DatasetMeta dataset={data} />
    </div>
  );
}
