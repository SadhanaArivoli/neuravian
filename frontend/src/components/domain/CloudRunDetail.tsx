import { useState } from "react";

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
  return "border-sky-400/20 bg-sky-400/10 text-sky-300";
}

function Badge({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "cloud" | "success" | "warning" | "danger" }) {
  const style = {
    slate: "border-white/10 bg-white/5 text-slate-300",
    cloud: "border-sky-400/20 bg-sky-400/10 text-sky-300",
    success: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
    warning: "border-amber-400/20 bg-amber-400/10 text-amber-300",
    danger: "border-red-400/20 bg-red-400/10 text-red-300",
  }[tone];
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${style}`}>{children}</span>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-slate-900/55 p-4">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-white">{value}</p>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </div>
  );
}

// ── artifact table ─────────────────────────────────────────────────────────────

function ArtifactTable({ run }: { run: WorkspaceRun }) {
  if (!run.artifacts.length) {
    return <p className="text-sm text-slate-500">No artifact manifest available.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-white/8">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="bg-slate-950/70 text-slate-500">
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
              <tr key={String(artifact.artifactId)} className="text-slate-300">
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
  inspection: WorkspaceInspection | null;
  onClose: () => void;
  onCacheChanged?: () => void;
}

export function CloudRunDetail({
  run, profile, workspaceId, online, inspection, onClose, onCacheChanged,
}: CloudRunDetailProps) {
  const desktop = window.neuroforgeDesktop!;
  const [tab, setTab] = useState<"overview" | "artifacts" | "logs" | "provenance" | "reports">("overview");
  const [downloading, setDownloading] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const anatomy = run.artifacts.find((a) => a.relativePath.endsWith("/mri/orig_nu.mgz"));
  const segmentation = run.artifacts.find((a) => a.relativePath.endsWith("/mri/aseg.auto.mgz"));
  const freeview = inspection?.viewers.find((v) => v.viewerId === "freeview");
  const mricrogl = inspection?.viewers.find((v) => v.viewerId === "mricrogl");
  const fastsurferRequired = anatomy && segmentation
    ? [anatomy.relativePath, segmentation.relativePath]
    : [];
  const fastsurferCached = fastsurferRequired.length > 0
    && fastsurferRequired.every((p) => run.cachedArtifacts.includes(p));

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

  const tabs = ["overview", "artifacts", "logs", "provenance", "reports"] as const;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm"
      role="dialog"
      aria-label={`Cloud Run #${run.id} — ${run.pipeline_manifest_id}`}
    >
      <div className="h-full w-full max-w-4xl overflow-y-auto border-l border-white/10 bg-[#0a0f1a] p-6 shadow-2xl">
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
            <p className="mt-1 text-sm text-slate-400">{run.pipeline_manifest_id} · {run.status}</p>
            <p className="mt-0.5 text-xs text-slate-500">{profile.name} · {profile.serverUrl}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close run detail"
            className="rounded-md border border-white/10 px-3 py-1 text-sm text-slate-300 hover:text-white transition-colors"
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
                  ? "border-b-2 border-cyan-400 text-cyan-300"
                  : "text-slate-500 hover:text-slate-300"
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
              {/* Viewer actions */}
              <section>
                <h3 className="text-sm font-semibold text-white mb-3">Viewer actions</h3>
                <div className="grid gap-3 md:grid-cols-3">
                  <button
                    onClick={() => void desktop.openWorkspaceRun({ profileId: profile.id, runId: run.id })}
                    className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 p-3 text-left text-sm text-cyan-200 hover:bg-cyan-400/15 transition-colors"
                  >
                    Open in Cloud Browser
                    <span className="mt-1 block text-[10px] text-slate-500">
                      Opens run detail in authenticated browser tab
                    </span>
                  </button>

                  <button
                    disabled={!freeview?.installed || fastsurferRequired.length !== 2 || (!online && !fastsurferCached)}
                    onClick={() => void openFreeView()}
                    className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 p-3 text-left text-sm text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-cyan-400/15 transition-colors"
                  >
                    Open in FreeView
                    <span className="mt-1 block text-[10px] text-slate-500">
                      {!freeview?.installed
                        ? (freeview?.reason ?? "Not installed")
                        : fastsurferRequired.length !== 2
                        ? "No FastSurfer artifacts (orig_nu + aseg)"
                        : fastsurferCached
                        ? "Ready from local cache"
                        : "Will download 2 required artifacts"}
                    </span>
                  </button>

                  <button
                    disabled
                    className="rounded-lg border border-white/8 bg-white/5 p-3 text-left text-sm text-slate-400 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Open in MRIcroGL
                    <span className="mt-1 block text-[10px] text-slate-500">
                      {mricrogl?.installed
                        ? "No compatible preset for this pipeline"
                        : (mricrogl?.reason ?? "Not installed")}
                    </span>
                  </button>
                </div>

                {downloading.length > 0 && (
                  <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
                    <p className="text-xs font-semibold text-amber-300">Downloading artifacts</p>
                    {downloading.map((file) => (
                      <div key={file} className="mt-2 flex items-center gap-2 text-xs text-slate-300">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />
                        {file.split("/").pop()}
                      </div>
                    ))}
                  </div>
                )}
                {message && <p role="status" className="mt-3 text-xs text-slate-400">{message}</p>}
              </section>

              {/* Parameters */}
              <section>
                <h3 className="text-sm font-semibold text-white mb-2">Pipeline parameters</h3>
                <pre className="max-h-52 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] text-slate-400">
                  {JSON.stringify(run.parameters ?? {}, null, 2)}
                </pre>
              </section>
            </div>
          )}

          {tab === "artifacts" && <ArtifactTable run={run} />}

          {tab === "logs" && (
            <pre className="max-h-[65vh] overflow-auto rounded-lg bg-slate-950/70 p-4 text-[11px] text-slate-400 whitespace-pre-wrap">
              {typeof run.logs === "object" && run.logs !== null && "log_text" in run.logs
                ? String((run.logs as { log_text: string }).log_text)
                : JSON.stringify(run.logs ?? { message: "No logs cached" }, null, 2)}
            </pre>
          )}

          {tab === "provenance" && (
            <pre className="max-h-[65vh] overflow-auto rounded-lg bg-slate-950/70 p-4 text-[11px] text-slate-400">
              {JSON.stringify(run.provenance ?? { message: "No provenance cached" }, null, 2)}
            </pre>
          )}

          {tab === "reports" && (
            <div>
              {!run.reports || run.reports.length === 0 ? (
                <p className="text-sm text-slate-500">No reports attached to this run.</p>
              ) : (
                <pre className="max-h-[65vh] overflow-auto rounded-lg bg-slate-950/70 p-4 text-[11px] text-slate-400">
                  {JSON.stringify(run.reports, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
