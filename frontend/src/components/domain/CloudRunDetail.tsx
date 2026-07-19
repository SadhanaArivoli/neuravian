import { useEffect, useState } from "react";
import { type CloudViewerLayer, CloudNiivueViewer } from "./CloudNiivueViewer";

// ── helpers ───────────────────────────────────────────────────────────────────

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function cacheLabel(state: WorkspaceCacheState): string {
  return ({
    "cloud-only": "Cloud Only",
    downloading: "Downloading",
    "partially-cached": "Partially Cached",
    "fully-cached": "Fully Cached",
    "offline-cached": "Offline Cached",
    "local-only": "Local Only",
    "server-unavailable": "Sync Failed",
  } as Record<WorkspaceCacheState, string>)[state] ?? state;
}

function cacheClass(state: WorkspaceCacheState): string {
  if (state === "fully-cached" || state === "offline-cached") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
  if (state === "downloading" || state === "partially-cached") return "border-amber-400/25 bg-amber-400/10 text-amber-300";
  if (state === "server-unavailable") return "border-red-400/25 bg-red-400/10 text-red-300";
  return "border-accent/20 bg-accent/10 text-accent";
}

function Badge({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "cloud" | "success" | "warning" | "danger" }) {
  const style = {
    slate: "border-white/10 bg-white/5 text-gray-300",
    cloud: "border-accent/20 bg-accent/10 text-accent",
    success: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
    warning: "border-amber-400/20 bg-amber-400/10 text-amber-300",
    danger: "border-red-400/20 bg-red-400/10 text-red-300",
  }[tone];
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${style}`}>{children}</span>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-surface-raised p-4">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-white">{value}</p>
      {detail && <p className="mt-1 text-xs text-gray-500">{detail}</p>}
    </div>
  );
}

// ── artifact table ─────────────────────────────────────────────────────────────

function ArtifactTable({ run }: { run: WorkspaceRun }) {
  if (!run.artifacts.length) {
    return <p className="text-sm text-gray-500">No artifact manifest available.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-white/8">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="bg-surface/70 text-gray-500">
          <tr>
            <th className="px-3 py-2">Artifact</th>
            <th className="px-3 py-2">Location</th>
            <th className="px-3 py-2">Size</th>
            <th className="px-3 py-2">Checksum</th>
            <th className="px-3 py-2">Geometry</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {run.artifacts.map((artifact) => {
            const cached = run.cachedArtifacts.includes(artifact.relativePath);
            return (
              <tr key={String(artifact.artifactId)} className="text-gray-300">
                <td className="px-3 py-2 font-mono text-[11px]">{artifact.relativePath}</td>
                <td className="px-3 py-2">
                  <Badge tone={cached ? "success" : "cloud"}>{cached ? "Cached" : "Cloud"}</Badge>
                </td>
                <td className="px-3 py-2">{formatBytes(artifact.sizeBytes)}</td>
                <td className="px-3 py-2 font-mono text-[10px]" title={artifact.sha256}>
                  {artifact.sha256.slice(0, 12)}…
                </td>
                <td className="px-3 py-2">
                  {artifact.geometry
                    ? `${artifact.geometry.shape.join("×")} · ${artifact.geometry.orientation.join("")}`
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── main component ─────────────────────────────────────────────────────────────

export interface CloudRunDetailProps {
  run: WorkspaceRun;
  profile: WorkspaceProfile;
  workspaceId: string;
  online: boolean;
  inspection?: WorkspaceInspection | null;
  onClose: () => void;
  onCacheChanged?: () => void;
}

export function CloudRunDetail({
  run, profile, workspaceId, online, inspection: inspectionProp, onClose, onCacheChanged,
}: CloudRunDetailProps) {
  const desktop = window.neuroforgeDesktop!;
  const [tab, setTab] = useState<"overview" | "artifacts" | "logs" | "provenance" | "reports">("overview");
  const [downloading, setDownloading] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncAllResult, setSyncAllResult] = useState<{ downloaded: number; reused: number } | null>(null);
  const [syncAllError, setSyncAllError] = useState<string | null>(null);
  const [localInspection, setLocalInspection] = useState<WorkspaceInspection | null>(null);
  const [showViewer, setShowViewer] = useState(false);
  const [locatingViewer, setLocatingViewer] = useState(false);

  useEffect(() => {
    void desktop.inspectWorkspace({ profileId: profile.id, workspaceId })
      .then(setLocalInspection)
      .catch(() => { /* offline or unavailable */ });
  }, [profile.id, workspaceId]);

  const inspection = inspectionProp ?? localInspection;

  const anatomy = run.artifacts.find((a) => a.relativePath.endsWith("/mri/orig_nu.mgz"));
  const segmentation = run.artifacts.find((a) => a.relativePath.endsWith("/mri/aseg.auto.mgz"));
  const freeview = inspection?.viewers.find((v) => v.viewerId === "freeview");
  const mricrogl = inspection?.viewers.find((v) => v.viewerId === "mricrogl");
  const fastsurferRequired = anatomy && segmentation
    ? [anatomy.relativePath, segmentation.relativePath]
    : [];
  const fastsurferCached = fastsurferRequired.length > 0
    && fastsurferRequired.every((p) => run.cachedArtifacts.includes(p));

  // Determine the best available primary action.
  // Priority: NeuroForge Viewer > FreeView > MRIcroGL > Cloud Browser.
  // NeuroForge Viewer is the built-in viewer and requires no external install.
  const isFullyCached = run.cacheState === "fully-cached" || run.cacheState === "offline-cached";
  const freeviewCanOpen = !!(freeview?.installed && fastsurferRequired.length === 2 && (online || fastsurferCached));
  const mricroglCanOpen = !!(mricrogl?.installed && fastsurferCached && fastsurferRequired.length === 2);
  const neuroforgeViewerCanOpen = fastsurferCached && fastsurferRequired.length === 2;
  const primaryAction: "freeview" | "mricrogl" | "neuroforge-viewer" | "cloud-browser" =
    neuroforgeViewerCanOpen ? "neuroforge-viewer"
    : freeviewCanOpen ? "freeview"
    : mricroglCanOpen ? "mricrogl"
    : "cloud-browser";

  // Human-readable explanation of why this primary action was chosen.
  const reasoningLines = ((): string[] => {
    const cacheLine = isFullyCached
      ? `✓ All ${run.artifacts.length} artifacts are stored locally.`
      : run.cachedArtifacts.length > 0
      ? `${run.cachedArtifacts.length} of ${run.artifacts.length} artifacts cached locally.`
      : "Artifacts are not cached locally.";

    if (neuroforgeViewerCanOpen) return [cacheLine, "Artifacts cached locally.", "Primary action: Open in NeuroForge Viewer."];
    if (freeviewCanOpen) return [cacheLine, "FreeView detected.", "Primary action: Open in FreeView."];
    if (mricroglCanOpen) return [cacheLine, "MRIcroGL detected.", "Primary action: Open in MRIcroGL."];
    if (freeview?.installed && fastsurferRequired.length !== 2) {
      return [cacheLine, "No compatible artifacts for this pipeline.", "Primary action: Open in Cloud Browser."];
    }
    if (freeview?.installed && !online && !fastsurferCached) {
      return [cacheLine, "Required artifacts not yet downloaded.", "Primary action: Open in Cloud Browser."];
    }
    return [cacheLine, "Primary action: Open in Cloud Browser."];
  })();

  async function openFreeView() {
    if (!freeview?.installed || fastsurferRequired.length !== 2 || (!online && !fastsurferCached)) return;
    setMessage(null);
    try {
      if (online) {
        setDownloading(fastsurferRequired);
        const result = await desktop.syncWorkspaceArtifacts({
          profileId: profile.id, workspaceId, runId: run.id,
          relativePaths: fastsurferRequired,
        });
        setMessage(`${result.downloaded.length} downloaded · ${result.reused.length} reused`);
      }
      await desktop.launchViewer({
        viewerId: "freeview", workspaceId, runId: run.id,
        files: [
          { relativePath: fastsurferRequired[0] },
          { relativePath: fastsurferRequired[1], overlay: true },
        ],
        opacity: 0.7, freesurferLut: true,
      });
      onCacheChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloading([]);
    }
  }

  async function openMRIcroGL() {
    if (!mricrogl?.installed || fastsurferRequired.length !== 2 || !fastsurferCached) return;
    setMessage(null);
    try {
      await desktop.launchViewer({
        viewerId: "mricrogl", workspaceId, runId: run.id,
        files: fastsurferRequired.map((p) => ({ relativePath: p })),
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function locateMRIcroGL() {
    setLocatingViewer(true);
    try {
      const chosen = await desktop.browseForViewer("mricrogl");
      if (!chosen) return;
      await desktop.saveViewerConfig({ viewerId: "mricrogl", executablePath: chosen });
      // Re-run inspection so the viewer detection updates with the new path.
      const updated = await desktop.inspectWorkspace({ profileId: profile.id, workspaceId });
      setLocalInspection(updated as WorkspaceInspection);
      setMessage("MRIcroGL path saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLocatingViewer(false);
    }
  }

  const fastsurferLayers: CloudViewerLayer[] = fastsurferRequired.length === 2 ? [
    { relativePath: fastsurferRequired[0], label: "orig_nu.mgz" },
    { relativePath: fastsurferRequired[1], label: "aseg.auto.mgz", isOverlay: true, opacity: 0.7 },
  ] : [];

  async function downloadAll() {
    if (!online || run.artifacts.length === 0 || syncingAll) return;
    setSyncingAll(true);
    setSyncAllResult(null);
    setSyncAllError(null);
    try {
      const result = await desktop.syncAllRunArtifacts({ profileId: profile.id, workspaceId, runId: run.id });
      setSyncAllResult({ downloaded: result.downloaded.length, reused: result.reused.length });
      onCacheChanged?.();
    } catch (e) {
      setSyncAllError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingAll(false);
    }
  }

  const tabs = ["overview", "artifacts", "logs", "provenance", "reports"] as const;

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm"
      role="dialog"
      aria-label={`Cloud Run #${run.id} — ${run.pipeline_manifest_id}`}
    >
      <div className="h-full w-full max-w-4xl overflow-y-auto border-l border-white/10 bg-surface p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold text-white">Run #{run.id}</h2>
              <Badge tone="cloud">Cloud</Badge>
              <Badge tone="success">Metadata Cached</Badge>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${cacheClass(run.cacheState)}`}>
                {cacheLabel(run.cacheState)}
              </span>
            </div>
            <p className="mt-1 text-sm text-gray-400">{run.pipeline_manifest_id} · {run.status}</p>
            <p className="mt-0.5 text-xs text-gray-500">{profile.name} · {profile.serverUrl}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close run detail"
            className="rounded-md border border-white/10 px-3 py-1 text-sm text-gray-300 hover:text-white transition-colors"
          >
            Close
          </button>
        </div>

        {/* Metrics */}
        <div className="mt-5 grid gap-3 sm:grid-cols-4">
          <Metric label="Artifacts" value={run.artifacts.length} detail={`${run.cachedArtifacts.length} cached`} />
          <Metric label="Reports" value={run.reports?.length ?? 0} />
          <Metric label="Created" value={new Date(run.created_at).toLocaleDateString()} />
          <Metric
            label="Completed"
            value={run.finished_at ? new Date(run.finished_at).toLocaleDateString() : "—"}
          />
        </div>

        {/* Tabs */}
        <div className="mt-5 flex gap-1 border-b border-white/8">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs capitalize transition-colors ${
                tab === t
                  ? "border-b-2 border-accent text-accent"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="mt-5">
          {tab === "overview" && (
            <div className="space-y-6">
              {/* Artifact persistence banner */}
              {run.status === "success" && run.artifacts.length > 0 && run.cacheState !== "fully-cached" && run.cacheState !== "offline-cached" && (
                <section className="rounded-lg border border-accent/20 bg-accent/5 p-4">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <h3 className="text-sm font-semibold text-accent">Sync artifacts before terminating EC2</h3>
                      <p className="mt-1 text-xs text-gray-400">
                        {run.cachedArtifacts.length} of {run.artifacts.length} artifact{run.artifacts.length !== 1 ? "s" : ""} cached locally.
                        Downloading all outputs makes this run permanently available offline.
                        {!online && " Reconnect to the cloud workspace to download."}
                      </p>
                    </div>
                    {online && (
                      <button
                        onClick={() => void downloadAll()}
                        disabled={syncingAll}
                        className="shrink-0 rounded-lg border border-accent/30 bg-accent/15 px-4 py-2 text-sm font-semibold text-accent hover:bg-accent/25 disabled:opacity-50 transition-colors"
                      >
                        {syncingAll ? "Downloading…" : `Download all ${run.artifacts.length} artifacts`}
                      </button>
                    )}
                  </div>
                  {syncingAll && (
                    <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                      Downloading artifacts in background — you can close this panel.
                    </div>
                  )}
                  {syncAllResult && (
                    <p className="mt-2 text-xs text-emerald-300">
                      ✓ Sync complete — {syncAllResult.downloaded} downloaded, {syncAllResult.reused} already cached.
                    </p>
                  )}
                  {syncAllError && (
                    <p className="mt-2 text-xs text-red-400">Sync failed: {syncAllError}</p>
                  )}
                </section>
              )}

              {/* Viewer actions */}
              <section>
                <h3 className="text-sm font-semibold text-white mb-3">Open results</h3>

                {/* Reasoning — explains why the primary action was chosen */}
                <div className={`mb-4 rounded-lg border px-4 py-3 text-xs space-y-1 ${
                  primaryAction === "freeview" || primaryAction === "mricrogl" || primaryAction === "neuroforge-viewer"
                    ? "border-emerald-400/20 bg-emerald-400/5"
                    : "border-white/8 bg-white/3"
                }`}>
                  {reasoningLines.map((line, i) => (
                    <p
                      key={i}
                      className={
                        i === reasoningLines.length - 1
                          ? `font-medium ${primaryAction !== "cloud-browser" ? "text-emerald-200" : "text-gray-300"}`
                          : i === 0 && isFullyCached
                          ? "text-emerald-300"
                          : "text-gray-400"
                      }
                    >
                      {line}
                    </p>
                  ))}
                </div>

                {/* Primary action button — full width, visually dominant */}
                {primaryAction === "freeview" && (
                  <button
                    onClick={() => void openFreeView()}
                    className="w-full rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-5 py-4 text-left transition-colors hover:bg-emerald-400/15"
                  >
                    <span className="text-sm font-semibold text-emerald-200">Open in FreeView</span>
                    <span className="mt-1 block text-[10px] text-gray-400">
                      {fastsurferCached ? "Ready from local cache" : "Will download 2 required artifacts"}
                    </span>
                  </button>
                )}
                {primaryAction === "mricrogl" && (
                  <button
                    onClick={() => void openMRIcroGL()}
                    className="w-full rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-5 py-4 text-left transition-colors hover:bg-emerald-400/15"
                  >
                    <span className="text-sm font-semibold text-emerald-200">Open in MRIcroGL</span>
                    <span className="mt-1 block text-[10px] text-gray-400">Ready from local cache</span>
                  </button>
                )}
                {primaryAction === "neuroforge-viewer" && (
                  <button
                    onClick={() => setShowViewer(true)}
                    className="w-full rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-5 py-4 text-left transition-colors hover:bg-emerald-400/15"
                  >
                    <span className="text-sm font-semibold text-emerald-200">Open in NeuroForge Viewer</span>
                    <span className="mt-1 block text-[10px] text-gray-400">Built-in NiiVue viewer — no external tool required</span>
                  </button>
                )}
                {primaryAction === "cloud-browser" && (
                  <button
                    onClick={() => void desktop.openWorkspaceRun({ profileId: profile.id, runId: run.id })}
                    className="w-full rounded-xl border border-accent/25 bg-accent/10 px-5 py-4 text-left transition-colors hover:bg-accent/15"
                  >
                    <span className="text-sm font-semibold text-accent">Open in Cloud Browser</span>
                    <span className="mt-1 block text-[10px] text-gray-400">Opens run detail in authenticated browser tab</span>
                  </button>
                )}

                {/* Secondary local viewers */}
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {/* NeuroForge Viewer — available when FastSurfer artifacts are cached */}
                  <button
                    disabled={!neuroforgeViewerCanOpen || primaryAction === "neuroforge-viewer"}
                    onClick={() => setShowViewer(true)}
                    className="rounded-lg border border-white/8 bg-white/4 p-3 text-left transition-colors hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <span className="text-xs font-medium text-gray-400">Open in NeuroForge Viewer</span>
                    <span className="mt-0.5 block text-[10px] text-gray-600">
                      {neuroforgeViewerCanOpen
                        ? primaryAction === "neuroforge-viewer" ? "Selected as primary action above" : "Built-in NiiVue viewer"
                        : fastsurferRequired.length !== 2
                        ? "No compatible artifacts for this pipeline"
                        : "Required artifacts not cached locally"}
                    </span>
                  </button>

                  {/* MRIcroGL — with "Locate…" when not installed */}
                  <div className="flex flex-col gap-1">
                    <button
                      disabled={!mricroglCanOpen || primaryAction === "mricrogl"}
                      onClick={() => void openMRIcroGL()}
                      className="rounded-lg border border-white/8 bg-white/4 p-3 text-left transition-colors hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <span className="text-xs font-medium text-gray-400">Open in MRIcroGL</span>
                      <span className="mt-0.5 block text-[10px] text-gray-600">
                        {mricrogl?.installed
                          ? primaryAction === "mricrogl" ? "Selected as primary action above"
                            : !fastsurferCached ? "Required artifacts not cached"
                            : "Ready from local cache"
                          : "Not detected"}
                      </span>
                    </button>
                    {!mricrogl?.installed && (
                      <button
                        onClick={() => void locateMRIcroGL()}
                        disabled={locatingViewer}
                        className="rounded-md border border-white/8 px-2 py-1 text-[10px] text-gray-500 hover:text-gray-300 disabled:opacity-50 transition-colors"
                      >
                        {locatingViewer ? "Locating…" : "Locate MRIcroGL…"}
                      </button>
                    )}
                  </div>
                </div>

                {/* Cloud section — shown as a secondary option when a local viewer is primary */}
                {(primaryAction === "freeview" || primaryAction === "mricrogl" || primaryAction === "neuroforge-viewer") && (
                  <div className="mt-5">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-px flex-1 bg-white/8" />
                      <span className="text-[10px] uppercase tracking-widest text-gray-600">Cloud</span>
                      <div className="h-px flex-1 bg-white/8" />
                    </div>
                    <button
                      onClick={() => void desktop.openWorkspaceRun({ profileId: profile.id, runId: run.id })}
                      className="w-full rounded-lg border border-white/8 bg-white/3 p-3 text-left transition-colors hover:bg-white/6"
                    >
                      <span className="text-xs font-medium text-gray-500">Open in Cloud Browser</span>
                      <span className="mt-0.5 block text-[10px] text-gray-600">Opens run detail in authenticated browser tab</span>
                    </button>
                  </div>
                )}

                {/* FreeView shown as secondary when cloud browser is primary (and FreeView wasn't already chosen above) */}
                {primaryAction === "cloud-browser" && (freeview !== undefined || fastsurferRequired.length > 0) && (
                  <div className="mt-3">
                    <button
                      disabled={!freeview?.installed || fastsurferRequired.length !== 2 || (!online && !fastsurferCached)}
                      onClick={() => void openFreeView()}
                      className="w-full rounded-lg border border-white/8 bg-white/4 p-3 text-left transition-colors hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <span className="text-xs font-medium text-gray-400">Open in FreeView</span>
                      <span className="mt-0.5 block text-[10px] text-gray-600">
                        {!freeview?.installed
                          ? (freeview?.reason ?? "Not installed")
                          : fastsurferRequired.length !== 2
                          ? "No compatible artifacts for this pipeline"
                          : "Required artifacts not cached — reconnect to download"}
                      </span>
                    </button>
                  </div>
                )}

                {downloading.length > 0 && (
                  <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
                    <p className="text-xs font-semibold text-amber-300">Downloading artifacts</p>
                    {downloading.map((file) => (
                      <div key={file} className="mt-2 flex items-center gap-2 text-xs text-gray-300">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />
                        {file.split("/").pop()}
                      </div>
                    ))}
                  </div>
                )}
                {message && <p role="status" className="mt-3 text-xs text-gray-400">{message}</p>}
              </section>

              {/* Parameters */}
              <section>
                <h3 className="text-sm font-semibold text-white mb-2">Pipeline parameters</h3>
                <pre className="max-h-52 overflow-auto rounded-lg bg-surface/70 p-3 text-[11px] text-gray-400">
                  {JSON.stringify(run.parameters ?? {}, null, 2)}
                </pre>
              </section>
            </div>
          )}

          {tab === "artifacts" && (
            <div className="space-y-3">
              {online && run.status === "success" && run.cacheState !== "fully-cached" && run.cacheState !== "offline-cached" && (
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <p className="text-xs text-gray-400">
                    {run.cachedArtifacts.length} of {run.artifacts.length} cached locally
                  </p>
                  <button
                    onClick={() => void downloadAll()}
                    disabled={syncingAll}
                    className="rounded-md border border-accent/25 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20 disabled:opacity-50 transition-colors"
                  >
                    {syncingAll ? "Downloading…" : "Download all"}
                  </button>
                </div>
              )}
              {syncAllResult && (
                <p className="text-xs text-emerald-300">
                  ✓ {syncAllResult.downloaded} downloaded, {syncAllResult.reused} already cached.
                </p>
              )}
              {syncAllError && <p className="text-xs text-red-400">Sync failed: {syncAllError}</p>}
              <ArtifactTable run={run} />
            </div>
          )}

          {tab === "logs" && (
            <pre className="max-h-[65vh] overflow-auto rounded-lg bg-surface/70 p-4 text-[11px] text-gray-400 whitespace-pre-wrap">
              {typeof run.logs === "object" && run.logs !== null && "log_text" in run.logs
                ? String((run.logs as { log_text: string }).log_text)
                : JSON.stringify(run.logs ?? { message: "No logs cached" }, null, 2)}
            </pre>
          )}

          {tab === "provenance" && (
            <pre className="max-h-[65vh] overflow-auto rounded-lg bg-surface/70 p-4 text-[11px] text-gray-400">
              {JSON.stringify(run.provenance ?? { message: "No provenance cached" }, null, 2)}
            </pre>
          )}

          {tab === "reports" && (
            <div>
              {!run.reports || run.reports.length === 0 ? (
                <p className="text-sm text-gray-500">No reports attached to this run.</p>
              ) : (
                <pre className="max-h-[65vh] overflow-auto rounded-lg bg-surface/70 p-4 text-[11px] text-gray-400">
                  {JSON.stringify(run.reports, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>

    {/* NeuroForge Viewer overlay — rendered outside the slide-in panel so it covers the full screen */}
    {showViewer && fastsurferLayers.length > 0 && (
      <CloudNiivueViewer
        workspaceId={workspaceId}
        runId={run.id}
        layers={fastsurferLayers}
        onClose={() => setShowViewer(false)}
      />
    )}
    </>
  );
}
