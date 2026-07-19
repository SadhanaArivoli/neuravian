import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useWorkspace } from "../context/WorkspaceContext";
import {
  Badge, Card, CardHeader, EmptyState, InfoBanner, MetricCard,
  Page, PageHeader, PrimaryButton, SecondaryButton, TabBar,
} from "../components/primitives/index";
import { WorkspaceSettingsPanel } from "../components/domain/WorkspaceSettingsPanel";

const REFRESH_MS = 15_000;
type WorkspaceView = "home" | "projects" | "datasets" | "workflows" | "runs" | "reports";
const VIEWS: readonly WorkspaceView[] = ["home", "projects", "datasets", "workflows", "runs", "reports"];

// ── Helpers ────────────────────────────────────────────────────────────────────

function sv(value: unknown, fallback = "—"): string {
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
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return new Date(value).toLocaleString();
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

// ── Local workspace types & loading ────────────────────────────────────────────

export interface LocalWorkspaceData {
  projects: Array<Record<string, unknown> & { id: number }>;
  datasets: Array<Record<string, unknown> & { id: number }>;
  workflows: Array<Record<string, unknown> & { id: number }>;
  runs: Array<Record<string, unknown> & { id: number }>;
  reports: Array<Record<string, unknown> & { id: number; dataset_id: number }>;
}

export interface CombinedWorkspaceRun {
  key: string; id: number; pipeline: string; status: string;
  workspace: "Local NeuroForge" | "Cloud"; local: boolean;
}

export function combineWorkspaceRuns(
  data: LocalWorkspaceData, localWorkspaceId: string, cloud: WorkspaceSnapshot,
): CombinedWorkspaceRun[] {
  return [
    ...data.runs.map((run) => ({
      key: `${localWorkspaceId}:run:${run.id}`,
      id: run.id,
      pipeline: sv(run.pipeline_manifest_id),
      status: sv(run.status),
      workspace: "Local NeuroForge" as const,
      local: true,
    })),
    ...cloud.runs.map((run) => ({
      key: run.remoteKey,
      id: run.id,
      pipeline: run.pipeline_manifest_id,
      status: run.status,
      workspace: "Cloud" as const,
      local: false,
    })),
  ];
}

async function localJson<T>(route: string): Promise<T> {
  const resp = await fetch(`/api${route}`);
  if (!resp.ok) throw new Error(`Local API returned HTTP ${resp.status}.`);
  return resp.json() as Promise<T>;
}

async function loadLocalWorkspace(): Promise<LocalWorkspaceData> {
  const [projects, datasets, workflows, runs] = await Promise.all([
    localJson<LocalWorkspaceData["projects"]>("/projects"),
    localJson<LocalWorkspaceData["datasets"]>("/datasets"),
    localJson<LocalWorkspaceData["workflows"]>("/workflows"),
    localJson<LocalWorkspaceData["runs"]>("/runs"),
  ]);
  const reportGroups = await Promise.all(
    datasets.map((d) => localJson<LocalWorkspaceData["reports"]>(`/datasets/${d.id}/reports`).catch(() => [])),
  );
  return { projects, datasets, workflows, runs, reports: reportGroups.flat() };
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SyncBanner({ state }: { state: "idle" | "syncing" | "done" | "failed" }) {
  if (state === "idle") return null;
  return (
    <InfoBanner
      tone={state === "failed" ? "danger" : "info"}
      title={state === "syncing" ? "Synchronizing metadata…" : state === "done" ? "Synchronization complete" : "Synchronization failed"}
    >
      <div className="mt-2 grid grid-cols-4 gap-2">
        {["Projects", "Datasets", "Runs", "Reports"].map((label) => (
          <div key={label} className="rounded-md bg-surface/50 px-2 py-1.5 text-center text-[10px]">
            <span className={state === "done" ? "text-emerald-300" : state === "syncing" ? "text-accent" : "text-red-300"}>
              {state === "done" ? "✓ " : state === "syncing" ? "• " : "× "}
            </span>
            {label}
          </div>
        ))}
      </div>
    </InfoBanner>
  );
}

function ViewerStatusCard({ inspection }: { inspection: WorkspaceInspection | null }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(["freeview", "mricrogl"] as const).map((viewerId) => {
        const v = inspection?.viewers.find((item) => item.viewerId === viewerId);
        return (
          <div key={viewerId} className="rounded-lg border border-white/8 bg-surface/45 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-white">{viewerId === "freeview" ? "FreeView" : "MRIcroGL"}</span>
              <Badge tone={v?.installed ? "success" : "warning"}>{v?.installed ? "Installed" : "Not found"}</Badge>
            </div>
            <p className="mt-1 truncate text-[10px] text-gray-500">{v?.executable ?? v?.reason ?? "—"}</p>
          </div>
        );
      })}
    </div>
  );
}

function ArtifactTable({ run }: { run: WorkspaceRun }) {
  if (!run.artifacts.length) return <p className="text-sm text-gray-500">No artifact manifest available.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-white/8">
      <table className="w-full min-w-[720px] text-left text-xs">
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
          {run.artifacts.map((a) => {
            const cached = run.cachedArtifacts.includes(a.relativePath);
            return (
              <tr key={String(a.artifactId)} className="text-gray-300">
                <td className="px-3 py-2 font-mono text-[11px]">{a.relativePath}</td>
                <td className="px-3 py-2"><Badge tone={cached ? "success" : "cloud"}>{cached ? "Cached" : "Cloud"}</Badge></td>
                <td className="px-3 py-2">{formatBytes(a.sizeBytes)}</td>
                <td className="px-3 py-2 font-mono text-[10px]" title={a.sha256}>{a.sha256.slice(0, 12)}…</td>
                <td className="px-3 py-2">{a.geometry ? `${a.geometry.shape.join("×")} · ${a.geometry.orientation.join("")}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WorkspaceProfileCard({
  profile, active, onClick, onDuplicate, onExport,
}: {
  profile: WorkspaceProfile; active: boolean; onClick: () => void;
  onDuplicate: () => void; onExport: () => void;
}) {
  return (
    <div
      className={`group rounded-xl border p-4 transition-colors cursor-pointer ${
        active ? "border-accent/30 bg-accent/5" : "border-white/8 bg-surface-raised hover:border-white/15"
      }`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-white">{profile.name}</p>
          <p className="mt-0.5 truncate text-[11px] text-gray-500">{profile.serverUrl}</p>
          {profile.connectionMode === "instance-id" && profile.instanceId && (
            <p className="mt-0.5 text-[10px] text-accent">{profile.instanceId} · {profile.awsRegion}</p>
          )}
        </div>
        <Badge tone={profile.connectionState === "connected" ? "success" : "warning"}>
          {profile.connectionState}
        </Badge>
      </div>
      <div className="mt-3 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
        <button onClick={onDuplicate} className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
          Duplicate
        </button>
        <span className="text-gray-700">·</span>
        <button onClick={onExport} className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">
          Export
        </button>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Workspaces() {
  const desktop = window.neuroforgeDesktop;
  const workspace = useWorkspace();
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view") as WorkspaceView | null;
  const view: WorkspaceView = requestedView && VIEWS.includes(requestedView) ? requestedView : "home";

  const [profiles, setProfiles] = useState<WorkspaceProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  // session is loaded on workspace selection; drives UI restoration in Session B.
  const sessionRef = useRef<WorkspaceSession | null>(null);
  // Ref tracks which profile is currently intended to be displayed.
  // Checked at every await boundary to discard stale async responses when
  // the user switches workspaces before the previous load/sync completes.
  const activeIdRef = useRef<string | null>(null);
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null);
  const [online, setOnline] = useState(false);
  const [ec2Health, setEc2Health] = useState<Ec2ConnectionHealth | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "done" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkspaceRun | null>(null);
  const [selectedDataset, setSelectedDataset] = useState<(Record<string, unknown> & { id: number; remoteKey: string }) | null>(null);
  const [localData, setLocalData] = useState<LocalWorkspaceData | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Add workspace form
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formUrl, setFormUrl] = useState("");
  const [formUser, setFormUser] = useState("");
  const [formPass, setFormPass] = useState("");
  const [formMode, setFormMode] = useState<"url" | "instance-id">("url");
  const [formInstanceId, setFormInstanceId] = useState("");
  const [formRegion, setFormRegion] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Import form
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Settings panel
  const [showSettings, setShowSettings] = useState(false);

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
      // Guard: discard this response if the user switched to a different workspace
      // while the network call was in flight.
      if (activeIdRef.current !== profileId) return;
      setSnapshot(result.snapshot);
      setOnline(result.online);
      if (result.ec2Health !== undefined) setEc2Health(result.ec2Health ?? null);
      await Promise.all([refreshProfiles(), refreshInspection(profileId, result.snapshot.workspaceId)]);
      if (!quiet) {
        setSyncState("done");
        window.setTimeout(() => setSyncState("idle"), 2500);
      }
    } catch (cause) {
      if (activeIdRef.current !== profileId) return; // stale error for old workspace
      setOnline(false);
      setSyncState("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [desktop, refreshInspection, refreshProfiles]);

  // Keep activeIdRef in sync with the state value.
  // This ref is the authoritative "which workspace is currently shown" marker
  // used by async callbacks to discard stale responses.
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  useEffect(() => { void refreshProfiles(); }, [refreshProfiles]);
  useEffect(() => {
    void loadLocalWorkspace().then(setLocalData).catch((e: unknown) =>
      setLocalError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    if (!scope.startsWith("cloud:")) return;
    const profileId = scope.slice(6);
    if (profiles.some((p) => p.id === profileId)) setActiveId(profileId);
  }, [profiles, scope]);
  // On workspace selection: load session + cached snapshot immediately (fast local read),
  // then begin background sync against the cloud. The user sees data within ~20 ms
  // rather than waiting for the full network round-trip.
  useEffect(() => {
    if (!activeId || !desktop) return;
    let cancelled = false;

    async function loadAndSync() {
      if (!desktop) return;
      // Phase 1: local read — fast (<20 ms). Show whatever we have on disk.
      try {
        const profileId = activeId!;
        const { session: s, cachedSnapshot } = await desktop.loadSession(profileId);
        // Discard if the user switched profiles while the local read was in flight.
        if (cancelled || activeIdRef.current !== profileId) return;
        if (s) sessionRef.current = s;
        // Apply the cached snapshot for this specific profile — guarantees no
        // cross-profile flash when switching workspaces.
        if (cachedSnapshot) setSnapshot(cachedSnapshot);
      } catch {
        // Session load is best-effort — a failure here is not fatal.
      }
      // Phase 2: network sync — slower. Updates snapshot when it returns.
      if (!cancelled) await synchronize(activeId!, false);
    }

    void loadAndSync();
    const timer = window.setInterval(() => void synchronize(activeId!, true), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const activeProfile = profiles.find((p) => p.id === activeId) ?? null;
  const runsByDataset = useMemo(() => new Map(
    (snapshot?.datasets ?? []).map((d) => [d.id, snapshot?.runs.filter((r) => r.dataset_id === d.id) ?? []]),
  ), [snapshot]);

  async function addWorkspace(e: FormEvent) {
    e.preventDefault();
    if (!desktop) return;
    setFormError(null);
    try {
      const profile = await desktop.saveWorkspace({
        name: formName, serverUrl: formUrl, username: formUser, password: formPass,
        connectionMode: formMode,
        instanceId: formMode === "instance-id" ? formInstanceId || null : null,
        awsRegion: formMode === "instance-id" ? formRegion || null : null,
      });
      setFormName(""); setFormUrl(""); setFormUser(""); setFormPass("");
      setFormInstanceId(""); setFormRegion(""); setFormMode("url");
      setShowForm(false);
      await refreshProfiles();
      setActiveId(profile.id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  async function duplicateProfile(profileId: string) {
    if (!desktop) return;
    try {
      await desktop.duplicateWorkspace(profileId);
      await refreshProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function exportProfile(profileId: string) {
    if (!desktop) return;
    try {
      const data = await desktop.exportWorkspace(profileId);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `neuroforge-workspace-${profileId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function importProfile(e: FormEvent) {
    e.preventDefault();
    if (!desktop) return;
    setImportError(null);
    try {
      const parsed = JSON.parse(importJson) as Record<string, unknown>;
      if (typeof parsed.serverUrl !== "string") throw new Error("Missing serverUrl in export JSON.");
      const profile = await desktop.importWorkspace({
        name: typeof parsed.name === "string" ? parsed.name : undefined,
        serverUrl: parsed.serverUrl,
        connectionMode: parsed.connectionMode as "url" | "instance-id" | undefined,
        instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : null,
        awsRegion: typeof parsed.awsRegion === "string" ? parsed.awsRegion : null,
      });
      await refreshProfiles();
      setActiveId(profile.id);
      setShowImport(false);
      setImportJson("");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleFileImport(files: FileList | null) {
    if (!files?.[0]) return;
    const reader = new FileReader();
    reader.onload = (e) => setImportJson((e.target?.result as string) ?? "");
    reader.readAsText(files[0]);
  }

  if (!desktop) return (
    <Page>
      <h1 className="text-xl font-semibold text-white">Workspace</h1>
      <p className="mt-2 text-sm text-gray-400">Unified cloud workspaces are available in NeuroForge Desktop.</p>
    </Page>
  );

  const inputCls = "w-full rounded border border-white/10 bg-surface px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-accent/50 focus:outline-none";

  return (
    <Page>
      {/* Header */}
      <PageHeader
        eyebrow="Workspace"
        title={
          showsLocal && !showsCloud ? "Local NeuroForge"
          : scope === "all" ? "All Workspaces"
          : activeProfile?.name ?? "Cloud Workspace"
        }
        subtitle={
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {showsLocal && <Badge tone="success">Local · Available offline</Badge>}
            {showsCloud && (
              <Badge tone={online ? "success" : "warning"}>{online ? "Connected" : snapshot ? "Offline" : "Not connected"}</Badge>
            )}
            {showsCloud && activeProfile && (
              <span className="text-xs text-gray-500">{activeProfile.serverUrl}</span>
            )}
          </div>
        }
      >
        {showsCloud && activeId && (
          <>
            <SecondaryButton onClick={() => void synchronize(activeId)} disabled={syncState === "syncing"}>
              Refresh
            </SecondaryButton>
            {activeProfile && (
              <SecondaryButton onClick={() => setShowSettings(true)}>
                Settings
              </SecondaryButton>
            )}
          </>
        )}
        <PrimaryButton onClick={() => setShowForm(true)}>Add Workspace</PrimaryButton>
        <SecondaryButton onClick={() => setShowImport(true)}>Import</SecondaryButton>
      </PageHeader>

      {showsCloud && <div className="mt-4"><SyncBanner state={syncState} /></div>}

      {/* Workspace list (sidebar-style cards when multiple profiles) */}
      {profiles.length > 1 && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {profiles.map((p) => (
            <WorkspaceProfileCard
              key={p.id}
              profile={p}
              active={p.id === activeId}
              onClick={() => { setActiveId(p.id); workspace.select(`cloud:${p.id}`); }}
              onDuplicate={() => void duplicateProfile(p.id)}
              onExport={() => void exportProfile(p.id)}
            />
          ))}
        </div>
      )}

      {/* Add workspace form */}
      {showForm && (
        <div className="mt-5 rounded-xl border border-white/8 bg-surface-raised p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Add workspace</h2>
            <button onClick={() => setShowForm(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
          </div>
          <form onSubmit={(e) => void addWorkspace(e)} className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-gray-400">
              Workspace name
              <input required value={formName} onChange={(e) => setFormName(e.target.value)} className={`mt-1 ${inputCls}`} placeholder="My NeuroForge Server" />
            </label>
            <label className="text-xs text-gray-400">
              Connection mode
              <select value={formMode} onChange={(e) => setFormMode(e.target.value as "url" | "instance-id")} className={`mt-1 ${inputCls}`}>
                <option value="url">Static HTTPS URL</option>
                <option value="instance-id">EC2 Instance ID</option>
              </select>
            </label>
            {formMode === "url" && (
              <label className="text-xs text-gray-400 sm:col-span-2">
                Server URL
                <input required type="url" value={formUrl} onChange={(e) => setFormUrl(e.target.value)} className={`mt-1 ${inputCls}`} placeholder="https://your-server.example.com" />
              </label>
            )}
            {formMode === "instance-id" && (
              <>
                <label className="text-xs text-gray-400">
                  EC2 Instance ID
                  <input required value={formInstanceId} onChange={(e) => setFormInstanceId(e.target.value)} className={`mt-1 ${inputCls}`} placeholder="i-0abc123def456789" />
                </label>
                <label className="text-xs text-gray-400">
                  AWS Region
                  <input required value={formRegion} onChange={(e) => setFormRegion(e.target.value)} className={`mt-1 ${inputCls}`} placeholder="us-east-1" />
                </label>
                <label className="text-xs text-gray-400 sm:col-span-2">
                  Server URL template (will be updated with resolved IP)
                  <input value={formUrl} onChange={(e) => setFormUrl(e.target.value)} className={`mt-1 ${inputCls}`} placeholder="https://PLACEHOLDER:8000" />
                </label>
              </>
            )}
            <label className="text-xs text-gray-400">
              Username
              <input required autoComplete="username" value={formUser} onChange={(e) => setFormUser(e.target.value)} className={`mt-1 ${inputCls}`} />
            </label>
            <label className="text-xs text-gray-400">
              Password
              <input required type="password" autoComplete="current-password" value={formPass} onChange={(e) => setFormPass(e.target.value)} className={`mt-1 ${inputCls}`} />
            </label>
            <div className="sm:col-span-2">
              <PrimaryButton type="submit">Save workspace</PrimaryButton>
              {formError && <p className="mt-2 text-xs text-red-400">{formError}</p>}
            </div>
          </form>
        </div>
      )}

      {/* Import form */}
      {showImport && (
        <div className="mt-5 rounded-xl border border-white/8 bg-surface-raised p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Import workspace</h2>
            <button onClick={() => setShowImport(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
          </div>
          <form onSubmit={(e) => void importProfile(e)} className="space-y-3">
            <div>
              <input type="file" ref={fileInputRef} accept=".json" className="hidden"
                onChange={(e) => handleFileImport(e.target.files)} />
              <SecondaryButton onClick={() => fileInputRef.current?.click()}>
                Load from file
              </SecondaryButton>
            </div>
            <label className="block text-xs text-gray-400">
              Or paste JSON
              <textarea
                value={importJson} onChange={(e) => setImportJson(e.target.value)}
                rows={5}
                className={`mt-1 ${inputCls} font-mono text-[11px]`}
                placeholder='{"name":"...", "serverUrl":"...", ...}'
              />
            </label>
            <div>
              <PrimaryButton type="submit" disabled={!importJson.trim()}>Import</PrimaryButton>
              {importError && <p className="mt-2 text-xs text-red-400">{importError}</p>}
            </div>
          </form>
        </div>
      )}

      {/* No workspaces empty state */}
      {!profiles.length && !showForm && !showImport && (
        <div className="mt-8">
          <EmptyState
            title="No cloud workspaces"
            subtitle="Add an HTTPS NeuroForge deployment to see its projects, datasets, and runs."
            action={<PrimaryButton onClick={() => setShowForm(true)}>Add Workspace</PrimaryButton>}
          />
        </div>
      )}

      {/* Local workspace content */}
      {showsLocal && localData && workspace.local && (
        <LocalWorkspaceView view={view} data={localData} workspaceId={workspace.local.id}
          cloud={scope === "all" ? snapshot : null} />
      )}
      {showsLocal && localError && (
        <InfoBanner tone="danger" title="Local workspace unavailable">{localError}</InfoBanner>
      )}

      {/* Cloud content */}
      {cloudOnly && snapshot && (
        <div className="mt-5">
          <TabBar tabs={VIEWS} active={view} onChange={(v) => setParams({ view: v })} />
          <div className="mt-6">
            <CloudContent
              view={view}
              snapshot={snapshot}
              inspection={inspection}
              online={online}
              activeProfile={activeProfile}
              ec2Health={ec2Health}
              runsByDataset={runsByDataset}
              onSelectRun={setSelectedRun}
              onSelectDataset={setSelectedDataset}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4">
          <InfoBanner tone="danger">{error}</InfoBanner>
        </div>
      )}

      {/* Drawers */}
      {selectedRun && activeProfile && snapshot && (
        <RunDrawer
          profile={activeProfile}
          workspaceId={snapshot.workspaceId}
          run={selectedRun}
          online={online}
          inspection={inspection}
          onClose={() => setSelectedRun(null)}
          onCacheChanged={() => activeId && void synchronize(activeId, true)}
        />
      )}

      {selectedDataset && activeProfile && snapshot && (
        <DatasetDrawer
          dataset={selectedDataset}
          runs={runsByDataset.get(selectedDataset.id) ?? []}
          workflows={snapshot.workflows.filter((w) => Number(w.dataset_id) === selectedDataset.id)}
          profile={activeProfile}
          online={online}
          onClose={() => setSelectedDataset(null)}
          onPulledToLocal={() => {}}
        />
      )}

      {showSettings && activeProfile && (
        <WorkspaceSettingsPanel
          profile={activeProfile}
          workspaceId={snapshot?.workspaceId ?? null}
          inspection={inspection}
          online={online}
          ec2Health={ec2Health}
          onClose={() => setShowSettings(false)}
          onUpdated={(updated) => {
            setProfiles((prev) => prev.map((p) => p.id === updated.id ? updated : p));
          }}
          onRemoved={() => {
            setShowSettings(false);
            setSnapshot(null);
            setActiveId(null);
            void refreshProfiles();
          }}
        />
      )}
    </Page>
  );
}

// ── Cloud content switcher ─────────────────────────────────────────────────────

function Ec2StatusRow({ health }: { health: Ec2ConnectionHealth }) {
  const tone = health.instanceState === "running" ? "success"
    : health.instanceState === "pending" ? "warning"
    : health.instanceState === "stopped" || health.instanceState === "stopping" ? "danger"
    : "warning";
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-white/8 bg-surface/50 px-4 py-3 text-xs">
      <div className="flex items-center gap-2 min-w-[120px]">
        <span className="text-gray-500">Instance</span>
        <Badge tone={tone}>{health.instanceState}</Badge>
      </div>
      {health.publicIp && <div><span className="text-gray-500">IP: </span><span className="font-mono text-gray-300">{health.publicIp}</span></div>}
      {health.publicHostname && <div className="truncate max-w-[220px]"><span className="text-gray-500">Host: </span><span className="font-mono text-gray-300">{health.publicHostname}</span></div>}
      <div><span className="text-gray-500">Region: </span><span className="text-gray-300">{health.region || "—"}</span></div>
      <div><span className="text-gray-500">Updated: </span><span className="text-gray-400">{new Date(health.lastUpdated).toLocaleTimeString()}</span></div>
      {health.error && <div className="w-full text-red-400">{health.error}</div>}
      {health.instanceState === "stopped" && (
        <div className="w-full text-amber-300">Instance is stopped — start it on AWS to reconnect. NeuroForge will detect the new IP automatically.</div>
      )}
      {health.instanceState === "pending" && (
        <div className="w-full text-accent">Instance is starting up… NeuroForge will reconnect automatically. This usually takes 1–2 minutes.</div>
      )}
    </div>
  );
}

function CloudContent({
  view, snapshot, inspection, online, activeProfile, ec2Health, runsByDataset, onSelectRun, onSelectDataset,
}: {
  view: WorkspaceView;
  snapshot: WorkspaceSnapshot;
  inspection: WorkspaceInspection | null;
  online: boolean;
  activeProfile: WorkspaceProfile | null;
  ec2Health: Ec2ConnectionHealth | null;
  runsByDataset: Map<number, WorkspaceRun[]>;
  onSelectRun: (run: WorkspaceRun) => void;
  onSelectDataset: (d: Record<string, unknown> & { id: number; remoteKey: string }) => void;
}) {
  const cachedRuns = snapshot.runs.filter((r) => r.cachedArtifacts.length > 0).length;
  const cloudOnlyRuns = snapshot.runs.filter((r) => r.cachedArtifacts.length === 0).length;

  if (view === "home") return (
    <div className="space-y-4">
      {ec2Health && <Ec2StatusRow health={ec2Health} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <MetricCard label="Projects" value={snapshot.projects.length} />
        <MetricCard label="Datasets" value={snapshot.datasets.length} />
        <MetricCard label="Workflows" value={snapshot.workflows.length} />
        <MetricCard label="Runs" value={snapshot.runs.length} />
        <MetricCard label="Cached" value={cachedRuns} />
        <MetricCard label="Cloud only" value={cloudOnlyRuns} />
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Workspace home" />
          <dl className="mt-4 grid gap-4 text-xs sm:grid-cols-2">
            <div><dt className="text-gray-500">Last sync</dt><dd className="mt-1 text-gray-200">{relativeTime(activeProfile?.lastSync ?? snapshot.synchronizedAt)}</dd></div>
            <div><dt className="text-gray-500">Cloud health</dt><dd className={`mt-1 ${online ? "text-emerald-300" : "text-amber-300"}`}>{online ? "Healthy and reachable" : "Using cached metadata"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-gray-500">Workspace UUID</dt><dd className="mt-1 break-all font-mono text-gray-300">{snapshot.workspaceId}</dd></div>
          </dl>
        </Card>
        <Card>
          <CardHeader title="Cache and viewers" />
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div><dt className="text-gray-500">Cache size</dt><dd className="mt-1 text-white">{formatBytes(inspection?.cacheSizeBytes ?? 0)}</dd></div>
            <div><dt className="text-gray-500">Cached runs</dt><dd className="mt-1 text-white">{inspection?.cachedRuns ?? 0}</dd></div>
          </dl>
          <div className="mt-4"><ViewerStatusCard inspection={inspection} /></div>
        </Card>
      </div>
    </div>
  );

  if (view === "projects") return (
    <div>
      <h2 className="text-lg font-semibold text-white">Projects</h2>
      {snapshot.projects.length === 0
        ? <EmptyState title="No projects" subtitle="Cloud projects will appear here after a workspace sync." />
        : <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {snapshot.projects.map((project) => {
            const datasetIds = Array.isArray(project.datasetIds) ? project.datasetIds.map(Number) : [];
            const runs = snapshot.runs.filter((r) => datasetIds.includes(r.dataset_id));
            return (
              <article key={project.remoteKey} className="rounded-xl border border-white/8 bg-surface-raised p-4">
                <div className="flex justify-between gap-2">
                  <h3 className="font-semibold text-white">{sv(project.title, `Project ${project.id}`)}</h3>
                  <Badge tone="cloud">Cloud</Badge>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                  <div><strong className="block text-lg text-white">{datasetIds.length}</strong><span className="text-gray-500">Datasets</span></div>
                  <div><strong className="block text-lg text-white">{snapshot.workflows.filter((w) => datasetIds.includes(Number(w.dataset_id))).length}</strong><span className="text-gray-500">Workflows</span></div>
                  <div><strong className="block text-lg text-white">{runs.length}</strong><span className="text-gray-500">Runs</span></div>
                </div>
              </article>
            );
          })}
        </div>}
    </div>
  );

  if (view === "datasets") return (
    <div>
      <h2 className="text-lg font-semibold text-white">Datasets</h2>
      {snapshot.datasets.length === 0
        ? <EmptyState title="No datasets" subtitle="Dataset metadata will appear here after sync." />
        : <div className="mt-4 grid gap-4 md:grid-cols-2">
          {snapshot.datasets.map((d) => {
            const runs = runsByDataset.get(d.id) ?? [];
            return (
              <button key={d.remoteKey} onClick={() => onSelectDataset(d)}
                className="rounded-xl border border-white/8 bg-surface-raised p-4 text-left transition hover:border-accent/30 w-full">
                <div className="flex justify-between"><h3 className="font-semibold text-white">{sv(d.name, `Dataset ${d.id}`)}</h3><Badge tone="cloud">Cloud</Badge></div>
                <p className="mt-1 text-xs text-gray-500">{sv(d.validation_status, "Validation unknown")}</p>
                <div className="mt-3 flex gap-4 text-xs text-gray-400"><span>{runs.length} runs</span></div>
              </button>
            );
          })}
        </div>}
    </div>
  );

  if (view === "workflows") return (
    <div>
      <h2 className="text-lg font-semibold text-white">Workflows</h2>
      {snapshot.workflows.length === 0
        ? <EmptyState title="No saved workflows" subtitle="Workflows created on this server will appear here." />
        : <div className="mt-4 space-y-4">
          {snapshot.workflows.map((wf) => {
            const nodes = workflowNodes(wf);
            return (
              <article key={wf.remoteKey} className="rounded-xl border border-white/8 bg-surface-raised p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><h3 className="font-semibold text-white">{sv(wf.name, `Workflow ${wf.id}`)}</h3>
                    <p className="mt-1 text-xs text-gray-500">Dataset #{String(wf.dataset_id ?? "—")}</p></div>
                  <Badge tone="cloud">Cloud</Badge>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {nodes.map((n, i) => (
                    <div key={n.id} className="flex items-center gap-2">
                      {i > 0 && <span className="text-gray-700">→</span>}
                      <span className="rounded-md border border-white/8 bg-surface/60 px-3 py-2 text-xs text-gray-300">{n.pipelineId}</span>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>}
    </div>
  );

  if (view === "runs") return (
    <div>
      <div className="flex items-end justify-between">
        <h2 className="text-lg font-semibold text-white">Runs</h2>
        <Badge tone="cloud">{snapshot.runs.length} Cloud Runs</Badge>
      </div>
      {snapshot.runs.length === 0
        ? <EmptyState title="No runs" subtitle="Pipeline runs will appear here after they complete." />
        : <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {snapshot.runs.map((run) => (
            <button key={run.remoteKey} onClick={() => onSelectRun(run)}
              className="rounded-xl border border-white/8 bg-surface-raised p-4 text-left transition hover:border-accent/30">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-accent">Run #{run.id}</span>
                    <Badge tone="cloud">Cloud</Badge>
                  </div>
                  <h3 className="mt-2 font-semibold capitalize text-white">{run.pipeline_manifest_id}</h3>
                </div>
                <Badge tone={run.status === "success" ? "success" : run.status === "failed" ? "danger" : "warning"}>
                  {run.status === "success" ? "Completed" : run.status}
                </Badge>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Badge tone="success">Metadata Cached</Badge>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] ${cacheClass(run.cacheState)}`}>{cacheLabel(run.cacheState)}</span>
                <Badge>{run.artifacts.length} artifacts</Badge>
              </div>
              <div className="mt-3 flex justify-between text-[10px] text-gray-600">
                <span>Created {new Date(run.created_at).toLocaleDateString()}</span>
                <span>{run.finished_at ? `Completed ${new Date(run.finished_at).toLocaleDateString()}` : "—"}</span>
              </div>
            </button>
          ))}
        </div>}
    </div>
  );

  if (view === "reports") return (
    <div>
      <h2 className="text-lg font-semibold text-white">Reports</h2>
      {snapshot.reports.length === 0
        ? <EmptyState title="No reports" subtitle="Report records will appear here after sync." />
        : <div className="mt-4 grid gap-3">
          {snapshot.reports.map((r) => (
            <article key={r.remoteKey} className="rounded-lg border border-white/8 bg-surface-raised p-4">
              <div className="flex justify-between">
                <span className="text-sm text-white">{sv(r.title, `Report ${r.id}`)}</span>
                <Badge tone="cloud">Cloud</Badge>
              </div>
            </article>
          ))}
        </div>}
    </div>
  );

  return null;
}

// ── Run drawer ─────────────────────────────────────────────────────────────────

function RunDrawer({
  profile, workspaceId, run, online, inspection, onClose, onCacheChanged,
}: {
  profile: WorkspaceProfile; workspaceId: string; run: WorkspaceRun; online: boolean;
  inspection: WorkspaceInspection | null; onClose: () => void; onCacheChanged: () => void;
}) {
  const desktop = window.neuroforgeDesktop!;
  const [tab, setTab] = useState<"overview" | "artifacts" | "logs" | "reports">("overview");
  const [downloading, setDownloading] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const anatomy = run.artifacts.find((a) => a.relativePath.endsWith("/mri/orig_nu.mgz"));
  const segmentation = run.artifacts.find((a) => a.relativePath.endsWith("/mri/aseg.auto.mgz"));
  const freeview = inspection?.viewers.find((v) => v.viewerId === "freeview");
  const required = anatomy && segmentation ? [anatomy.relativePath, segmentation.relativePath] : [];
  const cached = required.length > 0 && required.every((r) => run.cachedArtifacts.includes(r));

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
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading([]);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm" role="dialog">
      <div className="h-full w-full max-w-4xl overflow-y-auto border-l border-white/10 bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold text-white">Run #{run.id}</h2>
              <Badge tone="cloud">Cloud</Badge>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${cacheClass(run.cacheState)}`}>{cacheLabel(run.cacheState)}</span>
            </div>
            <p className="mt-1 text-sm text-gray-400">{run.pipeline_manifest_id} · {run.status}</p>
          </div>
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-4">
          <MetricCard label="Artifacts" value={run.artifacts.length} detail={`${run.cachedArtifacts.length} cached`} />
          <MetricCard label="Reports" value={run.reports?.length ?? 0} />
          <MetricCard label="Created" value={new Date(run.created_at).toLocaleDateString()} />
          <MetricCard label="Completed" value={run.finished_at ? new Date(run.finished_at).toLocaleDateString() : "—"} />
        </div>

        <div className="mt-5">
          <TabBar tabs={["overview", "artifacts", "logs", "reports"] as const} active={tab} onChange={setTab} />
        </div>

        <div className="mt-5">
          {tab === "overview" && (
            <div className="space-y-5">
              <Card>
                <CardHeader title="Open results" />
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <button onClick={() => void desktop.openWorkspaceRun({ profileId: profile.id, runId: run.id })}
                    className="rounded-lg border border-accent/20 bg-accent/10 p-3 text-left text-sm text-accent">
                    Open in Cloud Browser
                    <span className="mt-1 block text-[10px] text-gray-500">Authenticated cloud run page</span>
                  </button>
                  <button disabled={!freeview?.installed || required.length !== 2 || (!online && !cached)}
                    onClick={() => void openFreeView()}
                    className="rounded-lg border border-accent/20 bg-accent/10 p-3 text-left text-sm text-accent disabled:opacity-40 disabled:cursor-not-allowed">
                    Open in FreeView
                    <span className="mt-1 block text-[10px] text-gray-500">
                      {!freeview?.installed ? (freeview?.reason ?? "Not installed") : required.length !== 2 ? "No compatible artifacts" : cached ? "Ready from cache" : "Downloads 2 artifacts"}
                    </span>
                  </button>
                  <button disabled className="rounded-lg border border-white/8 bg-white/5 p-3 text-left text-sm text-gray-400 disabled:opacity-40 disabled:cursor-not-allowed">
                    Open in MRIcroGL
                    <span className="mt-1 block text-[10px] text-gray-500">Configure in Workspace Settings → Viewers</span>
                  </button>
                </div>
                {downloading.length > 0 && (
                  <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
                    <p className="text-xs font-semibold text-amber-300">Downloading</p>
                    {downloading.map((f) => (
                      <div key={f} className="mt-2 flex items-center gap-2 text-xs text-gray-300">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />{f.split("/").pop()}
                      </div>
                    ))}
                  </div>
                )}
                {message && <p className="mt-3 text-xs text-gray-400">{message}</p>}
              </Card>
              <Card>
                <CardHeader title="Pipeline parameters" />
                <pre className="mt-3 max-h-52 overflow-auto rounded-lg bg-surface/70 p-3 text-[11px] text-gray-400">
                  {JSON.stringify(run.parameters ?? {}, null, 2)}
                </pre>
              </Card>
            </div>
          )}
          {tab === "artifacts" && <ArtifactTable run={run} />}
          {tab === "logs" && <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface/70 p-4 text-[11px] text-gray-400">{JSON.stringify(run.logs ?? { message: "No logs cached" }, null, 2)}</pre>}
          {tab === "reports" && <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface/70 p-4 text-[11px] text-gray-400">{JSON.stringify(run.reports ?? [], null, 2)}</pre>}
        </div>
      </div>
    </div>
  );
}

// ── Dataset drawer ─────────────────────────────────────────────────────────────

function DatasetDrawer({
  dataset, runs, workflows, profile, online, onClose, onPulledToLocal,
}: {
  dataset: Record<string, unknown> & { id: number; remoteKey: string };
  runs: WorkspaceRun[];
  workflows: Array<Record<string, unknown> & { id: number; remoteKey: string }>;
  profile: WorkspaceProfile;
  online: boolean;
  onClose: () => void;
  onPulledToLocal: () => void;
}) {
  const desktop = window.neuroforgeDesktop!;
  const [pullMsg, setPullMsg] = useState<string | null>(null);

  async function pullToLocal() {
    setPullMsg(null);
    try {
      await desktop.pullToLocal({
        type: "project",
        data: { title: sv(dataset.name, `Dataset ${dataset.id}`), description: dataset.description ?? null },
      });
      setPullMsg("Pulled to local NeuroForge.");
      onPulledToLocal();
    } catch (err) {
      setPullMsg(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-sm" role="dialog">
      <div className="h-full w-full max-w-2xl overflow-y-auto border-l border-white/10 bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold text-white">{sv(dataset.name, `Dataset ${dataset.id}`)}</h2>
              <Badge tone="cloud">Cloud</Badge>
            </div>
            <p className="mt-1 text-sm text-gray-400">{profile.name} · Dataset #{dataset.id}</p>
          </div>
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <MetricCard label="Runs" value={runs.length} />
          <MetricCard label="Workflows" value={workflows.length} />
          <MetricCard label="Validation" value={sv(dataset.validation_status, "Unknown")} />
        </div>

        {online && (
          <div className="mt-4 flex items-center gap-3">
            <SecondaryButton onClick={() => void pullToLocal()}>Pull to local</SecondaryButton>
            {pullMsg && <p className="text-xs text-gray-400">{pullMsg}</p>}
          </div>
        )}

        {runs.length > 0 && (
          <section className="mt-6">
            <h3 className="text-sm font-semibold text-white mb-3">Runs</h3>
            <div className="space-y-2">
              {runs.map((run) => (
                <div key={run.remoteKey} className="rounded-lg border border-white/8 bg-surface-raised px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-mono text-xs text-accent">Run #{run.id}</span>
                      <span className="ml-2 text-sm text-gray-200">{run.pipeline_manifest_id}</span>
                    </div>
                    <Badge tone={run.status === "success" ? "success" : run.status === "failed" ? "danger" : "warning"}>
                      {run.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[10px] text-gray-500">{run.artifacts.length} artifacts · {cacheLabel(run.cacheState)}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ── Local workspace view ────────────────────────────────────────────────────────

function LocalWorkspaceView({
  view, data, workspaceId, cloud,
}: {
  view: WorkspaceView; data: LocalWorkspaceData; workspaceId: string; cloud?: WorkspaceSnapshot | null;
}) {
  if (cloud && view === "runs") {
    const combined = combineWorkspaceRuns(data, workspaceId, cloud);
    return (
      <section className="mt-6">
        <h2 className="text-lg font-semibold text-white">All Workspaces · Runs</h2>
        <p className="mt-1 text-xs text-gray-500">Local and cloud IDs remain separate.</p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {combined.map((run) => (
            <Link key={run.key} to={run.local ? `/runs/${run.id}` : `/workspaces?scope=cloud&view=runs`}
              className="rounded-xl border border-white/8 bg-surface-raised p-4">
              <div className="flex justify-between">
                <span className="font-mono text-sm text-accent">Run #{run.id}</span>
                <Badge tone={run.local ? "success" : "cloud"}>{run.workspace}</Badge>
              </div>
              <p className="mt-2 text-sm capitalize text-white">{run.pipeline}</p>
              <p className="mt-1 text-xs text-gray-500">{run.status}</p>
            </Link>
          ))}
        </div>
      </section>
    );
  }

  if (view === "home") return (
    <div className="mt-6 space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="Projects" value={data.projects.length} />
        <MetricCard label="Datasets" value={data.datasets.length} />
        <MetricCard label="Workflows" value={data.workflows.length} />
        <MetricCard label="Runs" value={data.runs.length} />
        <MetricCard label="Reports" value={data.reports.length} />
      </div>
      <Card className="border-emerald-400/15 bg-emerald-400/5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Local NeuroForge</h2>
            <p className="mt-1 text-sm text-emerald-300">Local · Available offline</p>
          </div>
          <Badge tone="success">Available offline</Badge>
        </div>
        <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
          <div><dt className="text-gray-500">Workspace identity</dt><dd className="mt-1 break-all font-mono text-gray-300">{workspaceId}</dd></div>
          <div><dt className="text-gray-500">Storage</dt><dd className="mt-1 text-gray-300">Local API and scientific database</dd></div>
        </dl>
      </Card>
    </div>
  );

  if (view === "projects") return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold text-white">Local Projects</h2>
      {data.projects.length === 0
        ? <EmptyState title="No local projects" />
        : <div className="mt-4 grid gap-3">
          {data.projects.map((item) => (
            <Link key={item.id} to={`/projects/${item.id}`} className="rounded-lg border border-white/8 bg-surface-raised p-4">
              <div className="flex justify-between">
                <span className="text-white">{sv(item.title ?? item.name, `Project ${item.id}`)}</span>
                <Badge tone="success">Local</Badge>
              </div>
            </Link>
          ))}
        </div>}
    </section>
  );

  if (view === "datasets") return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold text-white">Local Datasets</h2>
      {data.datasets.length === 0
        ? <EmptyState title="No local datasets" />
        : <div className="mt-4 grid gap-3 md:grid-cols-2">
          {data.datasets.map((item) => (
            <Link key={item.id} to={`/datasets/${item.id}`} className="rounded-lg border border-white/8 bg-surface-raised p-4">
              <div className="flex justify-between">
                <span className="text-white">{sv(item.name, `Dataset ${item.id}`)}</span>
                <Badge tone="success">Local</Badge>
              </div>
            </Link>
          ))}
        </div>}
    </section>
  );

  if (view === "workflows") return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold text-white">Local Saved Workflows</h2>
      <p className="mt-2 text-sm text-gray-400">{data.workflows.length} saved workflows.</p>
      <Link to="/workflows/library" className="mt-4 inline-flex rounded border border-white/10 px-3 py-2 text-xs text-accent">
        Open workflow library
      </Link>
    </section>
  );

  if (view === "runs") return (
    <section className="mt-6">
      <div className="flex justify-between">
        <h2 className="text-lg font-semibold text-white">Local Runs</h2>
        <Badge tone="success">Local · {data.runs.length}</Badge>
      </div>
      {data.runs.length === 0
        ? <EmptyState title="No local runs" />
        : <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {data.runs.map((run) => (
            <Link key={run.id} to={`/runs/${run.id}`} className="rounded-xl border border-white/8 bg-surface-raised p-4">
              <div className="flex justify-between">
                <span className="font-mono text-accent">Run #{run.id}</span>
                <Badge tone="success">Local</Badge>
              </div>
              <p className="mt-2 text-sm capitalize text-white">{sv(run.pipeline_manifest_id)}</p>
              <p className="mt-1 text-xs text-gray-500">{sv(run.status)}</p>
            </Link>
          ))}
        </div>}
    </section>
  );

  if (view === "reports") return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold text-white">Local Reports</h2>
      <div className="mt-4 grid gap-3">
        {data.reports.map((report) => (
          <Link key={report.id} to={`/datasets/${report.dataset_id}/reports/${report.id}`} className="rounded-lg border border-white/8 bg-surface-raised p-4 text-sm text-white">
            Report #{report.id} · Dataset #{report.dataset_id}
          </Link>
        ))}
      </div>
    </section>
  );

  return null;
}

// ── Workflow nodes helper ────────────────────────────────────────────────────────

function workflowNodes(workflow: Record<string, unknown>): Array<{ id: string; pipelineId: string }> {
  const nodes = (workflow.state as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((n, i) => {
    const v = n as { id?: unknown; pipelineId?: unknown };
    return typeof v.pipelineId === "string"
      ? [{ id: typeof v.id === "string" ? v.id : `${v.pipelineId}-${i}`, pipelineId: v.pipelineId }]
      : [];
  });
}
