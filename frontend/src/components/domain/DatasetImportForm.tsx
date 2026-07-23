import { useState } from "react";
import type { Dataset } from "../../api/client";
import { useRegisterDataset } from "../../hooks/useDatasets";
import { ValidationResults, ValidationStatusBanner } from "./ValidationResults";

interface Props {
  onImported?: (dataset: Dataset) => void;
  onDatasetsRootChanged?: (root: string) => void;
}

export function DatasetImportForm({ onImported, onDatasetsRootChanged }: Props) {
  const [datasetPath, setDatasetPath] = useState("");
  const [browseNotice, setBrowseNotice] = useState<string | null>(null);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const { mutate, isPending, isError, error, data, reset } = useRegisterDataset();
  const desktop = typeof window !== "undefined" ? window.neuravianDesktop : undefined;

  async function handleBrowse() {
    if (!desktop?.browseForDatasetFolder) return;
    const chosen = await desktop.browseForDatasetFolder();
    if (chosen) {
      setDatasetPath(chosen.datasetPath);
      setBrowseNotice(chosen.requiresRestart
        ? `Dataset root changed to ${chosen.datasetsRoot}. Restart Neuravian before importing this dataset.`
        : null);
      setRequiresRestart(chosen.requiresRestart);
      if (chosen.datasetsRoot) onDatasetsRootChanged?.(chosen.datasetsRoot);
      reset();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!datasetPath.trim()) return;
    mutate(datasetPath.trim(), { onSuccess: (d) => onImported?.(d) });
  }

  function friendlyError(err: unknown): string {
    if (!(err instanceof Error)) return "An unknown error occurred.";
    const msg = err.message;
    if (msg.includes("outside the configured dataset root") || msg.includes("outside")) {
      return 'This folder is outside the configured dataset root. Use "Change dataset root" in the header above, or move the dataset inside the current root folder.';
    }
    return msg;
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          aria-label="Absolute path to BIDS dataset"
          value={datasetPath}
          onChange={(e) => { setDatasetPath(e.target.value); setBrowseNotice(null); setRequiresRestart(false); reset(); }}
          placeholder="/absolute/path/to/bids-dataset"
          className="flex-1 rounded-md bg-surface-overlay border border-white/10 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-accent"
          disabled={isPending}
        />
        {desktop?.browseForDatasetFolder && (
          <button
            type="button"
            onClick={() => void handleBrowse()}
            disabled={isPending}
            className="rounded-md border border-white/15 bg-surface-raised px-3 py-2 text-sm text-gray-300 disabled:opacity-50 hover:bg-white/8 transition-colors"
          >
            Browse…
          </button>
        )}
        <button
          type="submit"
          disabled={isPending || requiresRestart || !datasetPath.trim()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-accent-hover transition-colors"
        >
          {isPending ? "Importing…" : "Import dataset"}
        </button>
      </form>

      {browseNotice && (
        <div role="alert" className="rounded-md border border-amber-600/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
          {browseNotice}
        </div>
      )}

      {isError && (
        <div role="alert" className="rounded-md border border-red-700/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          <p className="font-semibold">Dataset could not be imported</p>
          <p className="mt-1 text-xs text-red-200/80">{friendlyError(error)}</p>
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
