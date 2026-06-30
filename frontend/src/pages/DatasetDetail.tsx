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
      <h2 className="text-2xl font-semibold mb-1">{data.name ?? data.path}</h2>
      <p className="text-xs text-gray-500 mb-6 font-mono">{data.path}</p>
      <DatasetMeta dataset={data} />
    </div>
  );
}
