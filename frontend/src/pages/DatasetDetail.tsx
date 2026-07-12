import { Link, useParams } from "react-router-dom";
import { DatasetMeta } from "../components/domain/DatasetMeta";
import { useDataset } from "../hooks/useDatasets";

export default function DatasetDetail() {
  const { id } = useParams<{ id: string }>();
  const datasetId = Number(id);
  const { data, isLoading, isError } = useDataset(datasetId);

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
    <div className="p-6 max-w-4xl lg:p-8">
      <Link to="/datasets" className="text-xs text-gray-500 hover:text-gray-300 mb-4 block">
        ← Datasets
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-semibold mb-1">{data.name ?? data.path}</h2>
          <p className="text-xs text-gray-500 font-mono">{data.path}</p>
        </div>

        {/* Dataset workspace nav */}
        <nav className="flex flex-wrap gap-2">
          <Link
            to={`/datasets/${datasetId}/dashboard`}
            className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <rect x="1" y="1" width="6" height="6" rx="1" />
              <rect x="9" y="1" width="6" height="6" rx="1" />
              <rect x="1" y="9" width="6" height="6" rx="1" />
              <rect x="9" y="9" width="6" height="6" rx="1" />
            </svg>
            Dashboard
          </Link>
          <Link
            to={`/datasets/${datasetId}/artifacts`}
            className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <path d="M2 3h12M2 8h8M2 13h5" strokeLinecap="round" />
            </svg>
            Artifacts
          </Link>
          <Link
            to={`/datasets/${datasetId}/graph`}
            className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <circle cx="8" cy="3" r="2" />
              <circle cx="3" cy="13" r="2" />
              <circle cx="13" cy="13" r="2" />
              <line x1="8" y1="5" x2="5" y2="11" />
              <line x1="8" y1="5" x2="11" y2="11" />
            </svg>
            Analysis Graph
          </Link>
          <Link
            to={`/datasets/${datasetId}/methods`}
            className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <path d="M2 4h12M2 8h9M2 12h6" strokeLinecap="round" />
            </svg>
            Methods
          </Link>
          <Link
            to={`/datasets/${datasetId}/reports`}
            className="flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent hover:border-accent/60 hover:bg-accent/15 transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
              <path d="M2 2h12v12H2z" rx="1" />
              <path d="M5 6h6M5 9h4M5 12h3" strokeLinecap="round" />
            </svg>
            Study Report
          </Link>
        </nav>
      </div>

      <DatasetMeta dataset={data} />
    </div>
  );
}
