import { useState } from "react";
import { Link } from "react-router-dom";
import type { Dataset } from "../api/client";
import { DatasetImportForm } from "../components/domain/DatasetImportForm";
import { ValidationStatusBanner } from "../components/domain/ValidationResults";
import { useDatasets } from "../hooks/useDatasets";

export default function Datasets() {
  const { data: datasets, isLoading } = useDatasets();
  const [showImport, setShowImport] = useState(false);

  function handleImported(dataset: Dataset) {
    // Keep the form open so the user can see validation results; they can dismiss
    void dataset;
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold">Datasets</h2>
          <p className="text-sm text-muted mt-1">
            Import a BIDS dataset folder to validate and index it.
          </p>
        </div>
        <button
          onClick={() => setShowImport((v) => !v)}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
        >
          {showImport ? "Cancel" : "+ Import dataset"}
        </button>
      </div>

      {showImport && (
        <div className="mb-8 rounded-md border border-white/10 bg-surface-raised p-5">
          <h3 className="mb-3 text-sm font-medium text-gray-200">
            Import a BIDS dataset
          </h3>
          <p className="mb-4 text-xs text-gray-400">
            Type the full path to your BIDS dataset folder exactly as it appears on
            your Mac — for example{" "}
            <code className="bg-surface-overlay px-1 rounded">
              /Users/you/Documents/my-study
            </code>
            . The path must be inside the directory set as{" "}
            <code className="bg-surface-overlay px-1 rounded">HOST_DATASETS_DIR</code>{" "}
            in your <code className="bg-surface-overlay px-1 rounded">.env</code> file
            (default: <code className="bg-surface-overlay px-1 rounded">~/Documents</code>).
            Your files are never modified.
          </p>
          <DatasetImportForm onImported={handleImported} />
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-gray-400 animate-pulse">Loading datasets…</p>
      )}

      {datasets && datasets.length === 0 && !showImport && (
        <div className="rounded-md border border-white/10 bg-surface-raised p-8 text-center">
          <p className="text-gray-400 text-sm">No datasets yet.</p>
          <button
            onClick={() => setShowImport(true)}
            className="mt-3 text-accent text-sm hover:underline"
          >
            Import your first dataset →
          </button>
        </div>
      )}

      {datasets && datasets.length > 0 && (
        <div className="space-y-2">
          {datasets.map((d) => (
            <Link
              key={d.id}
              to={`/datasets/${d.id}`}
              className="block rounded-md border border-white/10 bg-surface-raised p-4 hover:border-accent/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium text-gray-100 truncate">
                    {d.name ?? d.path}
                  </p>
                  <p className="text-xs text-gray-500 truncate mt-0.5">{d.path}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {d.subject_count} subject{d.subject_count !== 1 ? "s" : ""}
                    {d.bids_version ? ` · BIDS ${d.bids_version}` : ""}
                  </p>
                </div>
                <ValidationStatusBanner status={d.validation_status} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
