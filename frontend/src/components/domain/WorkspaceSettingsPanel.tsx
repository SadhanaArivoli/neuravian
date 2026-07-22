import { FormEvent, useEffect, useState } from "react";
import {
  Badge, Card, CardHeader, ConfirmAction, Drawer, FormField,
  InfoBanner, MetricCard, PrimaryButton, SecondaryButton, TabBar,
} from "../primitives/index";

type SettingsTab = "general" | "connection" | "authentication" | "cache" | "viewers" | "synchronization" | "danger";

const TABS: readonly SettingsTab[] = [
  "general", "connection", "authentication", "cache", "viewers", "synchronization", "danger",
];

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

interface Props {
  profile: WorkspaceProfile;
  workspaceId: string | null;
  inspection: WorkspaceInspection | null;
  online: boolean;
  ec2Health?: Ec2ConnectionHealth | null;
  onClose: () => void;
  onUpdated: (profile: WorkspaceProfile) => void;
  onRemoved: () => void;
}

function ec2StateTone(s: Ec2InstanceState | "unknown"): "success" | "warning" | "danger" {
  if (s === "running") return "success";
  if (s === "pending") return "warning";
  if (s === "stopped" || s === "stopping" || s === "terminated") return "danger";
  return "warning";
}

export function WorkspaceSettingsPanel({
  profile, workspaceId, inspection, online, ec2Health, onClose, onUpdated, onRemoved,
}: Props) {
  const desktop = window.neuravianDesktop!;
  const [tab, setTab] = useState<SettingsTab>("general");

  // General
  const [name, setName] = useState(profile.name);
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [generalMsg, setGeneralMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Connection
  const [serverUrl, setServerUrl] = useState(profile.serverUrl);
  const [connectionMode, setConnectionMode] = useState<"url" | "instance-id">(profile.connectionMode ?? "url");
  const [instanceId, setInstanceId] = useState(profile.instanceId ?? "");
  const [awsRegion, setAwsRegion] = useState(profile.awsRegion ?? "");
  const [savingConnection, setSavingConnection] = useState(false);
  const [connectionMsg, setConnectionMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [resolvingIp, setResolvingIp] = useState(false);

  // Auth
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [savingAuth, setSavingAuth] = useState(false);
  const [authMsg, setAuthMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Viewers
  const [viewerMsg, setViewerMsg] = useState<string | null>(null);
  const [locating, setLocating] = useState<"freeview" | "mricrogl" | null>(null);

  // Sync
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Shutdown fence (manual trigger, sync tab)
  const [fencing, setFencing] = useState(false);
  const [fenceResult, setFenceResult] = useState<{
    artifactsPulled: string[];
    errors: string[];
    fenceComplete: boolean;
  } | null>(null);

  // EC2 lifecycle (connection tab)
  const [startingVm, setStartingVm] = useState(false);
  const [stoppingVm, setStoppingVm] = useState(false);
  const [vmLifecycleMsg, setVmLifecycleMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Danger
  const [dangerMsg, setDangerMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Reset form when profile changes
  useEffect(() => {
    setName(profile.name);
    setServerUrl(profile.serverUrl);
    setConnectionMode(profile.connectionMode ?? "url");
    setInstanceId(profile.instanceId ?? "");
    setAwsRegion(profile.awsRegion ?? "");
    setUsername("");
    setPassword("");
  }, [profile.id]);

  async function saveGeneral(e: FormEvent) {
    e.preventDefault();
    setSavingGeneral(true);
    setGeneralMsg(null);
    try {
      const updated = await desktop.saveWorkspace({ id: profile.id, name, serverUrl: profile.serverUrl });
      onUpdated(updated);
      setGeneralMsg({ ok: true, text: "Saved." });
    } catch (err) {
      setGeneralMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingGeneral(false);
    }
  }

  async function saveConnection(e: FormEvent) {
    e.preventDefault();
    setSavingConnection(true);
    setConnectionMsg(null);
    try {
      const updated = await desktop.saveWorkspace({
        id: profile.id,
        name: profile.name,
        serverUrl,
        connectionMode,
        instanceId: instanceId || null,
        awsRegion: awsRegion || null,
      });
      onUpdated(updated);
      setConnectionMsg({ ok: true, text: "Connection settings saved." });
    } catch (err) {
      setConnectionMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingConnection(false);
    }
  }

  async function resolveIp() {
    setResolvingIp(true);
    setConnectionMsg(null);
    try {
      const updated = await desktop.resolveInstanceUrl(profile.id);
      if (updated) {
        onUpdated(updated);
        setServerUrl(updated.serverUrl);
        setConnectionMsg({ ok: true, text: `Resolved: ${updated.serverUrl}` });
      } else {
        setConnectionMsg({ ok: false, text: "Could not resolve EC2 IP. Check instance ID, region, and AWS CLI credentials." });
      }
    } catch (err) {
      setConnectionMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setResolvingIp(false);
    }
  }

  async function saveAuth(e: FormEvent) {
    e.preventDefault();
    setSavingAuth(true);
    setAuthMsg(null);
    try {
      const updated = await desktop.saveWorkspace({
        id: profile.id, name: profile.name, serverUrl: profile.serverUrl,
        username, password,
      });
      onUpdated(updated);
      setUsername("");
      setPassword("");
      setAuthMsg({ ok: true, text: "Credentials saved in OS keychain." });
    } catch (err) {
      setAuthMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingAuth(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await desktop.testWorkspace(profile.id);
      setTestResult(`Connected · Neuravian ${result.serverVersion} · API ${result.apiVersion}`);
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  async function locateViewer(viewerId: "freeview" | "mricrogl") {
    setLocating(viewerId);
    setViewerMsg(null);
    try {
      const chosen = await desktop.browseForViewer(viewerId);
      if (!chosen) return;
      await desktop.saveViewerConfig({ viewerId, executablePath: chosen });
      setViewerMsg(`${viewerId === "freeview" ? "FreeView" : "MRIcroGL"} path saved.`);
    } catch (err) {
      setViewerMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLocating(null);
    }
  }

  async function clearViewerPath(viewerId: "freeview" | "mricrogl") {
    await desktop.saveViewerConfig({ viewerId, executablePath: null });
    setViewerMsg(`${viewerId} custom path cleared — detection will restart on next sync.`);
  }

  async function startVm() {
    setStartingVm(true);
    setVmLifecycleMsg(null);
    try {
      // launchEnvironment waits for the instance to be running AND the server
      // to be reachable before returning — no polling needed in the UI.
      const result = await desktop.launchEnvironment({ profileId: profile.id });
      onUpdated(result.profile);
      setVmLifecycleMsg({
        ok: true,
        text: `Instance ready in ${(result.elapsedMs / 1000).toFixed(0)}s. Syncing workspace…`,
      });
      void forceSyncNow();
    } catch (err) {
      setVmLifecycleMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setStartingVm(false);
    }
  }

  async function stopVm() {
    setStoppingVm(true);
    setVmLifecycleMsg(null);
    try {
      const result = await desktop.stopEnvironment({
        profileId: profile.id,
        workspaceId: workspaceId ?? undefined,
        runFence: !!workspaceId,
      });
      const pulled = result.fenceResult?.artifactsPulled.length ?? 0;
      const errors = result.fenceResult?.errors.length ?? 0;
      if (errors > 0) {
        setVmLifecycleMsg({ ok: false, text: `Instance stopped, but ${errors} artifact${errors !== 1 ? "s" : ""} could not be synced. Check the Synchronization tab.` });
      } else {
        setVmLifecycleMsg({
          ok: true,
          text: pulled > 0
            ? `Instance stopped. ${pulled} artifact${pulled !== 1 ? "s" : ""} saved locally.`
            : "Instance stopped. All artifacts were already cached locally.",
        });
      }
    } catch (err) {
      setVmLifecycleMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setStoppingVm(false);
    }
  }

  async function stopAndSync() {
    if (!workspaceId) return;
    setFencing(true);
    setFenceResult(null);
    try {
      const result = await desktop.shutdownFence({ profileId: profile.id, workspaceId });
      setFenceResult(result);
    } catch (err) {
      setFenceResult({
        artifactsPulled: [],
        errors: [err instanceof Error ? err.message : String(err)],
        fenceComplete: false,
      });
    } finally {
      setFencing(false);
    }
  }

  async function forceSyncNow() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      await desktop.syncWorkspace(profile.id);
      setSyncMsg("Synchronization complete.");
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function resetCache() {
    if (!workspaceId) return;
    setDangerMsg(null);
    try {
      await desktop.resetWorkspaceCache(workspaceId);
      setDangerMsg({ ok: true, text: "Artifact cache cleared." });
    } catch (err) {
      setDangerMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function clearCredentials() {
    setDangerMsg(null);
    try {
      await desktop.clearWorkspaceCredentials(profile.id);
      onUpdated({ ...profile, authenticationRef: null });
      setDangerMsg({ ok: true, text: "Credentials removed from OS keychain." });
    } catch (err) {
      setDangerMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function deleteWorkspace() {
    setDangerMsg(null);
    try {
      await desktop.removeWorkspace(profile.id);
      onRemoved();
    } catch (err) {
      setDangerMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  }

  const inputCls = "w-full rounded border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-cyan-400/50 focus:outline-none";

  return (
    <Drawer
      title="Workspace Settings"
      subtitle={profile.name}
      onClose={onClose}
      width="max-w-2xl"
    >
      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      <div className="mt-6 space-y-5">

        {/* General */}
        {tab === "general" && (
          <form onSubmit={(e) => void saveGeneral(e)} className="space-y-4">
            <Card>
              <CardHeader title="Display name" subtitle="How this workspace appears in the sidebar" />
              <div className="mt-4 space-y-3">
                <FormField label="Workspace name">
                  <input
                    required value={name} onChange={(e) => setName(e.target.value)}
                    className={inputCls}
                  />
                </FormField>
                <div className="flex items-center gap-3">
                  <PrimaryButton type="submit" disabled={savingGeneral}>
                    {savingGeneral ? "Saving…" : "Save name"}
                  </PrimaryButton>
                  {generalMsg && (
                    <span className={`text-xs ${generalMsg.ok ? "text-emerald-300" : "text-red-400"}`}>
                      {generalMsg.text}
                    </span>
                  )}
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Workspace identity" />
              <dl className="mt-4 space-y-3 text-xs">
                <div>
                  <dt className="text-slate-500">Profile ID</dt>
                  <dd className="mt-1 break-all font-mono text-slate-300">{profile.id}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Server identity (UUID)</dt>
                  <dd className="mt-1 break-all font-mono text-slate-300">{profile.serverIdentity ?? "Not yet connected"}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Last synchronization</dt>
                  <dd className="mt-1 text-slate-300">{relativeTime(profile.lastSync)}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Connection state</dt>
                  <dd className="mt-1"><Badge tone={profile.connectionState === "connected" ? "success" : "warning"}>{profile.connectionState}</Badge></dd>
                </div>
              </dl>
            </Card>
          </form>
        )}

        {/* Connection */}
        {tab === "connection" && (
          <form onSubmit={(e) => void saveConnection(e)} className="space-y-4">
            <Card>
              <CardHeader title="Connection mode" subtitle="How Neuravian locates this server" />
              <div className="mt-4 space-y-4">
                <FormField label="Mode">
                  <select
                    value={connectionMode}
                    onChange={(e) => setConnectionMode(e.target.value as "url" | "instance-id")}
                    className={inputCls}
                  >
                    <option value="url">Static HTTPS URL</option>
                    <option value="instance-id">EC2 Instance ID (auto-resolves IP on reconnect)</option>
                  </select>
                </FormField>

                {connectionMode === "url" && (
                  <FormField label="Server URL" hint="Must be HTTPS (HTTP allowed only for loopback)">
                    <input
                      required type="url" value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      className={inputCls}
                      placeholder="https://your-server.example.com"
                    />
                  </FormField>
                )}

                {connectionMode === "instance-id" && (
                  <>
                    <FormField label="EC2 Instance ID" hint="e.g. i-0abc123def456789">
                      <input
                        required value={instanceId} onChange={(e) => setInstanceId(e.target.value)}
                        className={inputCls} placeholder="i-0abc123def456789"
                      />
                    </FormField>
                    <FormField label="AWS Region" hint="e.g. us-east-1">
                      <input
                        required value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)}
                        className={inputCls} placeholder="us-east-1"
                      />
                    </FormField>
                    <FormField label="Server port and path" hint="Used to reconstruct the URL after IP resolution">
                      <input
                        value={serverUrl} onChange={(e) => setServerUrl(e.target.value)}
                        className={inputCls} placeholder="https://PLACEHOLDER:8000"
                      />
                    </FormField>
                    <InfoBanner tone="info">
                      On each reconnect, Neuravian runs{" "}
                      <code className="font-mono">aws ec2 describe-instances</code> to find the current
                      public IP and updates the serverUrl automatically. AWS CLI must be configured
                      with appropriate credentials.
                    </InfoBanner>
                    <SecondaryButton onClick={() => void resolveIp()} disabled={resolvingIp}>
                      {resolvingIp ? "Resolving…" : "Resolve IP now"}
                    </SecondaryButton>

                    {ec2Health && (
                      <div className="mt-4 rounded-lg border border-white/8 bg-slate-950/60 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-white">EC2 Instance State</span>
                          <Badge tone={ec2StateTone(ec2Health.instanceState)}>
                            {ec2Health.instanceState}
                          </Badge>
                        </div>
                        <dl className="grid gap-2 text-[11px] sm:grid-cols-2">
                          <div><dt className="text-slate-500">Instance ID</dt><dd className="mt-0.5 font-mono text-slate-300">{ec2Health.instanceId || "—"}</dd></div>
                          <div><dt className="text-slate-500">Region</dt><dd className="mt-0.5 font-mono text-slate-300">{ec2Health.region || "—"}</dd></div>
                          <div><dt className="text-slate-500">Public IP</dt><dd className="mt-0.5 font-mono text-slate-300">{ec2Health.publicIp ?? "—"}</dd></div>
                          <div><dt className="text-slate-500">Hostname</dt><dd className="mt-0.5 font-mono text-slate-300 truncate">{ec2Health.publicHostname ?? "—"}</dd></div>
                          <div className="sm:col-span-2"><dt className="text-slate-500">Resolved URL</dt><dd className="mt-0.5 break-all font-mono text-slate-300">{ec2Health.resolvedServerUrl ?? "—"}</dd></div>
                          <div><dt className="text-slate-500">Last checked</dt><dd className="mt-0.5 text-slate-400">{relativeTime(ec2Health.lastUpdated)}</dd></div>
                          <div><dt className="text-slate-500">AWS CLI</dt><dd className={`mt-0.5 ${ec2Health.awsCliAvailable ? "text-emerald-300" : "text-red-400"}`}>{ec2Health.awsCliAvailable ? "Available" : "Not found"}</dd></div>
                        </dl>
                        {ec2Health.error && (
                          <p className="rounded bg-red-900/30 px-3 py-2 text-[11px] text-red-300">{ec2Health.error}</p>
                        )}
                        {ec2Health.instanceState === "stopped" && (
                          <InfoBanner tone="warning" title="Instance is stopped">
                            Start the instance below. Neuravian will reconnect automatically once it is running.
                          </InfoBanner>
                        )}
                        {ec2Health.instanceState === "pending" && (
                          <InfoBanner tone="info" title="Instance is starting…">
                            Neuravian will reconnect automatically once the instance is running. This usually takes 1–2 minutes.
                          </InfoBanner>
                        )}
                        {ec2Health.instanceState === "stopping" && (
                          <InfoBanner tone="warning" title="Instance is stopping…">
                            The instance is shutting down.
                          </InfoBanner>
                        )}

                        {/* Lifecycle actions */}
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {(ec2Health.instanceState === "stopped" || ec2Health.instanceState === "unknown") && (
                            <PrimaryButton
                              onClick={() => void startVm()}
                              disabled={startingVm}
                            >
                              {startingVm ? "Waiting for instance…" : "Start instance"}
                            </PrimaryButton>
                          )}
                          {ec2Health.instanceState === "running" && (
                            <SecondaryButton
                              onClick={() => void stopVm()}
                              disabled={stoppingVm}
                            >
                              {stoppingVm ? "Stopping…" : "Stop instance"}
                            </SecondaryButton>
                          )}
                          {vmLifecycleMsg && (
                            <span className={`text-xs ${vmLifecycleMsg.ok ? "text-emerald-300" : "text-red-400"}`}>
                              {vmLifecycleMsg.text}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}

                <div className="flex items-center gap-3">
                  <PrimaryButton type="submit" disabled={savingConnection}>
                    {savingConnection ? "Saving…" : "Save connection"}
                  </PrimaryButton>
                  {connectionMsg && (
                    <span className={`text-xs ${connectionMsg.ok ? "text-emerald-300" : "text-red-400"}`}>
                      {connectionMsg.text}
                    </span>
                  )}
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="Current server URL" />
              <p className="mt-2 break-all font-mono text-xs text-slate-300">{profile.serverUrl}</p>
              <p className="mt-2 text-xs text-slate-500">
                {online ? "Reachable" : "Last known URL — may be stale if instance restarted"}
              </p>
            </Card>
          </form>
        )}

        {/* Authentication */}
        {tab === "authentication" && (
          <div className="space-y-4">
            <Card>
              <CardHeader
                title="OS keychain credential"
                subtitle={profile.authenticationRef
                  ? "A credential is stored in the OS keychain"
                  : "No credential stored"}
              >
                <Badge tone={profile.authenticationRef ? "success" : "warning"}>
                  {profile.authenticationRef ? "Stored" : "None"}
                </Badge>
              </CardHeader>
              <form onSubmit={(e) => void saveAuth(e)} className="mt-5 space-y-3">
                <FormField label="Username">
                  <input
                    required autoComplete="username" value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className={inputCls}
                  />
                </FormField>
                <FormField label="Password">
                  <input
                    required type="password" autoComplete="current-password" value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={inputCls}
                  />
                </FormField>
                <div className="flex items-center gap-3">
                  <PrimaryButton type="submit" disabled={savingAuth}>
                    {savingAuth ? "Saving…" : "Update credentials"}
                  </PrimaryButton>
                  {authMsg && (
                    <span className={`text-xs ${authMsg.ok ? "text-emerald-300" : "text-red-400"}`}>
                      {authMsg.text}
                    </span>
                  )}
                </div>
              </form>
            </Card>

            <Card>
              <CardHeader title="Test connection" subtitle="Verify current credentials against the server" />
              <div className="mt-4 flex items-center gap-3">
                <SecondaryButton onClick={() => void testConnection()} disabled={testing}>
                  {testing ? "Testing…" : "Test connection"}
                </SecondaryButton>
                {testResult && <p className="text-xs text-slate-300">{testResult}</p>}
              </div>
            </Card>
          </div>
        )}

        {/* Cache */}
        {tab === "cache" && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <MetricCard label="Cache size" value={formatBytes(inspection?.cacheSizeBytes ?? 0)} />
              <MetricCard label="Cached runs" value={inspection?.cachedRuns ?? 0} />
              <MetricCard label="Cache entries" value={inspection?.cacheEntries ?? 0} />
            </div>

            {(inspection?.legacyCacheEntries.length ?? 0) > 0 && (
              <InfoBanner tone="warning" title="Legacy cache entries detected">
                {inspection!.legacyCacheEntries.length} legacy run cache entries were found and are not
                managed by the current cache layer.
              </InfoBanner>
            )}

            <Card>
              <CardHeader title="Cache location" />
              <p className="mt-2 text-xs text-slate-400">
                Cached artifacts are stored locally in the Neuravian app data directory under{" "}
                <code className="font-mono text-slate-300">run-cache/{workspaceId ?? "…"}/</code>.
                Clearing the cache does not affect cloud data.
              </p>
            </Card>
          </div>
        )}

        {/* Viewers */}
        {tab === "viewers" && (
          <div className="space-y-4">
            {(["freeview", "mricrogl"] as const).map((viewerId) => {
              const viewer = inspection?.viewers.find((v) => v.viewerId === viewerId);
              const displayName = viewerId === "freeview" ? "FreeView" : "MRIcroGL";
              return (
                <Card key={viewerId}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-semibold text-white">{displayName}</h3>
                      <p className="mt-1 truncate text-[11px] text-slate-400">
                        {viewer?.executable ?? viewer?.reason ?? "Detection pending"}
                      </p>
                    </div>
                    <Badge tone={viewer?.installed ? "success" : "warning"}>
                      {viewer?.installed ? "Detected" : "Not found"}
                    </Badge>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <SecondaryButton
                      onClick={() => void locateViewer(viewerId)}
                      disabled={locating !== null}
                    >
                      {locating === viewerId ? "Locating…" : "Locate executable…"}
                    </SecondaryButton>
                    {viewer?.installed && (
                      <SecondaryButton onClick={() => void clearViewerPath(viewerId)}>
                        Clear custom path
                      </SecondaryButton>
                    )}
                  </div>
                </Card>
              );
            })}
            {viewerMsg && <p className="text-xs text-slate-400">{viewerMsg}</p>}
          </div>
        )}

        {/* Synchronization */}
        {tab === "synchronization" && (
          <div className="space-y-4">
            <Card>
              <CardHeader title="Metadata synchronization" subtitle="Cloud → Local" />
              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Last sync</dt>
                  <dd className="mt-1 text-slate-300">{relativeTime(profile.lastSync)}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Status</dt>
                  <dd className="mt-1">
                    <Badge tone={online ? "success" : "warning"}>
                      {online ? "Connected" : "Offline"}
                    </Badge>
                  </dd>
                </div>
              </dl>
              <div className="mt-4 flex items-center gap-3">
                <SecondaryButton onClick={() => void forceSyncNow()} disabled={syncing || !online}>
                  {syncing ? "Syncing…" : "Sync now"}
                </SecondaryButton>
                {syncMsg && <p className="text-xs text-slate-400">{syncMsg}</p>}
              </div>
            </Card>

            {profile.connectionMode === "instance-id" && (
              <Card>
                <CardHeader
                  title="Auto Stop"
                  subtitle="Stop the EC2 instance automatically when a run finishes"
                />
                <p className="mt-3 text-xs text-slate-500">
                  When enabled, Neuravian will run the shutdown fence and stop the instance
                  automatically after every completed run — success or failure. You can restart
                  it any time from the Connection tab.
                </p>
                <div className="mt-4 flex items-center gap-3">
                  <label className="flex cursor-pointer items-center gap-2 select-none">
                    <input
                      type="checkbox"
                      checked={!!profile.autoStopAfterRun}
                      onChange={async (e) => {
                        try {
                          const updated = await desktop.setAutoStop({ profileId: profile.id, enabled: e.target.checked });
                          onUpdated(updated);
                        } catch { /* ignore */ }
                      }}
                      className="h-4 w-4 rounded border-white/20 bg-slate-900 accent-cyan-400"
                    />
                    <span className="text-xs text-slate-300">
                      {profile.autoStopAfterRun ? "Auto Stop enabled" : "Auto Stop disabled"}
                    </span>
                  </label>
                </div>
              </Card>
            )}

            <Card>
              <CardHeader
                title="Bidirectional sync"
                subtitle="Push or pull items between local and cloud"
              />
              <p className="mt-3 text-xs text-slate-500">
                Use the Projects and Workflows views to push individual items to the cloud, or pull
                cloud items to your local Neuravian instance.
              </p>
            </Card>

            {profile.connectionMode === "instance-id" && (
              <Card>
                <CardHeader
                  title="Manual artifact sync"
                  subtitle="Pull all run artifacts without stopping the instance"
                />
                <p className="mt-3 text-xs text-slate-500">
                  Syncs all completed run artifacts to your local machine. Use this if you need
                  artifacts cached locally without stopping the instance. To stop the instance,
                  use the <strong className="text-slate-300">Connection</strong> tab — Neuravian
                  will sync artifacts and stop the VM automatically.
                </p>

                {fenceResult && (
                  <div className={`mt-3 rounded-lg border px-4 py-3 text-xs space-y-1 ${
                    fenceResult.fenceComplete
                      ? "border-emerald-500/30 bg-emerald-900/20"
                      : "border-amber-500/30 bg-amber-900/20"
                  }`}>
                    <p className={`font-semibold ${fenceResult.fenceComplete ? "text-emerald-300" : "text-amber-300"}`}>
                      {fenceResult.fenceComplete
                        ? "All artifacts saved locally — safe to stop the instance."
                        : "Sync completed with errors — review before stopping."}
                    </p>
                    {fenceResult.artifactsPulled.length > 0 && (
                      <p className="text-slate-400">
                        {fenceResult.artifactsPulled.length} artifact{fenceResult.artifactsPulled.length !== 1 ? "s" : ""} downloaded.
                      </p>
                    )}
                    {fenceResult.artifactsPulled.length === 0 && fenceResult.fenceComplete && (
                      <p className="text-slate-400">All artifacts were already cached locally.</p>
                    )}
                    {fenceResult.errors.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-red-400">
                        {fenceResult.errors.map((e, i) => (
                          <li key={i}>• {e}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <div className="mt-4 flex items-center gap-3">
                  <SecondaryButton
                    onClick={() => void stopAndSync()}
                    disabled={fencing || !online || !workspaceId}
                  >
                    {fencing ? "Syncing artifacts…" : "Sync all artifacts now"}
                  </SecondaryButton>
                  {fencing && (
                    <p className="text-xs text-slate-400">Pulling all run artifacts — please wait…</p>
                  )}
                  {!online && !fencing && (
                    <p className="text-xs text-slate-500">Workspace must be online to run the fence.</p>
                  )}
                </div>
              </Card>
            )}
          </div>
        )}

        {/* Danger Zone */}
        {tab === "danger" && (
          <div className="space-y-4">
            <InfoBanner tone="danger" title="Danger Zone">
              These actions cannot be undone. Read each description carefully.
            </InfoBanner>

            <Card>
              <h3 className="text-sm font-semibold text-white">Reconnect</h3>
              <p className="mt-1 text-xs text-slate-500">
                Force a fresh synchronization and re-establish the server connection.
              </p>
              <div className="mt-3">
                <SecondaryButton onClick={() => void forceSyncNow()} disabled={syncing}>
                  {syncing ? "Reconnecting…" : "Reconnect"}
                </SecondaryButton>
              </div>
            </Card>

            <Card>
              <h3 className="text-sm font-semibold text-white">Clear credentials</h3>
              <p className="mt-1 text-xs text-slate-500">
                Remove stored username and password from the OS keychain. You will need to re-enter
                credentials to synchronize.
              </p>
              <div className="mt-3">
                <ConfirmAction
                  label="This removes the saved password from the OS keychain."
                  confirmLabel="Clear credentials"
                  onConfirm={() => void clearCredentials()}
                />
              </div>
            </Card>

            <Card>
              <h3 className="text-sm font-semibold text-white">Reset artifact cache</h3>
              <p className="mt-1 text-xs text-slate-500">
                Delete all locally cached artifacts for this workspace. Cloud metadata is preserved.
                Files must be re-downloaded from the cloud to use local viewers.
              </p>
              <div className="mt-3">
                <ConfirmAction
                  label={`This deletes all locally cached files for ${profile.name}.`}
                  confirmLabel="Reset cache"
                  onConfirm={() => void resetCache()}
                />
              </div>
            </Card>

            <Card className="border-red-400/20">
              <h3 className="text-sm font-semibold text-red-300">Delete workspace</h3>
              <p className="mt-1 text-xs text-slate-500">
                Remove this workspace profile and all locally stored metadata. Cloud data is not
                affected. This action cannot be undone.
              </p>
              <div className="mt-3">
                <ConfirmAction
                  label={`This permanently removes "${profile.name}" from Neuravian Desktop.`}
                  confirmLabel="Delete workspace"
                  tone="danger"
                  onConfirm={() => void deleteWorkspace()}
                />
              </div>
            </Card>

            {dangerMsg && (
              <p className={`text-xs ${dangerMsg.ok ? "text-emerald-300" : "text-red-400"}`}>
                {dangerMsg.text}
              </p>
            )}
          </div>
        )}
      </div>
    </Drawer>
  );
}
