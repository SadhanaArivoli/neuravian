import { useState } from "react";
import { Link } from "react-router-dom";
import type { Dataset } from "../api/client";
import { DatasetImportForm } from "../components/domain/DatasetImportForm";
import { ValidationStatusBanner } from "../components/domain/ValidationResults";
import { EmptyState } from "../components/primitives/EmptyState";
import { useDatasets } from "../hooks/useDatasets";
import { useWorkspace } from "../context/WorkspaceContext";
import { useCloudWorkspace } from "../hooks/useCloudWorkspace";
import { useAllCloudSnapshots } from "../hooks/useAllCloudSnapshots";

export default function Datasets() {
  const { selected } = useWorkspace();
  const { data: datasets, isLoading } = useDatasets();
  const [showImport, setShowImport] = useState(false);
  const isCloud = Boolean(window.neuroforgeDesktop) && selected.startsWith("cloud:");
  const isAll = Boolean(window.neuroforgeDesktop) && selected === "all";
  const cloud = useCloudWorkspace();
  const allCloud = useAllCloudSnapshots();

  function handleImported(dataset: Dataset) {
    void dataset;
  }

  // ── All Workspaces branch ─────────────────────────────────────────────────
  if (isAll) {
    const localDatasets = datasets ?? [];
    const cloudLoading = allCloud.some((c) => c.loading && !c.snapshot);
    const allCloudDatasets: Array<{ profileName: string; ds: Record<string, unknown> & { id: number; remoteKey: string } }> = [];
    for (const { profile, snapshot } of allCloud) {
      for (const ds of snapshot?.datasets ?? []) {
        allCloudDatasets.push({ profileName: profile.name, ds });
      }
    }

    return (
      <div className="p-8 max-w-4xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold">Datasets</h1>
            <p className="text-xs text-gray-500 mt-1">
              All Workspaces · {localDatasets.length} local · {allCloudDatasets.length} cloud
            </p>
          </div>
        </div>

        {cloudLoading && (
          <p className="text-xs text-gray-500 animate-pulse mb-4">Syncing cloud datasets…</p>
        )}

        <div className="space-y-2">
          {/* Local datasets */}
          {localDatasets.map((d) => (
            <Link
              key={`local-${d.id}`}
              to={`/datasets/${d.id}`}
              className="block rounded-md border border-white/10 bg-surface-raised p-4 hover:border-accent/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-gray-100 truncate">{d.name ?? d.path}</p>
                    <span className="shrink-0 rounded-full border border-white/15 bg-white/8 px-2 py-0.5 text-[10px] text-gray-400">Local</span>
                  </div>
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

          {/* Cloud datasets */}
          {allCloudDatasets.map(({ profileName, ds }) => {
            const name = (ds.name as string | undefined) ?? `Dataset #${ds.id}`;
            return (
              <div
                key={`cloud-${ds.remoteKey}`}
                className="block rounded-md border border-accent/20 bg-surface-raised p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-100 truncate">{name}</p>
                      <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">Cloud · {profileName}</span>
                    </div>
                    {!!ds.path && <p className="text-xs text-gray-500 truncate mt-0.5">{String(ds.path)}</p>}
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                      {ds.subject_count !== undefined && (
                        <span>{ds.subject_count as number} subject{(ds.subject_count as number) !== 1 ? "s" : ""}</span>
                      )}
                      {!!ds.bids_version && <span>BIDS {String(ds.bids_version)}</span>}
                    </div>
                  </div>
                  {!!ds.validation_status && (
                    <ValidationStatusBanner status={ds.validation_status as Dataset["validation_status"]} />
                  )}
                </div>
              </div>
            );
          })}

          {localDatasets.length === 0 && allCloudDatasets.length === 0 && !isLoading && !cloudLoading && (
            <EmptyState
              title="No datasets found"
              description="Import a local BIDS dataset or connect a cloud workspace with datasets."
              action={
                <button
                  onClick={() => setShowImport(true)}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
                >
                  Import a dataset
                </button>
              }
            />
          )}
        </div>
      </div>
    );
  }

  if (isCloud) {
    const cloudDatasets = cloud.snapshot?.datasets ?? [];
    return (
      <div className="p-8 max-w-4xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold">Datasets</h1>
            <p className="text-xs text-gray-500 mt-1">
              {cloud.profile?.name ?? "Cloud workspace"} ·{" "}
              {cloud.loading ? "Syncing…" : cloud.online ? "Online" : "Offline (cached)"} ·{" "}
              {cloudDatasets.length} dataset{cloudDatasets.length !== 1 ? "s" : ""}
            </p>
          </div>
          <button
            onClick={() => void cloud.sync()}
            disabled={cloud.loading}
            className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
          >
            {cloud.loading ? "Syncing…" : "Sync now"}
          </button>
        </div>

        {cloud.error && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300">
            {cloud.error} — showing cached data.
          </div>
        )}

        {cloud.loading && !cloud.snapshot && (
          <p className="text-sm text-gray-400 animate-pulse">Syncing cloud datasets…</p>
        )}

        {!cloud.loading && cloudDatasets.length === 0 && (
          <div className="rounded-lg border border-white/10 bg-surface-raised px-6 py-8 text-center">
            <p className="text-sm text-gray-400">No datasets found in this cloud workspace.</p>
          </div>
        )}

        {cloudDatasets.length > 0 && (
          <div className="space-y-2">
            {cloudDatasets.map((d) => {
              const ds = d as Record<string, unknown>;
              return (
                <div
                  key={d.id}
                  className="block rounded-md border border-white/10 bg-surface-raised p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-gray-100 truncate">
                          {(ds.name as string | undefined) ?? `Dataset #${d.id}`}
                        </p>
                        <span className="shrink-0 rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">Cloud</span>
                      </div>
                      {!!ds.path && <p className="text-xs text-gray-500 truncate mt-0.5">{String(ds.path)}</p>}
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        {ds.subject_count !== undefined && (
                          <span>{ds.subject_count as number} subject{(ds.subject_count as number) !== 1 ? "s" : ""}</span>
                        )}
                        {!!ds.bids_version && <span>BIDS {String(ds.bids_version)}</span>}
                        {!!ds.modalities && (
                          <span>{(ds.modalities as string[]).join(", ")}</span>
                        )}
                      </div>
                      <p className="mt-1.5 text-[10px] font-mono text-gray-600 break-all">{d.remoteKey}</p>
                    </div>
                    {!!ds.validation_status && (
                      <ValidationStatusBanner status={ds.validation_status as Dataset["validation_status"]} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Datasets</h1>
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
        <EmptyState
          title="No datasets yet."
          description="Import a BIDS dataset folder to validate and index it."
          action={
            <button
              onClick={() => setShowImport(true)}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors"
            >
              Import your first dataset
            </button>
          }
          hint="Tip: Click '+ Import dataset' above and enter the full path to your BIDS folder on disk."
        />
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
