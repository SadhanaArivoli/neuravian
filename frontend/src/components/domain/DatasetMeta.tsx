import type { Dataset } from "../../api/client";
import { ValidationResults, ValidationStatusBanner } from "./ValidationResults";

function MetaRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-start gap-4 py-2 border-b border-white/5 last:border-0">
      <span className="w-36 shrink-0 text-xs text-gray-500 uppercase tracking-wider pt-0.5">
        {label}
      </span>
      <span className="text-sm text-gray-100">{value}</span>
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="text-sm text-gray-500">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span
          key={item}
          className="rounded bg-surface-overlay px-2 py-0.5 text-xs text-gray-300 font-mono"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

interface Props {
  dataset: Dataset;
}

export function DatasetMeta({ dataset }: Props) {
  const meta = dataset.indexed_metadata;

  return (
    <div className="space-y-6">
      {/* Status */}
      <div className="flex items-center gap-3">
        <ValidationStatusBanner status={dataset.validation_status} />
        {meta?.bids_version && (
          <span className="text-xs text-gray-400">BIDS {meta.bids_version}</span>
        )}
      </div>

      {/* Core metadata table */}
      {meta && (
        <div className="rounded-md border border-white/10 bg-surface-raised p-4">
          <MetaRow label="Path" value={dataset.path} />
          <MetaRow label="Files" value={meta.file_count} />
          <div className="flex items-start gap-4 py-2 border-b border-white/5">
            <span className="w-36 shrink-0 text-xs text-gray-500 uppercase tracking-wider pt-1">
              Subjects
            </span>
            <div>
              <Chips items={meta.subjects.map((s) => `sub-${s}`)} />
            </div>
          </div>
          {meta.sessions.length > 0 && (
            <div className="flex items-start gap-4 py-2 border-b border-white/5">
              <span className="w-36 shrink-0 text-xs text-gray-500 uppercase tracking-wider pt-1">
                Sessions
              </span>
              <Chips items={meta.sessions.map((s) => `ses-${s}`)} />
            </div>
          )}
          {meta.tasks.length > 0 && (
            <div className="flex items-start gap-4 py-2 border-b border-white/5">
              <span className="w-36 shrink-0 text-xs text-gray-500 uppercase tracking-wider pt-1">
                Tasks
              </span>
              <Chips items={meta.tasks.map((t) => `task-${t}`)} />
            </div>
          )}
          <div className="flex items-start gap-4 py-2 border-b border-white/5">
            <span className="w-36 shrink-0 text-xs text-gray-500 uppercase tracking-wider pt-1">
              Datatypes
            </span>
            <Chips items={meta.datatypes} />
          </div>
          <div className="flex items-start gap-4 py-2">
            <span className="w-36 shrink-0 text-xs text-gray-500 uppercase tracking-wider pt-1">
              Modalities
            </span>
            <Chips items={meta.suffixes} />
          </div>
        </div>
      )}

      {/* Validation issues */}
      {dataset.validation_issues && (
        <div>
          <h3 className="mb-3 text-sm font-medium text-gray-300">
            Validation details
          </h3>
          <ValidationResults issues={dataset.validation_issues} />
        </div>
      )}
    </div>
  );
}
