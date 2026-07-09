import { useState } from "react";
import type { Dataset, DatasetScan } from "../../api/client";
import { useDatasetScans } from "../../hooks/useDatasets";
import NiivueViewer from "./NiivueViewer";
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

const BASE_URL = import.meta.env.VITE_API_URL ?? "/api";

function scanFileUrl(datasetId: number, filePath: string): string {
  return `${BASE_URL}/datasets/${datasetId}/files/${filePath}`;
}

// Suffix → human label
const SUFFIX_LABELS: Record<string, string> = {
  T1w: "T1w structural",
  T2w: "T2w structural",
  bold: "BOLD functional",
  inplaneT2: "In-plane T2",
  dwi: "Diffusion (DWI)",
  flair: "FLAIR",
  angio: "Angio",
};

function ScanBrowser({ datasetId }: { datasetId: number }) {
  const { data, isLoading, isError } = useDatasetScans(datasetId);
  const [viewerFile, setViewerFile] = useState<DatasetScan | null>(null);
  const [expandedSubjects, setExpandedSubjects] = useState<Set<string>>(new Set());

  if (isLoading) {
    return (
      <p className="text-xs text-gray-500 animate-pulse">Loading scan files…</p>
    );
  }
  if (isError || !data) {
    return (
      <p className="text-xs text-gray-500">Could not load scan file list.</p>
    );
  }
  if (data.scans.length === 0) {
    return (
      <p className="text-xs text-gray-500">No NIfTI files found in this dataset.</p>
    );
  }

  // Group by subject
  const bySubject = new Map<string, DatasetScan[]>();
  for (const scan of data.scans) {
    const list = bySubject.get(scan.subject) ?? [];
    list.push(scan);
    bySubject.set(scan.subject, list);
  }

  const toggleSubject = (sub: string) => {
    setExpandedSubjects((prev) => {
      const next = new Set(prev);
      if (next.has(sub)) next.delete(sub);
      else next.add(sub);
      return next;
    });
  };

  return (
    <>
      {viewerFile && (
        <NiivueViewer
          layers={[{
            url: scanFileUrl(datasetId, viewerFile.path),
            name: viewerFile.path.split("/").pop() ?? viewerFile.path,
          }]}
          onClose={() => setViewerFile(null)}
        />
      )}
      <div className="space-y-1">
        {Array.from(bySubject.entries()).map(([subject, scans]) => {
          const expanded = expandedSubjects.has(subject);
          return (
            <div key={subject} className="rounded border border-white/10 overflow-hidden">
              <button
                onClick={() => toggleSubject(subject)}
                className="w-full flex items-center justify-between px-3 py-2 bg-surface-raised hover:bg-surface-overlay text-sm text-gray-200 text-left"
              >
                <span className="font-mono">sub-{subject}</span>
                <span className="text-xs text-gray-500">
                  {scans.length} file{scans.length !== 1 ? "s" : ""}{" "}
                  {expanded ? "▲" : "▼"}
                </span>
              </button>
              {expanded && (
                <div className="divide-y divide-white/5">
                  {scans.map((scan) => (
                    <div
                      key={scan.path}
                      className="flex items-center justify-between px-3 py-2 bg-gray-950/30 gap-3"
                    >
                      <div className="min-w-0">
                        <p className="text-xs text-gray-300 font-mono truncate">
                          {scan.path.split("/").pop()}
                        </p>
                        <p className="text-xs text-gray-400">
                          {scan.datatype}
                          {scan.session ? ` · ses-${scan.session}` : ""}
                          {" · "}
                          {SUFFIX_LABELS[scan.suffix] ?? scan.suffix}
                        </p>
                      </div>
                      <button
                        onClick={() => setViewerFile(scan)}
                        className="shrink-0 rounded border border-blue-700 px-2.5 py-1 text-xs text-blue-400 hover:bg-blue-900/40 transition-colors"
                      >
                        View
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
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

      {/* Scan browser */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-gray-300">Browse scans</h3>
        <ScanBrowser datasetId={dataset.id} />
      </div>
    </div>
  );
}
