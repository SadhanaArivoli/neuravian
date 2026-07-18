import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useWorkspace } from "../context/WorkspaceContext";

const REFRESH_MS = 15_000;
type WorkspaceView = "home" | "projects" | "datasets" | "workflows" | "runs" | "reports" | "settings" | "diagnostics";
type SyncState = "idle" | "syncing" | "done" | "failed";

const VIEWS: WorkspaceView[] = ["home", "projects", "datasets", "workflows", "runs", "reports", "settings", "diagnostics"];

function stringValue(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function relativeTime(value: string | null): string {
  if (!value) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 10) return "a few seconds ago";
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  return new Date(value).toLocaleString();
}

function cacheLabel(state: WorkspaceCacheState): string {
  return {
    "cloud-only": "Cloud Only",
    downloading: "Downloading",
    "partially-cached": "Partially Cached",
    "fully-cached": "Fully Cached",
    "offline-cached": "Offline Cached",
    "local-only": "Local Only",
    "server-unavailable": "Synchronization Failed",
  }[state];
}

function cacheClass(state: WorkspaceCacheState): string {
  if (state === "fully-cached" || state === "offline-cached") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
  if (state === "downloading" || state === "partially-cached") return "border-amber-400/25 bg-amber-400/10 text-amber-300";
  if (state === "server-unavailable") return "border-red-400/25 bg-red-400/10 text-red-300";
  return "border-sky-400/20 bg-sky-400/10 text-sky-300";
}

function workflowNodes(workflow: Record<string, unknown>): Array<{ id: string; pipelineId: string }> {
  const state = workflow.state;
  if (!state || typeof state !== "object") return [];
  const nodes = (state as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node, index) => {
    if (!node || typeof node !== "object") return [];
    const value = node as { id?: unknown; pipelineId?: unknown };
    return typeof value.pipelineId === "string"
      ? [{ id: typeof value.id === "string" ? value.id : `${value.pipelineId}-${index}`, pipelineId: value.pipelineId }]
      : [];
  });
}

function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: "slate" | "cloud" | "success" | "warning" | "danger" }) {
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
  return <div className="rounded-xl border border-white/8 bg-slate-900/55 p-4">
    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</p>
    <p className="mt-2 text-2xl font-bold text-white">{value}</p>
    {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
  </div>;
}

function SynchronizationProgress({ state }: { state: SyncState }) {
  if (state === "idle") return null;
  const done = state === "done";
  return <div data-testid="synchronization-progress" className={`mt-4 rounded-xl border p-4 ${
    state === "failed" ? "border-red-400/20 bg-red-400/5" : "border-cyan-400/20 bg-cyan-400/5"
  }`}>
    <div className="flex items-center justify-between">
      <p className="text-sm font-semibold text-white">
        {state === "syncing" ? "Synchronizing metadata…" : state === "done" ? "Synchronization complete" : "Synchronization failed"}
      </p>
      {state === "syncing" && <span className="h-3 w-3 animate-spin rounded-full border-2 border-cyan-300 border-t-transparent" />}
    </div>
    <div className="mt-3 grid grid-cols-4 gap-2">
      {["Projects", "Datasets", "Runs", "Reports"].map((label) =>
        <div key={label} className="rounded-md bg-slate-950/50 px-2 py-1.5 text-center text-[10px] text-slate-400">
          <span className={done ? "text-emerald-300" : state === "syncing" ? "text-cyan-300" : "text-red-300"}>
            {done ? "✓ " : state === "syncing" ? "• " : "× "}
          </span>{label}
        </div>)}
    </div>
  </div>;
}

function ViewerStatus({ inspection }: { inspection: WorkspaceInspection | null }) {
  return <div className="grid gap-2 sm:grid-cols-2">
    {(["freeview", "mricrogl"] as const).map((viewerId) => {
      const viewer = inspection?.viewers.find((item) => item.viewerId === viewerId);
      const name = viewerId === "freeview" ? "FreeView" : "MRIcroGL";
      return <div key={viewerId} className="rounded-lg border border-white/8 bg-slate-950/45 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white">{name}</span>
          <Badge tone={viewer?.installed ? "success" : "warning"}>{viewer?.installed ? "Installed" : "Not Installed"}</Badge>
        </div>
        <p className="mt-1 truncate text-[10px] text-slate-500">{viewer?.executable ?? viewer?.reason ?? "Detection pending"}</p>
      </div>;
    })}
  </div>;
}

export interface LocalWorkspaceData {
  projects: Array<Record<string, unknown> & { id: number }>;
  datasets: Array<Record<string, unknown> & { id: number }>;
  workflows: Array<Record<string, unknown> & { id: number }>;
  runs: Array<Record<string, unknown> & { id: number }>;
  reports: Array<Record<string, unknown> & { id: number; dataset_id: number }>;
}

export interface CombinedWorkspaceRun {
  key: string;
  id: number;
  pipeline: string;
  status: string;
  workspace: "Local NeuroForge" | "AWS NeuroForge";
  local: boolean;
}

export function combineWorkspaceRuns(
  data: LocalWorkspaceData,
  localWorkspaceId: string,
  cloud: WorkspaceSnapshot,
): CombinedWorkspaceRun[] {
  return [
    ...data.runs.map((run) => ({
      key: `${localWorkspaceId}:run:${run.id}`,
      id: run.id,
      pipeline: stringValue(run.pipeline_manifest_id),
      status: stringValue(run.status),
      workspace: "Local NeuroForge" as const,
      local: true,
    })),
    ...cloud.runs.map((run) => ({
      key: run.remoteKey,
      id: run.id,
      pipeline: run.pipeline_manifest_id,
      status: run.status,
      workspace: "AWS NeuroForge" as const,
      local: false,
    })),
  ];
}

async function localJson<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`);
  if (!response.ok) throw new Error(`Local NeuroForge API returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

async function loadLocalWorkspace(): Promise<LocalWorkspaceData> {
  const [projects, datasets, workflows, runs] = await Promise.all([
    localJson<LocalWorkspaceData["projects"]>("/projects"),
    localJson<LocalWorkspaceData["datasets"]>("/datasets"),
    localJson<LocalWorkspaceData["workflows"]>("/workflows"),
    localJson<LocalWorkspaceData["runs"]>("/runs"),
  ]);
  const reportGroups = await Promise.all(datasets.map((dataset) =>
    localJson<LocalWorkspaceData["reports"]>(`/datasets/${dataset.id}/reports`).catch(() => [])));
  return { projects, datasets, workflows, runs, reports: reportGroups.flat() };
}

function LocalWorkspaceView({
  view, data, workspaceId, cloud,
}: {
  view: WorkspaceView; data: LocalWorkspaceData; workspaceId: string;
  cloud?: WorkspaceSnapshot | null;
}) {
  if (cloud && view === "runs") {
    const combined = combineWorkspaceRuns(data, workspaceId, cloud);
    return <section className="mt-6"><h2 className="text-lg font-semibold text-white">All Workspaces · Runs</h2>
      <p className="mt-1 text-xs text-slate-500">Metadata is combined only in this view. Local and cloud IDs remain separate.</p>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">{combined.map((run) =>
        <Link key={run.key} to={run.local ? `/runs/${run.id}` : `/workspaces?scope=cloud&view=runs`}
          className="rounded-xl border border-white/8 bg-slate-900/55 p-4">
          <div className="flex justify-between"><span className="font-mono text-sm text-cyan-300">Run #{run.id}</span>
            <Badge tone={run.local ? "success" : "cloud"}>{run.workspace}</Badge></div>
          <p className="mt-2 text-sm capitalize text-white">{run.pipeline}</p><p className="mt-1 text-xs text-slate-500">{run.status}</p>
          <p className="mt-3 font-mono text-[9px] text-slate-600">{run.key}</p>
        </Link>)}</div></section>;
  }
  if (view === "home") return <div className="mt-6 space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Metric label="Projects" value={data.projects.length} /><Metric label="Datasets" value={data.datasets.length} />
      <Metric label="Workflows" value={data.workflows.length} /><Metric label="Runs" value={data.runs.length} />
      <Metric label="Reports" value={data.reports.length} />
    </div>
    <section className="rounded-xl border border-emerald-400/15 bg-emerald-400/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold text-white">Local NeuroForge</h2>
        <p className="mt-1 text-sm text-emerald-300">Local · Available offline · Existing database</p></div><Badge tone="success">109 historical runs preserved</Badge></div>
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-slate-500">Workspace identity</dt><dd className="mt-1 break-all font-mono text-slate-300">{workspaceId}</dd></div>
        <div><dt className="text-slate-500">Storage</dt><dd className="mt-1 text-slate-300">Existing local API and scientific database</dd></div></dl>
    </section>
  </div>;
  if (view === "projects") return <section className="mt-6"><h2 className="text-lg font-semibold text-white">Local Projects</h2>
    <div className="mt-4 grid gap-3">{data.projects.map((item) => <Link key={`${workspaceId}:project:${item.id}`} to={`/projects/${item.id}`} className="rounded-lg border border-white/8 bg-slate-900/55 p-4">
      <div className="flex justify-between"><span className="text-white">{stringValue(item.title ?? item.name, `Project ${item.id}`)}</span><Badge tone="success">Local NeuroForge</Badge></div></Link>)}</div></section>;
  if (view === "datasets") return <section className="mt-6"><h2 className="text-lg font-semibold text-white">Local Datasets</h2>
    <div className="mt-4 grid gap-3 md:grid-cols-2">{data.datasets.map((item) => <Link key={`${workspaceId}:dataset:${item.id}`} to={`/datasets/${item.id}`} className="rounded-lg border border-white/8 bg-slate-900/55 p-4">
      <div className="flex justify-between"><span className="text-white">{stringValue(item.name, `Dataset ${item.id}`)}</span><Badge tone="success">Local</Badge></div></Link>)}</div></section>;
  if (view === "workflows") return <section className="mt-6"><h2 className="text-lg font-semibold text-white">Local Saved Workflows</h2>
    <p className="mt-2 text-sm text-slate-400">{data.workflows.length} saved workflows remain in the local database.</p>
    <Link to="/workflows/library" className="mt-4 inline-flex rounded border border-white/10 px-3 py-2 text-xs text-cyan-300">Open workflow library</Link></section>;
  if (view === "runs") return <section className="mt-6"><div className="flex justify-between"><h2 className="text-lg font-semibold text-white">Local Runs</h2><Badge tone="success">Local NeuroForge · {data.runs.length}</Badge></div>
    <div className="mt-4 grid gap-3 lg:grid-cols-2">{data.runs.map((run) => <Link key={`${workspaceId}:run:${run.id}`} to={`/runs/${run.id}`} className="rounded-xl border border-white/8 bg-slate-900/55 p-4">
      <div className="flex justify-between"><span className="font-mono text-cyan-300">Run #{run.id}</span><Badge tone="success">Local NeuroForge</Badge></div>
      <p className="mt-2 text-sm capitalize text-white">{stringValue(run.pipeline_manifest_id)}</p><p className="mt-1 text-xs text-slate-500">{stringValue(run.status)}</p>
    </Link>)}</div></section>;
  if (view === "reports") return <section className="mt-6"><h2 className="text-lg font-semibold text-white">Local Reports</h2>
    <p className="mt-2 text-sm text-slate-400">{data.reports.length} report records remain attached to local datasets.</p>
    <div className="mt-4 grid gap-3">{data.reports.map((report) => <Link key={`${workspaceId}:report:${report.id}`} to={`/datasets/${report.dataset_id}/reports/${report.id}`} className="rounded-lg border border-white/8 bg-slate-900/55 p-4 text-sm text-white">Report #{report.id} · Dataset #{report.dataset_id}</Link>)}</div></section>;
  return <section className="mt-6 rounded-xl border border-white/8 bg-slate-900/55 p-5"><h2 className="text-lg text-white">Local workspace settings</h2>
    <p className="mt-2 text-sm text-slate-400">Local records stay in the existing NeuroForge database and are never uploaded automatically.</p><Link to="/settings" className="mt-4 inline-flex text-sm text-cyan-300">Open local settings</Link></section>;
}

function ArtifactTable({ run }: { run: WorkspaceRun }) {
  if (!run.artifacts.length) return <p className="text-sm text-slate-500">No artifact manifest is available for this run.</p>;
  return <div className="overflow-x-auto rounded-lg border border-white/8">
    <table className="w-full min-w-[720px] text-left text-xs">
      <thead className="bg-slate-950/70 text-slate-500"><tr>
        <th className="px-3 py-2">Artifact</th><th className="px-3 py-2">Location</th>
        <th className="px-3 py-2">Size</th><th className="px-3 py-2">Checksum</th><th className="px-3 py-2">Geometry</th>
      </tr></thead>
      <tbody className="divide-y divide-white/5">
        {run.artifacts.map((artifact) => {
          const cached = run.cachedArtifacts.includes(artifact.relativePath);
          return <tr key={String(artifact.artifactId)} className="text-slate-300">
            <td className="px-3 py-2 font-mono text-[11px]">{artifact.relativePath}</td>
            <td className="px-3 py-2"><Badge tone={cached ? "success" : "cloud"}>{cached ? "Cached" : "Cloud"}</Badge></td>
            <td className="px-3 py-2">{formatBytes(artifact.sizeBytes)}</td>
            <td className="px-3 py-2 font-mono text-[10px]" title={artifact.sha256}>{artifact.sha256.slice(0, 12)}…</td>
            <td className="px-3 py-2">{artifact.geometry
              ? `${artifact.geometry.shape.join("×")} · ${artifact.geometry.orientation.join("")}`
              : "Not a volume"}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

function DatasetDetails({
  dataset, runs, workflows, profile, onClose,
}: {
  dataset: Record<string, unknown> & { id: number; remoteKey: string };
  runs: WorkspaceRun[];
  workflows: Array<Record<string, unknown> & { id: number; remoteKey: string }>;
  profile: WorkspaceProfile;
  onClose: () => void;
}) {
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm" role="dialog" aria-label={`Dataset ${dataset.id} details`}>
    <div className="h-full w-full max-w-2xl overflow-y-auto border-l border-white/10 bg-[#0a0f1a] p-6 shadow-2xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold text-white">{stringValue(dataset.name, `Dataset ${dataset.id}`)}</h2>
            <Badge tone="cloud">Cloud</Badge>
          </div>
          <p className="mt-1 text-sm text-slate-400">{profile.name} · Dataset #{dataset.id}</p>
        </div>
        <button onClick={onClose} aria-label="Close dataset details" className="rounded-md border border-white/10 px-3 py-1 text-sm text-slate-300">Close</button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Metric label="Runs" value={runs.length} />
        <Metric label="Workflows" value={workflows.length} />
        <Metric label="Validation" value={stringValue(dataset.validation_status, "Unknown")} />
      </div>

      {runs.length > 0 && <section className="mt-6">
        <h3 className="text-sm font-semibold text-white mb-3">Runs on this dataset</h3>
        <div className="space-y-2">
          {runs.map((run) => <div key={run.remoteKey} className="rounded-lg border border-white/8 bg-slate-900/55 px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-mono text-xs text-cyan-300">Run #{run.id}</span>
                <span className="ml-2 text-sm text-slate-200">{run.pipeline_manifest_id}</span>
              </div>
              <Badge tone={run.status === "success" ? "success" : run.status === "failed" ? "danger" : "warning"}>
                {run.status}
              </Badge>
            </div>
            <p className="mt-1 text-[10px] text-slate-500">{run.artifacts.length} artifacts · {run.cachedArtifacts.length} cached · {cacheLabel(run.cacheState)}</p>
          </div>)}
        </div>
      </section>}

      {typeof dataset.description === "string" && dataset.description && <section className="mt-6">
        <h3 className="text-sm font-semibold text-white mb-2">Description</h3>
        <p className="text-sm text-slate-400">{dataset.description}</p>
      </section>}

      <dl className="mt-6 grid gap-3 text-xs sm:grid-cols-2">
        {Object.entries(dataset)
          .filter(([key]) => !["id", "remoteKey", "name", "description", "validation_status"].includes(key))
          .map(([key, value]) => <div key={key}>
            <dt className="text-slate-500 uppercase tracking-wide text-[10px]">{key.replace(/_/g, " ")}</dt>
            <dd className="mt-1 text-slate-300 break-all">{typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")}</dd>
          </div>)}
      </dl>
    </div>
  </div>;
}

function RunDetails({
  profile, workspaceId, run, online, inspection, onClose, onCacheChanged,
}: {
  profile: WorkspaceProfile; workspaceId: string; run: WorkspaceRun; online: boolean;
  inspection: WorkspaceInspection | null; onClose: () => void; onCacheChanged: () => void;
}) {
  const desktop = window.neuroforgeDesktop!;
  const [tab, setTab] = useState<"overview" | "artifacts" | "logs" | "reports">("overview");
  const [downloading, setDownloading] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const anatomy = run.artifacts.find((artifact) => artifact.relativePath.endsWith("/mri/orig_nu.mgz"));
  const segmentation = run.artifacts.find((artifact) => artifact.relativePath.endsWith("/mri/aseg.auto.mgz"));
  const freeview = inspection?.viewers.find((item) => item.viewerId === "freeview");
  const mricrogl = inspection?.viewers.find((item) => item.viewerId === "mricrogl");
  const required = anatomy && segmentation ? [anatomy.relativePath, segmentation.relativePath] : [];
  const cached = required.length > 0 && required.every((item) => run.cachedArtifacts.includes(item));

  async function openFreeView() {
    if (!freeview?.installed || required.length !== 2 || (!online && !cached)) return;
    setMessage(null);
    try {
      if (online) {
        setDownloading(required);
        const result = await desktop.syncWorkspaceArtifacts({
          profileId: profile.id, workspaceId, runId: run.id, relativePaths: required,
        });
        setMessage(`${result.downloaded.length} downloaded · ${result.reused.length} reused`);
      }
      await desktop.launchViewer({
        viewerId: "freeview", workspaceId, runId: run.id,
        files: [{ relativePath: required[0] }, { relativePath: required[1], overlay: true }],
        opacity: 0.7, freesurferLut: true,
      });
      onCacheChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDownloading([]);
    }
  }

  return <div className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm" role="dialog" aria-label={`Run #${run.id} details`}>
    <div className="h-full w-full max-w-4xl overflow-y-auto border-l border-white/10 bg-[#0a0f1a] p-6 shadow-2xl">
      <div className="flex items-start justify-between gap-4">
        <div><div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-bold text-white">Run #{run.id}</h2><Badge tone="cloud">Cloud</Badge>
          <Badge tone="success">Metadata Cached</Badge>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${cacheClass(run.cacheState)}`}>{cacheLabel(run.cacheState)}</span>
        </div>
        <p className="mt-1 text-sm text-slate-400">{run.pipeline_manifest_id} · {run.status}</p></div>
        <button onClick={onClose} aria-label="Close run details" className="rounded-md border border-white/10 px-3 py-1 text-sm text-slate-300">Close</button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-4">
        <Metric label="Artifacts" value={run.artifacts.length} detail={`${run.cachedArtifacts.length} cached`} />
        <Metric label="Reports" value={run.reports?.length ?? 0} />
        <Metric label="Created" value={new Date(run.created_at).toLocaleDateString()} />
        <Metric label="Completed" value={run.finished_at ? new Date(run.finished_at).toLocaleDateString() : "—"} />
      </div>

      <div className="mt-5 flex gap-1 border-b border-white/8">
        {(["overview", "artifacts", "logs", "reports"] as const).map((value) =>
          <button key={value} onClick={() => setTab(value)}
            className={`px-3 py-2 text-xs capitalize ${tab === value ? "border-b-2 border-cyan-400 text-cyan-300" : "text-slate-500"}`}>{value}</button>)}
      </div>

      <div className="mt-5">
        {tab === "overview" && <div className="space-y-5">
          <section><h3 className="text-sm font-semibold text-white">Pipeline parameters</h3>
            <pre className="mt-2 max-h-52 overflow-auto rounded-lg bg-slate-950/70 p-3 text-[11px] text-slate-400">{JSON.stringify(run.parameters ?? {}, null, 2)}</pre></section>
          <section><h3 className="text-sm font-semibold text-white">Viewer actions</h3>
            <div className="mt-2 grid gap-3 md:grid-cols-3">
              <button onClick={() => void desktop.openWorkspaceRun({ profileId: profile.id, runId: run.id })}
                className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 p-3 text-left text-sm text-cyan-200">
                Open in NeuroForge Viewer<span className="mt-1 block text-[10px] text-slate-500">Opens the authenticated cloud run</span>
              </button>
              <button disabled={!freeview?.installed || required.length !== 2 || (!online && !cached)}
                onClick={() => void openFreeView()}
                className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 p-3 text-left text-sm text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40">
                Open in FreeView<span className="mt-1 block text-[10px] text-slate-500">
                  {!freeview?.installed ? freeview?.reason ?? "Not installed" : required.length !== 2 ? "No compatible artifacts" : cached ? "Ready from cache" : "Downloads 2 required artifacts"}
                </span>
              </button>
              <button disabled={true}
                className="rounded-lg border border-white/8 bg-white/5 p-3 text-left text-sm text-slate-400 disabled:cursor-not-allowed disabled:opacity-40">
                Open in MRIcroGL<span className="mt-1 block text-[10px] text-slate-500">
                  {mricrogl?.installed ? "No compatible preset for this pipeline" : mricrogl?.reason ?? "Not installed"}
                </span>
              </button>
            </div>
            {downloading.length > 0 && <div data-testid="artifact-download-progress" className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
              <p className="text-xs font-semibold text-amber-300">Downloading</p>
              {downloading.map((file) => <div key={file} className="mt-2 flex items-center gap-2 text-xs text-slate-300">
                <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />{file.split("/").pop()}
              </div>)}
            </div>}
            {message && <p role="status" className="mt-3 text-xs text-slate-400">{message}</p>}
          </section>
        </div>}
        {tab === "artifacts" && <ArtifactTable run={run} />}
        {tab === "logs" && <pre className="max-h-[60vh] overflow-auto rounded-lg bg-slate-950/70 p-4 text-[11px] text-slate-400">{JSON.stringify(run.logs ?? { message: "No logs cached" }, null, 2)}</pre>}
        {tab === "reports" && <pre className="max-h-[60vh] overflow-auto rounded-lg bg-slate-950/70 p-4 text-[11px] text-slate-400">{JSON.stringify(run.reports ?? [], null, 2)}</pre>}
      </div>
    </div>
  </div>;
}

export default function Workspaces() {
  const desktop = window.neuroforgeDesktop;
  const workspace = useWorkspace();
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view") as WorkspaceView | null;
  const view: WorkspaceView = requestedView && VIEWS.includes(requestedView) ? requestedView : "home";
  const [profiles, setProfiles] = useState<WorkspaceProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null);
  const [online, setOnline] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkspaceRun | null>(null);
  const [selectedDataset, setSelectedDataset] = useState<(Record<string, unknown> & { id: number; remoteKey: string }) | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connectionResult, setConnectionResult] = useState<string | null>(null);
  const [localData, setLocalData] = useState<LocalWorkspaceData | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const scope = params.get("scope") ?? workspace.selected;
  const showsLocal = scope === "local" || scope === "all";
  const cloudOnly = scope !== "local" && scope !== "all";
  const showsCloud = cloudOnly || scope === "all";

  const refreshProfiles = useCallback(async () => {
    if (!desktop) return;
    const values = await desktop.listWorkspaces();
    setProfiles(values);
    setActiveId((current) => current ?? values[0]?.id ?? null);
  }, [desktop]);

  const refreshInspection = useCallback(async (profileId: string, workspaceId: string) => {
    if (!desktop) return;
    setInspection(await desktop.inspectWorkspace({ profileId, workspaceId }));
  }, [desktop]);

  const synchronize = useCallback(async (profileId: string, quiet = false) => {
    if (!desktop) return;
    if (!quiet) setSyncState("syncing");
    setError(null);
    try {
      const result = await desktop.syncWorkspace(profileId);
      setSnapshot(result.snapshot);
      setOnline(result.online);
      await Promise.all([refreshProfiles(), refreshInspection(profileId, result.snapshot.workspaceId)]);
      if (!quiet) {
        setSyncState("done");
        window.setTimeout(() => setSyncState("idle"), 2500);
      }
    } catch (cause) {
      setOnline(false);
      setSyncState("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [desktop, refreshInspection, refreshProfiles]);

  useEffect(() => { void refreshProfiles(); }, [refreshProfiles]);
  useEffect(() => {
    void loadLocalWorkspace().then(setLocalData).catch((cause) => setLocalError(
      cause instanceof Error ? cause.message : String(cause),
    ));
  }, []);
  useEffect(() => {
    if (!scope.startsWith("cloud:")) return;
    const profileId = scope.slice(6);
    if (profiles.some((profile) => profile.id === profileId)) setActiveId(profileId);
  }, [profiles, scope]);
  useEffect(() => {
    if (!activeId) return;
    void synchronize(activeId);
    const timer = window.setInterval(() => void synchronize(activeId, true), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [activeId, synchronize]);

  const activeProfile = profiles.find((profile) => profile.id === activeId) ?? null;
  const runsByDataset = useMemo(() => new Map((snapshot?.datasets ?? []).map(
    (dataset) => [dataset.id, snapshot?.runs.filter((run) => run.dataset_id === dataset.id) ?? []],
  )), [snapshot]);
  const cachedRuns = snapshot?.runs.filter((run) => run.cachedArtifacts.length > 0).length ?? 0;
  const cloudOnlyRuns = snapshot?.runs.filter((run) => run.cachedArtifacts.length === 0).length ?? 0;

  async function addWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!desktop) return;
    try {
      const profile = await desktop.saveWorkspace({ name, serverUrl, username, password });
      setName(""); setServerUrl(""); setUsername(""); setPassword(""); setShowForm(false);
      await refreshProfiles(); setActiveId(profile.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function disconnectWorkspace() {
    setOnline(false);
    setSyncState("idle");
    setSnapshot((current) => current ? {
      ...current,
      runs: current.runs.map((run) => ({
        ...run,
        cacheState: run.cachedArtifacts.length > 0 ? "offline-cached" : "server-unavailable",
      })),
    } : current);
  }

  if (!desktop) return <div className="p-8"><h1 className="text-xl font-semibold">Workspace</h1>
    <p className="mt-2 text-sm text-slate-400">Unified cloud workspaces are available in NeuroForge Desktop.</p></div>;

  const headerName = showsLocal && !showsCloud ? "Local NeuroForge"
    : scope === "all" ? "All Workspaces" : activeProfile?.name ?? "Connect a NeuroForge workspace";
  const header = <><div className="flex flex-wrap items-start justify-between gap-4">
    <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">Workspace</p>
      <h1 className="mt-1 text-2xl font-bold text-white">{headerName}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {showsLocal && <Badge tone="success">Local · Available offline</Badge>}
        {showsCloud && <Badge tone={online ? "success" : "warning"}>{online ? "Connected" : snapshot ? "Offline" : "Not Connected"}</Badge>}
        {showsCloud && activeProfile && <span className="text-xs text-slate-500">{activeProfile.serverUrl}</span>}
      </div></div>
    <div className="flex gap-2">
      {showsCloud && activeId && <button onClick={() => void synchronize(activeId)} disabled={syncState === "syncing"}
        className="rounded-md border border-white/10 px-3 py-2 text-xs text-slate-300 disabled:opacity-40">Refresh metadata</button>}
      <button onClick={() => { setShowForm(true); setParams({ view: "settings" }); }}
        className="rounded-md bg-cyan-400 px-3 py-2 text-xs font-semibold text-slate-950">Add Workspace</button>
    </div>
  </div>{showsCloud && <SynchronizationProgress state={syncState} />}</>;

  return <div className="mx-auto max-w-7xl p-6 lg:p-8">{header}
    {showsCloud && !profiles.length && !showForm && <div className="mt-8 rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-slate-500">
      Add an HTTPS NeuroForge deployment to see its projects, datasets, workflows, and runs.
    </div>}

    {showsLocal && localData && workspace.local && <LocalWorkspaceView view={view} data={localData}
      workspaceId={workspace.local.id} cloud={scope === "all" ? snapshot : null} />}
    {showsLocal && localError && <p role="alert" className="mt-4 rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-sm text-red-300">{localError}</p>}

    {cloudOnly && snapshot && view === "home" && <div className="mt-6 space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Metric label="Projects" value={snapshot.projects.length} />
        <Metric label="Datasets" value={snapshot.datasets.length} />
        <Metric label="Workflows" value={snapshot.workflows.length} />
        <Metric label="Runs" value={snapshot.runs.length} />
        <Metric label="Cached" value={cachedRuns} />
        <Metric label="Cloud Only" value={cloudOnlyRuns} />
      </div>
      <section className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-xl border border-white/8 bg-slate-900/50 p-5">
          <h2 className="text-sm font-semibold text-white">Workspace Home</h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <div><dt className="text-[10px] uppercase tracking-wider text-slate-500">Last synchronization</dt><dd className="mt-1 text-sm text-slate-200">{relativeTime(activeProfile?.lastSync ?? snapshot.synchronizedAt)}</dd></div>
            <div><dt className="text-[10px] uppercase tracking-wider text-slate-500">Cloud health</dt><dd className="mt-1 text-sm text-emerald-300">{online ? "Healthy and reachable" : "Using cached metadata"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-[10px] uppercase tracking-wider text-slate-500">Workspace UUID</dt><dd className="mt-1 break-all font-mono text-xs text-slate-300">{snapshot.workspaceId}</dd></div>
          </dl>
        </div>
        <div className="rounded-xl border border-white/8 bg-slate-900/50 p-5">
          <h2 className="text-sm font-semibold text-white">Workspace Inspector</h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div><dt className="text-slate-500">Cache size</dt><dd className="mt-1 text-white">{formatBytes(inspection?.cacheSizeBytes ?? 0)}</dd></div>
            <div><dt className="text-slate-500">Cached runs</dt><dd className="mt-1 text-white">{inspection?.cachedRuns ?? 0}</dd></div>
            <div><dt className="text-slate-500">Remote runs</dt><dd className="mt-1 text-white">{snapshot.runs.length}</dd></div>
            <div><dt className="text-slate-500">Cache entries</dt><dd className="mt-1 text-white">{inspection?.cacheEntries ?? 0}</dd></div>
          </dl>
          <div className="mt-4"><ViewerStatus inspection={inspection} /></div>
        </div>
      </section>
    </div>}

    {cloudOnly && snapshot && view === "projects" && <div className="mt-6">
      <h2 className="text-lg font-semibold text-white">Projects</h2>
      {snapshot.projects.length === 0 && <p className="mt-2 rounded-lg border border-amber-400/15 bg-amber-400/5 p-3 text-sm text-amber-200">
        This workspace has no project records. Dataset and run metadata remain available under Datasets and Runs.</p>}
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{snapshot.projects.map((project) => {
        const datasetIds = Array.isArray(project.datasetIds) ? project.datasetIds.map(Number) : [];
        const workflows = snapshot.workflows.filter((workflow) => datasetIds.includes(Number(workflow.dataset_id)));
        const runs = snapshot.runs.filter((run) => datasetIds.includes(run.dataset_id));
        return <article key={project.remoteKey} className="rounded-xl border border-white/8 bg-slate-900/55 p-4">
          <div className="flex justify-between gap-2"><h3 className="font-semibold text-white">{stringValue(project.title, `Project ${project.id}`)}</h3><Badge tone="cloud">Cloud</Badge></div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
            <div><strong className="block text-lg text-white">{datasetIds.length}</strong><span className="text-slate-500">Datasets</span></div>
            <div><strong className="block text-lg text-white">{workflows.length}</strong><span className="text-slate-500">Workflows</span></div>
            <div><strong className="block text-lg text-white">{runs.length}</strong><span className="text-slate-500">Runs</span></div>
          </div>
          <p className="mt-4 text-[10px] text-slate-500">Updated {relativeTime(typeof project.updated_at === "string" ? project.updated_at : null)}</p>
        </article>;
      })}</div>
    </div>}

    {cloudOnly && snapshot && view === "datasets" && <div className="mt-6">
      <h2 className="text-lg font-semibold text-white">Datasets</h2>
      <div className="mt-4 grid gap-4 md:grid-cols-2">{snapshot.datasets.map((dataset) => {
        const runs = runsByDataset.get(dataset.id) ?? [];
        return <button key={dataset.remoteKey} onClick={() => setSelectedDataset(dataset)}
          className="rounded-xl border border-white/8 bg-slate-900/55 p-4 text-left transition hover:border-cyan-400/30 w-full">
          <div className="flex justify-between"><h3 className="font-semibold text-white">{stringValue(dataset.name, `Dataset ${dataset.id}`)}</h3><Badge tone="cloud">Cloud</Badge></div>
          <p className="mt-2 text-xs text-slate-500">Dataset #{dataset.id} · {stringValue(dataset.validation_status, "Validation unknown")}</p>
          <div className="mt-4 flex gap-4 text-xs text-slate-400"><span>{runs.length} runs</span><span>{snapshot.workflows.filter((w) => Number(w.dataset_id) === dataset.id).length} workflows</span></div>
        </button>;
      })}</div>
    </div>}

    {cloudOnly && snapshot && view === "workflows" && <div className="mt-6">
      <h2 className="text-lg font-semibold text-white">Workflows</h2>
      <p className="mt-2 text-xs text-slate-500">Runs are associated by dataset and pipeline node because the current run schema does not store a saved-workflow ID.</p>
      {snapshot.workflows.length === 0 && <p className="mt-4 rounded-lg border border-white/8 bg-slate-900/50 p-4 text-sm text-slate-400">No saved workflows exist on this server. Runs remain visible in Run history.</p>}
      <div className="mt-4 space-y-4">{snapshot.workflows.map((workflow) => {
        const nodes = workflowNodes(workflow);
        const runs = snapshot.runs.filter((run) => Number(workflow.dataset_id) === run.dataset_id && nodes.some((node) => node.pipelineId === run.pipeline_manifest_id));
        const overall = runs.some((run) => run.status === "running") ? "Running" : runs.some((run) => run.status === "failed") ? "Attention" : runs.length ? "Completed" : "No runs";
        return <article key={workflow.remoteKey} className="rounded-xl border border-white/8 bg-slate-900/55 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold text-white">{stringValue(workflow.name, `Workflow ${workflow.id}`)}</h3>
            <p className="mt-1 text-xs text-slate-500">Dataset #{String(workflow.dataset_id ?? "unassigned")}</p></div>
            <div className="flex gap-2"><Badge tone="cloud">Cloud</Badge><Badge tone={overall === "Completed" ? "success" : "warning"}>{overall}</Badge></div></div>
          <div className="mt-4 flex flex-wrap items-center gap-2">{nodes.map((node, index) => <div key={node.id} className="flex items-center gap-2">
            {index > 0 && <span className="text-slate-700">→</span>}<span className="rounded-md border border-white/8 bg-slate-950/60 px-3 py-2 text-xs text-slate-300">{node.pipelineId}</span></div>)}</div>
          <div className="mt-4 text-xs text-slate-400">{runs.length} associated runs</div>
        </article>;
      })}</div>
    </div>}

    {cloudOnly && snapshot && view === "runs" && <div className="mt-6">
      <div className="flex items-end justify-between"><div><h2 className="text-lg font-semibold text-white">Runs</h2><p className="mt-1 text-xs text-slate-500">Cloud metadata and local cache availability</p></div><Badge tone="cloud">{snapshot.runs.length} Cloud Runs</Badge></div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">{snapshot.runs.map((run) => {
        const viewerArtifacts = run.artifacts.filter((artifact) => /\/mri\/(orig_nu|aseg\.auto)\.mgz$/.test(artifact.relativePath)).length;
        return <button key={run.remoteKey} onClick={() => setSelectedRun(run)}
          className="rounded-xl border border-white/8 bg-slate-900/55 p-4 text-left transition hover:border-cyan-400/30">
          <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><span className="font-mono text-sm text-cyan-300">Run #{run.id}</span><Badge tone="cloud">Cloud</Badge></div>
            <h3 className="mt-2 font-semibold capitalize text-white">{run.pipeline_manifest_id}</h3></div>
            <Badge tone={run.status === "success" ? "success" : run.status === "failed" ? "danger" : "warning"}>{run.status === "success" ? "Completed" : run.status}</Badge></div>
          <div className="mt-4 flex flex-wrap gap-2"><Badge tone="success">Metadata Cached</Badge>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] ${cacheClass(run.cacheState)}`}>{cacheLabel(run.cacheState)}</span>
            <Badge>{run.artifacts.length} artifacts</Badge><Badge>{run.reports?.length ?? 0} reports</Badge></div>
          <p className="mt-3 text-xs text-slate-500">{viewerArtifacts >= 2 ? "2 artifacts available for FreeView" : viewerArtifacts ? "1 compatible viewer artifact" : "No external-viewer preset"}</p>
          <div className="mt-3 flex justify-between text-[10px] text-slate-600"><span>Created {new Date(run.created_at).toLocaleDateString()}</span><span>{run.finished_at ? `Completed ${new Date(run.finished_at).toLocaleDateString()}` : "Not completed"}</span></div>
        </button>;
      })}</div>
    </div>}

    {cloudOnly && snapshot && view === "reports" && <div className="mt-6">
      <h2 className="text-lg font-semibold text-white">Reports</h2>
      {snapshot.reports.length === 0 ? <p className="mt-4 rounded-lg border border-white/8 bg-slate-900/50 p-4 text-sm text-slate-400">No report records are registered in this workspace. Run-level report metadata remains visible in Run Details.</p>
        : <div className="mt-4 grid gap-3">{snapshot.reports.map((report) => <article key={report.remoteKey} className="rounded-lg border border-white/8 bg-slate-900/55 p-4">
          <div className="flex justify-between"><span className="text-sm text-white">{stringValue(report.title, `Report ${report.id}`)}</span><Badge tone="cloud">Cloud</Badge></div>
        </article>)}</div>}
    </div>}

    {cloudOnly && view === "settings" && <div className="mt-6 grid gap-5 lg:grid-cols-[1.3fr_1fr]">
      <section className="rounded-xl border border-white/8 bg-slate-900/50 p-5"><h2 className="text-lg font-semibold text-white">Workspace Settings</h2>
        {showForm && <form onSubmit={(event) => void addWorkspace(event)} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-400">Workspace name<input required value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded border border-white/10 bg-slate-950 px-3 py-2 text-white" /></label>
          <label className="text-xs text-slate-400">HTTPS server URL<input required type="url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} className="mt-1 w-full rounded border border-white/10 bg-slate-950 px-3 py-2 text-white" /></label>
          <label className="text-xs text-slate-400">Username<input required autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className="mt-1 w-full rounded border border-white/10 bg-slate-950 px-3 py-2 text-white" /></label>
          <label className="text-xs text-slate-400">Password<input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded border border-white/10 bg-slate-950 px-3 py-2 text-white" /></label>
          <button className="rounded bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950 sm:col-span-2">Save in OS credential store</button>
        </form>}
        {activeProfile && <div className="mt-4 space-y-3 text-sm"><p className="text-white">{activeProfile.name}</p><p className="text-slate-400">{activeProfile.serverUrl}</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => activeId && void synchronize(activeId)} className="rounded border border-white/10 px-3 py-2 text-xs text-slate-300">Reconnect</button>
            <button onClick={async () => { if (!activeId) return; try { const result = await desktop.testWorkspace(activeId); setConnectionResult(`Connected · NeuroForge ${result.serverVersion} · API ${result.apiVersion}`); } catch (cause) { setConnectionResult(cause instanceof Error ? cause.message : String(cause)); } }}
              className="rounded border border-white/10 px-3 py-2 text-xs text-slate-300">Test connection</button>
            <button onClick={disconnectWorkspace} className="rounded border border-white/10 px-3 py-2 text-xs text-slate-300">Disconnect</button>
            <button onClick={async () => { if (!activeId) return; await desktop.removeWorkspace(activeId); setSnapshot(null); setActiveId(null); await refreshProfiles(); }}
              className="rounded border border-red-400/20 px-3 py-2 text-xs text-red-300">Remove workspace</button>
          </div>{connectionResult && <p role="status" className="text-xs text-slate-400">{connectionResult}</p>}
          <button onClick={() => setParams({ view: "diagnostics" })} className="pt-3 text-[10px] text-slate-600 hover:text-slate-400">Workspace Diagnostics</button>
        </div>}
      </section>
      <section className="rounded-xl border border-white/8 bg-slate-900/50 p-5"><h2 className="text-sm font-semibold text-white">Current workspace</h2>
        <dl className="mt-4 space-y-3 text-xs"><div><dt className="text-slate-500">Workspace UUID</dt><dd className="mt-1 break-all font-mono text-slate-300">{snapshot?.workspaceId ?? "Not connected"}</dd></div>
          <div><dt className="text-slate-500">Last sync</dt><dd className="mt-1 text-slate-300">{relativeTime(activeProfile?.lastSync ?? null)}</dd></div>
          <div><dt className="text-slate-500">Server version</dt><dd className="mt-1 text-slate-300">{connectionResult ?? "Use Test connection"}</dd></div></dl>
      </section>
    </div>}

    {cloudOnly && snapshot && view === "diagnostics" && <div className="mt-6 rounded-xl border border-fuchsia-400/15 bg-slate-900/55 p-5">
      <div className="flex justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-widest text-fuchsia-300">Developer verification</p><h2 className="mt-1 text-lg font-semibold text-white">Workspace Diagnostics</h2></div><Badge tone={online ? "success" : "warning"}>{online ? "Online" : "Offline"}</Badge></div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Projects" value={snapshot.projects.length} /><Metric label="Datasets" value={snapshot.datasets.length} />
        <Metric label="Runs" value={snapshot.runs.length} /><Metric label="Artifacts" value={snapshot.runs.reduce((sum, run) => sum + run.artifacts.length, 0)} />
        <Metric label="Cache entries" value={inspection?.cacheEntries ?? 0} /><Metric label="Cache size" value={formatBytes(inspection?.cacheSizeBytes ?? 0)} />
        <Metric label="Cached runs" value={inspection?.cachedRuns ?? 0} /><Metric label="Download queue" value="0" />
        <Metric label="Legacy cache" value={inspection?.legacyCacheEntries.length ?? 0} detail="Detected only; not migrated" />
      </div>
      <dl className="mt-5 grid gap-4 text-xs sm:grid-cols-2"><div><dt className="text-slate-500">Workspace UUID / Server ID</dt><dd className="mt-1 break-all font-mono text-slate-300">{snapshot.workspaceId}</dd></div>
        <div><dt className="text-slate-500">Synchronization timestamp</dt><dd className="mt-1 text-slate-300">{snapshot.synchronizedAt}</dd></div></dl>
      <div className="mt-5"><ViewerStatus inspection={inspection} /></div>
    </div>}

    {error && <p role="alert" className="mt-4 rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-sm text-red-300">{error}</p>}
    {selectedRun && activeProfile && snapshot && <RunDetails profile={activeProfile} workspaceId={snapshot.workspaceId}
      run={selectedRun} online={online} inspection={inspection} onClose={() => setSelectedRun(null)}
      onCacheChanged={() => activeId && void synchronize(activeId, true)} />}
    {selectedDataset && activeProfile && snapshot && <DatasetDetails
      dataset={selectedDataset}
      runs={runsByDataset.get(selectedDataset.id) ?? []}
      workflows={snapshot.workflows.filter((w) => Number(w.dataset_id) === selectedDataset.id)}
      profile={activeProfile}
      onClose={() => setSelectedDataset(null)}
    />}
  </div>;
}
