import { useState } from "react";
import type { Dataset } from "../../api/client";
import { useRegisterDataset } from "../../hooks/useDatasets";
import { ValidationResults, ValidationStatusBanner } from "./ValidationResults";

interface Props {
  onImported?: (dataset: Dataset) => void;
}

export function DatasetImportForm({ onImported }: Props) {
  const [path, setPath] = useState("");
  const { mutate, isPending, isError, error, data, reset } = useRegisterDataset();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!path.trim()) return;
    mutate(path.trim(), { onSuccess: (d) => onImported?.(d) });
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          aria-label="Absolute path to BIDS dataset"
          value={path}
          onChange={(e) => { setPath(e.target.value); reset(); }}
          placeholder="/absolute/path/to/bids-dataset"
          className="flex-1 rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
          disabled={isPending}
        />
        <button
          type="submit"
          disabled={isPending || !path.trim()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-accent-hover transition-colors"
        >
          {isPending ? "Importing…" : "Import dataset"}
        </button>
      </form>

      {isError && (
        <div role="alert" className="rounded-md border border-red-700/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          <p className="font-semibold">Dataset could not be imported</p>
          <p className="mt-1 text-xs text-red-200/80">
            {error instanceof Error ? error.message : "Confirm the folder exists, is readable, and is inside HOST_DATASETS_DIR."}
          </p>
        </div>
      )}

      {data && (
        <div className="space-y-3 rounded-md border border-white/10 bg-surface-raised p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-gray-100">{data.name ?? data.path}</p>
            <ValidationStatusBanner status={data.validation_status} />
          </div>
          {data.validation_issues && (
            <ValidationResults issues={data.validation_issues} />
          )}
        </div>
      )}
    </div>
  );
}
