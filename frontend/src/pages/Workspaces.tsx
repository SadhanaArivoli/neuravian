import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const REFRESH_MS = 15_000;

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function workflowPipelineIds(workflow: Record<string, unknown>): Set<string> {
  const state = workflow.state;
  if (!state || typeof state !== "object") return new Set();
  const nodes = (state as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return new Set();
  return new Set(nodes.flatMap((node) => {
    if (!node || typeof node !== "object") return [];
    const value = (node as { pipelineId?: unknown }).pipelineId;
    return typeof value === "string" ? [value] : [];
  }));
}

function cacheLabel(state: WorkspaceCacheState): string {
  return {
    "cloud-only": "Cloud Only",
    downloading: "Downloading",
    "partially-cached": "Partially Cached",
    "fully-cached": "Fully Cached",
    "offline-cached": "Offline Cached",
    "local-only": "Local Only",
    "server-unavailable": "Server Unavailable",
  }[state];
}

function WorkspaceRunRow({
  profile,
  workspaceId,
  run,
  online,
  onCacheChanged,
}: {
  profile: WorkspaceProfile;
  workspaceId: string;
  run: WorkspaceRun;
  online: boolean;
  onCacheChanged: () => void;
}) {
  const desktop = window.neuroforgeDesktop!;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const anatomy = run.artifacts.find((artifact) => artifact.relativePath.endsWith("/mri/orig_nu.mgz"));
  const segmentation = run.artifacts.find((artifact) => artifact.relativePath.endsWith("/mri/aseg.auto.mgz"));
  const canFreeView = run.pipeline_manifest_id === "fastsurfer" && anatomy && segmentation;
  const requiredCached = Boolean(anatomy && segmentation
    && run.cachedArtifacts.includes(anatomy.relativePath)
    && run.cachedArtifacts.includes(segmentation.relativePath));
  const canLaunch = Boolean(canFreeView && (online || requiredCached));

  async function openFreeView() {
    if (!canFreeView || !canLaunch) return;
    setBusy(true);
    setMessage(null);
    try {
      const synced = online
        ? await desktop.syncWorkspaceArtifacts({
          profileId: profile.id,
          workspaceId,
          runId: run.id,
          relativePaths: [anatomy.relativePath, segmentation.relativePath],
        })
        : { runId: run.id, downloaded: [], reused: [anatomy.relativePath, segmentation.relativePath] };
      await desktop.launchViewer({
        viewerId: "freeview",
        workspaceId,
        runId: run.id,
        files: [
          { relativePath: anatomy.relativePath },
          { relativePath: segmentation.relativePath, overlay: true },
        ],
        opacity: 0.7,
        freesurferLut: true,
      });
      setMessage(`${synced.downloaded.length} downloaded · ${synced.reused.length} reused`);
      onCacheChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-white/8 bg-slate-950/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-mono text-xs text-cyan-300">Run #{run.id}</span>
          <span className="ml-2 text-sm text-slate-200">{run.pipeline_manifest_id}</span>
          <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] ${
            run.status === "success" ? "bg-emerald-500/15 text-emerald-300" :
              run.status === "failed" ? "bg-red-500/15 text-red-300" :
                "bg-amber-500/15 text-amber-300"
          }`}>{run.status}</span>
        </div>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-400">
          {cacheLabel(run.cacheState)}
        </span>
      </div>
      {canFreeView && (
        <button
          type="button"
          disabled={!canLaunch || busy}
          onClick={() => { void openFreeView(); }}
          className="mt-2 rounded-md bg-cyan-500/15 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Preparing viewer…" : "Open in FreeView"}
        </button>
      )}
      {message && <p role="status" className="mt-2 text-[11px] text-slate-400">{message}</p>}
    </li>
  );
}

export default function Workspaces() {
  const desktop = window.neuroforgeDesktop;
  const [profiles, setProfiles] = useState<WorkspaceProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const refreshProfiles = useCallback(async () => {
    if (!desktop) return;
    const values = await desktop.listWorkspaces();
    setProfiles(values);
    setActiveId((current) => current ?? values[0]?.id ?? null);
  }, [desktop]);

  const synchronize = useCallback(async (profileId: string, quiet = false) => {
    if (!desktop) return;
    if (!quiet) setBusy(true);
    setError(null);
    try {
      const result = await desktop.syncWorkspace(profileId);
      setSnapshot(result.snapshot);
      setOnline(result.online);
      await refreshProfiles();
    } catch (cause) {
      setOnline(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [desktop, refreshProfiles]);

  useEffect(() => { void refreshProfiles(); }, [refreshProfiles]);
  useEffect(() => {
    if (!activeId) return;
    void synchronize(activeId);
    const timer = window.setInterval(() => { void synchronize(activeId, true); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [activeId, synchronize]);

  async function addWorkspace(event: FormEvent) {
    event.preventDefault();
    if (!desktop) return;
    setBusy(true);
    setError(null);
    try {
      const profile = await desktop.saveWorkspace({ name, serverUrl, username, password });
      setName(""); setServerUrl(""); setUsername(""); setPassword(""); setShowForm(false);
      await refreshProfiles();
      setActiveId(profile.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const activeProfile = profiles.find((profile) => profile.id === activeId) ?? null;
  const datasetProject = useMemo(() => {
    const result = new Map<number, number>();
    for (const project of snapshot?.projects ?? []) {
      const ids = project.datasetIds;
      if (Array.isArray(ids)) for (const id of ids) result.set(Number(id), project.id);
    }
    return result;
  }, [snapshot]);

  if (!desktop) {
    return <div className="p-8"><h1 className="text-xl font-semibold">Cloud Workspaces</h1>
      <p className="mt-2 text-sm text-slate-400">Workspace connections are managed by NeuroForge Desktop.</p></div>;
  }

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-cyan-400">Unified workspace</p>
          <h1 className="mt-1 text-2xl font-bold text-white">Cloud projects on your desktop</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            Metadata stays synchronized automatically. MRI artifacts download only when a viewer needs them.
          </p>
        </div>
        <button type="button" onClick={() => setShowForm((value) => !value)}
          className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950">
          Add Workspace
        </button>
      </div>

      {showForm && (
        <form onSubmit={(event) => { void addWorkspace(event); }} className="mt-5 grid gap-3 rounded-xl border border-white/10 bg-slate-900/60 p-4 md:grid-cols-2">
          <label className="text-xs text-slate-400">Workspace name
            <input required value={name} onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" />
          </label>
          <label className="text-xs text-slate-400">HTTPS server URL
            <input required type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)}
              placeholder="https://neuroforge.example.org"
              className="mt-1 w-full rounded border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" />
          </label>
          <label className="text-xs text-slate-400">Username
            <input required autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)}
              className="mt-1 w-full rounded border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" />
          </label>
          <label className="text-xs text-slate-400">Password
            <input required type="password" autoComplete="current-password" value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white" />
          </label>
          <button disabled={busy} className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 md:col-span-2">
            Save in OS credential store
          </button>
        </form>
      )}

      {profiles.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-white/8 bg-slate-900/40 p-3">
          <label className="text-xs text-slate-400">Workspace
            <select value={activeId ?? ""} onChange={(event) => setActiveId(event.target.value)}
              className="ml-2 rounded border border-white/10 bg-slate-950 px-2 py-1.5 text-sm text-white">
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          </label>
          <span className={`rounded-full px-2 py-1 text-[10px] ${online ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
            {busy ? "Synchronizing" : online ? "Connected" : "Offline"}
          </span>
          <button disabled={!activeId || busy} onClick={() => activeId && void synchronize(activeId)}
            className="rounded border border-white/10 px-2 py-1 text-xs text-slate-300 disabled:opacity-40">Refresh</button>
          {activeProfile?.lastSync && <span className="text-[10px] text-slate-500">Last sync {new Date(activeProfile.lastSync).toLocaleString()}</span>}
        </div>
      )}

      {error && <p role="alert" className="mt-4 rounded border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
      {!profiles.length && !showForm && <p className="mt-8 text-sm text-slate-500">Add a NeuroForge deployment to begin.</p>}

      {snapshot && (
        <div className="mt-6 space-y-4">
          {snapshot.projects.map((project) => {
            const projectDatasets = snapshot.datasets.filter((dataset) => datasetProject.get(dataset.id) === project.id);
            return (
              <section key={project.remoteKey} className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
                <h2 className="text-lg font-semibold text-white">{text(project.title, `Project ${project.id}`)}</h2>
                <div className="mt-3 space-y-3">
                  {projectDatasets.map((dataset) => {
                    const workflows = snapshot.workflows.filter((workflow) => Number(workflow.dataset_id) === dataset.id);
                    const datasetRuns = snapshot.runs.filter((run) => run.dataset_id === dataset.id);
                    const assignedPipelines = new Set(workflows.flatMap(
                      (workflow) => [...workflowPipelineIds(workflow)],
                    ));
                    const unmatchedRuns = datasetRuns.filter(
                      (run) => !assignedPipelines.has(run.pipeline_manifest_id),
                    );
                    return (
                      <details key={dataset.remoteKey} open className="rounded-lg border border-white/8 bg-slate-950/30 p-3">
                        <summary className="cursor-pointer text-sm font-medium text-slate-200">
                          {text(dataset.name, `Dataset ${dataset.id}`)}
                        </summary>
                        <div className="mt-3 space-y-3">
                          {workflows.map((workflow) => {
                            const pipelineIds = workflowPipelineIds(workflow);
                            const workflowRuns = datasetRuns.filter((run) => pipelineIds.has(run.pipeline_manifest_id));
                            return (
                              <div key={workflow.remoteKey} className="border-l border-cyan-500/30 pl-3">
                                <h3 className="text-xs font-semibold uppercase tracking-wide text-cyan-300">
                                  {text(workflow.name, `Workflow ${workflow.id}`)}
                                </h3>
                                <ul className="mt-2 space-y-2">
                                  {workflowRuns.map((run) => <WorkspaceRunRow key={run.remoteKey} profile={activeProfile!}
                                    workspaceId={snapshot.workspaceId} run={run} online={online}
                                    onCacheChanged={() => activeId && void synchronize(activeId, true)} />)}
                                </ul>
                              </div>
                            );
                          })}
                          {unmatchedRuns.length > 0 && (
                            <div className="border-l border-slate-700 pl-3">
                              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Run history</h3>
                              <ul className="mt-2 space-y-2">
                                {unmatchedRuns.map((run) => <WorkspaceRunRow key={run.remoteKey} profile={activeProfile!}
                                  workspaceId={snapshot.workspaceId} run={run} online={online}
                                  onCacheChanged={() => activeId && void synchronize(activeId, true)} />)}
                              </ul>
                            </div>
                          )}
                        </div>
                      </details>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
