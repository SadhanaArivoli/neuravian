import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type CloudViewerLayer, CloudNiivueViewer } from "./CloudNiivueViewer";
import { SharedRunDetail, type SharedRunDetailModel } from "./SharedRunDetail";
import {
  resolveArtifactCapabilities,
  resolveRunViewerCapabilities,
  selectDefaultViewerScene,
  classifyArtifactRole,
  type ArtifactSemanticRole,
} from "../../lib/artifact-capabilities";

// ── helpers ───────────────────────────────────────────────────────────────────

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function resolveReportAssetPath(reportPath: string, reference: string): string | null {
  if (!reference.startsWith("./") && !reference.startsWith("../")) return null;
  const parts = [...reportPath.split("/").slice(0, -1), ...reference.split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (resolved.length === 0) return null;
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

// ── Artifact browser ───────────────────────────────────────────────────────
//
// Replaces the flat raw table with a categorized, searchable browser.
// Artifacts are grouped by semantic role so researchers can immediately
// see what a run produced without scrolling through 40 unlabelled filenames.

const ROLE_META: Record<ArtifactSemanticRole, { label: string; color: string; order: number }> = {
  "anatomical-intensity": { label: "Structural MRI",     color: "text-blue-300 border-blue-400/25 bg-blue-400/10",         order: 0 },
  "defaced-intensity":    { label: "Defaced Volume",     color: "text-violet-300 border-violet-400/25 bg-violet-400/10",   order: 1 },
  "functional-intensity": { label: "Functional MRI",     color: "text-indigo-300 border-indigo-400/25 bg-indigo-400/10",   order: 2 },
  "diffusion-intensity":  { label: "Diffusion MRI",      color: "text-cyan-300 border-cyan-400/25 bg-cyan-400/10",         order: 3 },
  "segmentation":         { label: "Segmentation",       color: "text-orange-300 border-orange-400/25 bg-orange-400/10",   order: 4 },
  "mask":                 { label: "Brain Mask",         color: "text-yellow-300 border-yellow-400/25 bg-yellow-400/10",   order: 5 },
  "surface":              { label: "Surface Mesh",       color: "text-teal-300 border-teal-400/25 bg-teal-400/10",         order: 6 },
  "probability-map":      { label: "Tissue Probability", color: "text-pink-300 border-pink-400/25 bg-pink-400/10",         order: 7 },
  "statistical-map":      { label: "Statistical Map",    color: "text-red-300 border-red-400/25 bg-red-400/10",            order: 8 },
  "report":               { label: "QC Report",          color: "text-emerald-300 border-emerald-400/25 bg-emerald-400/10",order: 9 },
  "transform":            { label: "Spatial Transform",  color: "text-gray-400 border-white/15 bg-white/5",                order: 10 },
  "unknown-volume":       { label: "Volume",             color: "text-gray-400 border-white/15 bg-white/5",                order: 11 },
  "other":                { label: "Other",              color: "text-gray-500 border-white/10 bg-white/3",                order: 12 },
};

interface ArtifactBrowserProps {
  run: WorkspaceRun;
  online: boolean;
  onOpenViewer: (artifact: WorkspaceArtifact) => Promise<void>;
  onOpenReport: (relativePath: string) => Promise<void>;
  onDownload: (artifact: WorkspaceArtifact) => Promise<void>;
  downloadingPaths: string[];
}

function ArtifactBrowser({
  run, online, onOpenViewer, onOpenReport, onDownload, downloadingPaths,
}: ArtifactBrowserProps) {
  const [query, setQuery] = useState("");
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(
    new Set(["anatomical-intensity", "defaced-intensity", "functional-intensity", "report"]),
  );

  const cachedSet = useMemo(() => new Set(run.cachedArtifacts), [run.cachedArtifacts]);

  const classified = useMemo(() =>
    run.artifacts.map((a) => ({
      artifact: a,
      role: (a.semanticRole ?? classifyArtifactRole(a)) as ArtifactSemanticRole,
      cap: resolveArtifactCapabilities(a.relativePath),
      cached: cachedSet.has(a.relativePath),
    })),
  [run.artifacts, cachedSet]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return classified;
    return classified.filter(({ artifact, role }) =>
      artifact.relativePath.toLowerCase().includes(needle) ||
      ROLE_META[role].label.toLowerCase().includes(needle),
    );
  }, [classified, query]);

  const groups = useMemo(() => {
    const map = new Map<ArtifactSemanticRole, typeof classified>();
    for (const item of filtered) {
      const list = map.get(item.role) ?? [];
      list.push(item);
      map.set(item.role, list);
    }
    return [...map.entries()].sort(([a], [b]) => ROLE_META[a].order - ROLE_META[b].order);
  }, [filtered]);

  function toggleRole(role: string) {
    setExpandedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  if (!run.artifacts.length) {
    return <p className="text-sm text-gray-500">No artifact manifest available.</p>;
  }

  const cachedCount = run.cachedArtifacts.length;
  const totalCount = run.artifacts.length;

  return (
    <div className="space-y-3">
      {/* Search + summary */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            type="search"
            placeholder="Filter artifacts\u2026"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pl-8 pr-3 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
          />
        </div>
        <p className="text-[11px] text-gray-500 shrink-0">
          {cachedCount === totalCount
            ? `${totalCount} artifact${totalCount !== 1 ? "s" : "\u2014"}all cached`
            : `${cachedCount} of ${totalCount} cached`}
        </p>
      </div>

      {filtered.length === 0 && (
        <p className="py-6 text-center text-sm text-gray-600">No artifacts match &ldquo;{query}&rdquo;</p>
      )}

      {/* Role groups */}
      {groups.map(([role, items]) => {
        const meta = ROLE_META[role];
        const isExpanded = expandedRoles.has(role);
        const cachedInGroup = items.filter((i) => i.cached).length;
        return (
          <div key={role} className="rounded-xl border border-white/8 overflow-hidden">
            <button
              onClick={() => toggleRole(role)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/3 transition-colors"
            >
              <span className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.color}`}>
                {meta.label}
              </span>
              <span className="text-xs text-gray-500">
                {items.length} file{items.length !== 1 ? "s" : ""}
                {cachedInGroup < items.length && (
                  <span className="ml-1.5 text-amber-400/70">\u00b7 {items.length - cachedInGroup} not cached</span>
                )}
              </span>
              <span className="ml-auto text-gray-600 text-[11px]">{isExpanded ? "\u25b2" : "\u25bc"}</span>
            </button>

            {isExpanded && (
              <div className="divide-y divide-white/5 border-t border-white/8">
                {items.map(({ artifact, cap, cached }) => {
                  const filename = artifact.relativePath.split("/").pop() ?? artifact.relativePath;
                  const dir = artifact.relativePath.includes("/")
                    ? artifact.relativePath.slice(0, artifact.relativePath.lastIndexOf("/"))
                    : null;
                  const isDownloading = downloadingPaths.includes(artifact.relativePath);
                  const canView = (cap.isVolume || cap.isSurface) && cached;
                  const canViewReport = cap.isReport && cached;
                  const canFetch = !cached && online && (cap.isVolume || cap.isSurface || cap.isReport);

                  return (
                    <div
                      key={String(artifact.artifactId)}
                      className={`flex items-start gap-3 px-4 py-3 text-xs ${cached ? "" : "opacity-60"}`}
                    >
                      <span
                        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${cached ? "bg-emerald-400" : "bg-gray-600"}`}
                        title={cached ? "Cached locally" : "Cloud only"}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-200 truncate" title={artifact.relativePath}>
                          {filename}
                        </p>
                        {dir && (
                          <p className="text-[10px] text-gray-600 truncate mt-0.5" title={dir}>{dir}/</p>
                        )}
                        <p className="text-[10px] text-gray-600 mt-0.5">
                          {formatBytes(artifact.sizeBytes)}
                          {artifact.geometry && (
                            <span className="ml-2 text-gray-700">
                              {artifact.geometry.shape.join("\u00d7")} \u00b7 {artifact.geometry.orientation.join("")}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5 items-center">
                        {isDownloading && (
                          <span className="text-[10px] text-amber-300 flex items-center gap-1">
                            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                            Downloading
                          </span>
                        )}
                        {canView && !isDownloading && (
                          <button
                            onClick={() => void onOpenViewer(artifact)}
                            className="rounded-md border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-400/20 transition-colors"
                          >
                            Open
                          </button>
                        )}
                        {canViewReport && !isDownloading && (
                          <button
                            onClick={() => void onOpenReport(artifact.relativePath)}
                            className="rounded-md border border-emerald-400/25 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-400/20 transition-colors"
                          >
                            View
                          </button>
                        )}
                        {canFetch && !isDownloading && (
                          <button
                            onClick={() => void onDownload(artifact)}
                            className="rounded-md border border-accent/25 bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/20 transition-colors"
                          >
                            Fetch
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
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
  const navigate = useNavigate();
  const [tab, setTab] = useState<"overview" | "artifacts" | "logs" | "provenance" | "reports">("overview");
  const [downloading, setDownloading] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncAllResult, setSyncAllResult] = useState<{ downloaded: number; reused: number } | null>(null);
  const [syncAllError, setSyncAllError] = useState<string | null>(null);
  const [localInspection, setLocalInspection] = useState<WorkspaceInspection | null>(null);
  const [showViewer, setShowViewer] = useState(false);
  const [locatingViewer, setLocatingViewer] = useState(false);
  const [reportHtml, setReportHtml] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [browserDownloading, setBrowserDownloading] = useState<string[]>([]);
  const [browserViewerLayers, setBrowserViewerLayers] = useState<CloudViewerLayer[] | null>(null);

  useEffect(() => {
    void desktop.inspectWorkspace({ profileId: profile.id, workspaceId })
      .then(setLocalInspection)
      .catch(() => { /* offline or unavailable */ });
  }, [profile.id, workspaceId]);

  const inspection = inspectionProp ?? localInspection;
  const progress = run.progress && typeof run.progress === "object"
    ? run.progress as {
        percent?: number;
        current?: number;
        total?: number;
        elapsed_seconds?: number;
        eta_seconds?: number;
      }
    : null;

  const freeview = inspection?.viewers.find((v) => v.viewerId === "freeview");
  const mricrogl = inspection?.viewers.find((v) => v.viewerId === "mricrogl");

  // Capability resolver: maps artifact file types to viewer compatibility.
  // No pipeline names, no filename patterns in this component.
  const cap = resolveRunViewerCapabilities(run);
  const freeviewDefault         = selectDefaultViewerScene(cap.freeview);
  const freeviewCachedDefault   = selectDefaultViewerScene(cap.freeviewCached);
  const mricroglCachedDefault   = selectDefaultViewerScene(cap.mricroglCached);
  const nvCachedDefault         = selectDefaultViewerScene(cap.neuroforgeViewerCached);
  const assertDefaultScene = (request: Parameters<NonNullable<NeuroForgeDesktopBridge["assertDefaultViewerScene"]>>[0]) => {
    if (typeof desktop.assertDefaultViewerScene !== "function") {
      throw new Error("Desktop preload contract is stale: assertDefaultViewerScene is unavailable. Restart NeuroForge.");
    }
    return desktop.assertDefaultViewerScene(request);
  };

  // Determine the best available primary action.
  // Priority: NeuroForge Viewer > FreeView > MRIcroGL > Cloud Browser.
  // NeuroForge Viewer is the built-in viewer and requires no external install.
  const isFullyCached = run.cacheState === "fully-cached" || run.cacheState === "offline-cached";
  const freeviewCanOpen    = !!(freeview?.installed  && cap.freeview.length > 0        && (online || cap.freeviewCached.length > 0));
  const mricroglCanOpen    = !!(mricrogl?.installed  && cap.mricroglCached.length > 0);
  const neuroforgeViewerCanOpen = cap.neuroforgeViewerCached.length > 0;
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
    if ((freeview?.installed || mricrogl?.installed) && cap.freeview.length === 0 && cap.mricrogl.length === 0) {
      return [cacheLine, "No viewable artifacts for this pipeline.", "Primary action: Open in Cloud Browser."];
    }
    if (cap.freeviewCached.length === 0 && !online) {
      return [cacheLine, "Compatible artifacts not yet downloaded.", "Primary action: Open in Cloud Browser."];
    }
    return [cacheLine, "Primary action: Open in Cloud Browser."];
  })();

  async function openFreeView() {
    if (!freeview?.installed || cap.freeview.length === 0) return;
    if (!online && cap.freeviewCached.length === 0) return;
    setMessage(null);
    const artifact = online ? freeviewDefault : freeviewCachedDefault;
    if (!artifact) return;
    try {
      if (online && !run.cachedArtifacts.includes(artifact.relativePath)) {
        setDownloading([artifact.relativePath]);
        const result = await desktop.syncWorkspaceArtifacts({
          profileId: profile.id, workspaceId, runId: run.id,
          relativePaths: [artifact.relativePath],
        });
        setMessage(`${result.downloaded.length} downloaded · ${result.reused.length} reused`);
      }
      await assertDefaultScene({
        viewerId: "freeview", workspaceId, runId: run.id,
        files: [{ relativePath: artifact.relativePath, intendedRole: "base image" }],
      });
      await desktop.launchViewer({
        viewerId: "freeview", workspaceId, runId: run.id,
        launchMode: "default",
        files: [{ relativePath: artifact.relativePath, intendedRole: "base image" }],
      });
      setMessage(`Opened ${artifact.relativePath} in FreeView.`);
      onCacheChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloading([]);
    }
  }

  async function openMRIcroGL() {
    if (!mricrogl?.installed || !mricroglCachedDefault) return;
    setMessage(null);
    try {
      await assertDefaultScene({
        viewerId: "mricrogl", workspaceId, runId: run.id,
        files: [{ relativePath: mricroglCachedDefault.relativePath, intendedRole: "base image" }],
      });
      await desktop.launchViewer({
        viewerId: "mricrogl", workspaceId, runId: run.id,
        launchMode: "default",
        files: [{ relativePath: mricroglCachedDefault.relativePath, intendedRole: "base image" }],
      });
      setMessage(`Opened ${mricroglCachedDefault.relativePath} in MRIcroGL.`);
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

  // Single base image for the built-in viewer. selectDefaultViewerScene already
  // picked the highest-priority intensity volume from the cached set.
  const viewerLayers: CloudViewerLayer[] = nvCachedDefault ? [{
    relativePath: nvCachedDefault.relativePath,
    label: nvCachedDefault.relativePath.split("/").pop() ?? nvCachedDefault.relativePath,
    isOverlay: false,
  }] : [];

  // ── Per-artifact browser actions ─────────────────────────────────────────────

  async function browserDownloadArtifact(artifact: WorkspaceArtifact) {
    if (!online || browserDownloading.includes(artifact.relativePath)) return;
    setBrowserDownloading((prev) => [...prev, artifact.relativePath]);
    try {
      await desktop.syncWorkspaceArtifacts({
        profileId: profile.id, workspaceId, runId: run.id,
        relativePaths: [artifact.relativePath],
      });
      onCacheChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBrowserDownloading((prev) => prev.filter((p) => p !== artifact.relativePath));
    }
  }

  async function browserOpenInViewer(artifact: WorkspaceArtifact) {
    if (!run.cachedArtifacts.includes(artifact.relativePath)) {
      // Download first, then open.
      await browserDownloadArtifact(artifact);
      onCacheChanged?.();
    }
    try {
      await assertDefaultScene({
        viewerId: "neuroforge-viewer", workspaceId, runId: run.id,
        files: [{ relativePath: artifact.relativePath, intendedRole: "base image" }],
      });
      setBrowserViewerLayers([{
        relativePath: artifact.relativePath,
        label: artifact.relativePath.split("/").pop() ?? artifact.relativePath,
        isOverlay: false,
      }]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function browserOpenReport(relativePath: string) {
    if (!run.cachedArtifacts.includes(relativePath)) return;
    setTab("reports");
    await openCachedReport(relativePath);
  }

  // ── Download all ──────────────────────────────────────────────────────────────

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

  async function openCachedReport(relativePath: string) {
    if (!run.cachedArtifacts.includes(relativePath)) return;
    setReportError(null);
    try {
      const bytes = await desktop.readArtifact({ workspaceId, runId: run.id, relativePath });
      let html = new TextDecoder().decode(bytes);
      const references = [...html.matchAll(/(?:src|href)=["'](\.\.?\/[^"'?#]+\.(?:svg|png|jpe?g|gif|webp))["']/gi)]
        .map((match) => match[1]);
      for (const reference of new Set(references)) {
        const assetPath = resolveReportAssetPath(relativePath, reference);
        if (!assetPath || !run.cachedArtifacts.includes(assetPath)) continue;
        const asset = await desktop.readArtifact({ workspaceId, runId: run.id, relativePath: assetPath });
        const extension = assetPath.split(".").pop()?.toLowerCase();
        const mimeType = extension === "svg" ? "image/svg+xml"
          : extension === "png" ? "image/png"
          : extension === "gif" ? "image/gif"
          : extension === "webp" ? "image/webp"
          : "image/jpeg";
        html = html.split(reference).join(bytesToDataUrl(asset, mimeType));
      }
      setReportHtml(html);
    } catch (error) {
      setReportError(error instanceof Error ? error.message : String(error));
    }
  }

  const runReports = (run.reports ?? []).flatMap((report) => {
    if (!report || typeof report !== "object") return [];
    const path = "path" in report ? String(report.path) : "";
    const name = "name" in report ? String(report.name) : path;
    return path ? [{ path, name }] : [];
  });

  const tabs = ["overview", "artifacts", "logs", "provenance", "reports"] as const;
  const provenance = run.provenance && typeof run.provenance === "object"
    ? run.provenance as Record<string, unknown>
    : {};
  const results = run.results && typeof run.results === "object"
    ? run.results as Record<string, unknown>
    : {};
  const metadata = results.metadata && typeof results.metadata === "object"
    ? results.metadata as Record<string, unknown>
    : {};
  const sharedModel: SharedRunDetailModel = {
    id: run.id,
    pipelineId: run.pipeline_manifest_id,
    pipelineName: typeof metadata.pipeline_display_name === "string" ? metadata.pipeline_display_name : null,
    pipelineVersion: run.pipeline_version,
    executionLocation: "EC2",
    executionTarget: profile.name,
    status: run.status,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    command: typeof metadata.command_preview === "string" ? metadata.command_preview : null,
    containerImage: typeof metadata.container_image === "string" ? metadata.container_image : null,
    containerDigest: typeof provenance.container_digest === "string" ? provenance.container_digest : null,
    parameters: (run.parameters ?? metadata.params ?? {}) as Record<string, unknown>,
    dataset: {
      id: run.dataset_id,
      name: typeof metadata.dataset_name === "string" ? metadata.dataset_name : null,
      path: typeof metadata.dataset_path === "string" ? metadata.dataset_path : null,
    },
    outputDir: typeof metadata.output_dir === "string" ? metadata.output_dir : null,
    metadata,
    provenance: run.provenance,
    artifactCount: run.artifacts.length,
    reportCount: runReports.length,
  };

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm"
      role="dialog"
      aria-label={`Cloud Run #${run.id} — ${run.pipeline_manifest_id}`}
    >
      <div className="h-full w-full max-w-4xl overflow-y-auto border-l border-white/10 bg-surface p-6 shadow-2xl">
        <SharedRunDetail
          model={sharedModel}
          onDuplicate={() => navigate("/pipelines", { state: {
            selectPipeline: run.pipeline_manifest_id,
            paramsOverride: (run.parameters ?? {}) as Record<string, unknown>,
            datasetOverride: run.dataset_id ?? null,
          } })}
          headerAction={<button onClick={onClose} aria-label="Close run detail" className="rounded-md border border-white/10 px-3 py-2 text-xs text-gray-300 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Close</button>}
        >

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
              <section className="rounded-lg border border-white/8 bg-white/3 p-4">
                <h3 className="text-sm font-semibold text-white">Progress timeline</h3>
                <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                  <p className="text-emerald-300">Created · {new Date(run.created_at).toLocaleString()}</p>
                  <p className={run.started_at ? "text-emerald-300" : "text-gray-600"}>
                    {run.started_at ? `Started · ${new Date(run.started_at).toLocaleString()}` : "Waiting to start"}
                  </p>
                  <p className={run.finished_at ? "text-emerald-300" : "text-gray-600"}>
                    {run.finished_at ? `Finished · ${new Date(run.finished_at).toLocaleString()}` : "Not finished"}
                  </p>
                </div>
                {progress?.percent !== undefined && (
                  <div className="mt-3">
                    <div className="flex justify-between text-[11px] text-gray-400">
                      <span>{progress.percent}% complete</span>
                      <span>
                        {progress.current !== undefined && progress.total !== undefined
                          ? `${progress.current} / ${progress.total}`
                          : ""}
                        {progress.eta_seconds !== undefined ? ` · ETA ${Math.ceil(progress.eta_seconds / 60)} min` : ""}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/8">
                      <div
                        className="h-full rounded-full bg-accent transition-[width]"
                        style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
                      />
                    </div>
                  </div>
                )}
              </section>

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
                      {cap.freeviewCached.length > 0
                        ? "Ready from local cache"
                        : `Will download ${cap.freeview.length} artifact${cap.freeview.length !== 1 ? "s" : ""}`}
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
                    onClick={() => void (async () => {
                      if (!nvCachedDefault) return;
                      await assertDefaultScene({
                        viewerId: "neuroforge-viewer", workspaceId, runId: run.id,
                        files: [{ relativePath: nvCachedDefault.relativePath, intendedRole: "base image" }],
                      });
                      setShowViewer(true);
                    })().catch((error) => setMessage(error instanceof Error ? error.message : String(error)))}
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

                {/* Secondary local viewers — always shown so every viewer is reachable regardless of primary */}
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {/* NeuroForge Viewer */}
                  <button
                    disabled={!neuroforgeViewerCanOpen || primaryAction === "neuroforge-viewer"}
                    onClick={() => void (async () => {
                      if (!nvCachedDefault) return;
                      await assertDefaultScene({
                        viewerId: "neuroforge-viewer", workspaceId, runId: run.id,
                        files: [{ relativePath: nvCachedDefault.relativePath, intendedRole: "base image" }],
                      });
                      setShowViewer(true);
                    })().catch((error) => setMessage(error instanceof Error ? error.message : String(error)))}
                    className="rounded-lg border border-white/8 bg-white/4 p-3 text-left transition-colors hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <span className="text-xs font-medium text-gray-400">NeuroForge Viewer</span>
                    <span className="mt-0.5 block text-[10px] text-gray-600">
                      {neuroforgeViewerCanOpen
                        ? primaryAction === "neuroforge-viewer" ? "Primary (selected above)" : "Built-in NiiVue viewer"
                        : cap.neuroforgeViewer.length === 0
                        ? "No compatible artifacts"
                        : "Artifacts not cached locally"}
                    </span>
                  </button>

                  {/* FreeView */}
                  <button
                    disabled={!freeviewCanOpen || primaryAction === "freeview"}
                    onClick={() => void openFreeView()}
                    className="rounded-lg border border-white/8 bg-white/4 p-3 text-left transition-colors hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <span className="text-xs font-medium text-gray-400">FreeView</span>
                    <span className="mt-0.5 block text-[10px] text-gray-600">
                      {!freeview?.installed
                        ? (freeview?.reason ?? "Not installed")
                        : primaryAction === "freeview"
                        ? "Primary (selected above)"
                        : cap.freeview.length === 0
                        ? "No compatible artifacts"
                        : freeviewCanOpen
                        ? (cap.freeviewCached.length > 0 ? "Ready from local cache" : "Will download on open")
                        : "Compatible artifacts not cached — reconnect to download"}
                    </span>
                  </button>

                  {/* MRIcroGL — with "Locate…" when not installed */}
                  <div className="flex flex-col gap-1">
                    <button
                      disabled={!mricroglCanOpen || primaryAction === "mricrogl"}
                      onClick={() => void openMRIcroGL()}
                      className="rounded-lg border border-white/8 bg-white/4 p-3 text-left transition-colors hover:bg-white/6 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <span className="text-xs font-medium text-gray-400">MRIcroGL</span>
                      <span className="mt-0.5 block text-[10px] text-gray-600">
                        {mricrogl?.installed
                          ? primaryAction === "mricrogl" ? "Primary (selected above)"
                            : cap.mricrogl.length === 0 ? "No compatible artifacts"
                            : cap.mricroglCached.length === 0 ? "Artifacts not cached"
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
              <ArtifactBrowser
                run={run}
                online={online}
                onOpenViewer={browserOpenInViewer}
                onOpenReport={browserOpenReport}
                onDownload={browserDownloadArtifact}
                downloadingPaths={browserDownloading}
              />
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
            <div className="space-y-3">
              {runReports.length === 0 ? (
                <p className="text-sm text-gray-500">No reports attached to this run.</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {runReports.map((report) => {
                      const cached = run.cachedArtifacts.includes(report.path);
                      return (
                        <button
                          key={report.path}
                          disabled={!cached}
                          onClick={() => void openCachedReport(report.path)}
                          className="rounded-md border border-white/10 px-3 py-2 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-40"
                        >
                          Open {report.name}{cached ? "" : " (not cached)"}
                        </button>
                      );
                    })}
                    <button
                      onClick={() => void desktop.openWorkspaceRun({ profileId: profile.id, runId: run.id })}
                      className="rounded-md border border-accent/20 px-3 py-2 text-xs text-accent hover:bg-accent/5"
                    >
                      Open in Cloud Browser
                    </button>
                  </div>
                  {reportHtml && (
                    <iframe
                      title="Cached run report"
                      srcDoc={reportHtml}
                      sandbox="allow-scripts"
                      className="h-[65vh] w-full rounded-lg border border-white/10 bg-white"
                    />
                  )}
                  {reportError && <p className="text-xs text-red-400">{reportError}</p>}
                </>
              )}
            </div>
          )}
        </div>
        </SharedRunDetail>
      </div>
    </div>

    {/* NeuroForge Viewer overlay (default scene from overview tab) */}
    {showViewer && viewerLayers.length > 0 && (
      <CloudNiivueViewer
        workspaceId={workspaceId}
        runId={run.id}
        layers={viewerLayers}
        onClose={() => setShowViewer(false)}
      />
    )}

    {/* NeuroForge Viewer overlay (single artifact from browser tab) */}
    {browserViewerLayers && browserViewerLayers.length > 0 && (
      <CloudNiivueViewer
        workspaceId={workspaceId}
        runId={run.id}
        layers={browserViewerLayers}
        onClose={() => setBrowserViewerLayers(null)}
      />
    )}
    </>
  );
}
