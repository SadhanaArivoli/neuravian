/**
 * ExecutionEnvironmentManager
 *
 * Orchestrates the full lifecycle of an execution environment:
 *   start → poll until running → resolve new IP → save profile → verify HTTPS → ready
 *   (and in reverse: fence → stop → offline)
 *
 * This sits between the IPC layer and the provider-level AWS CLI calls.
 * It knows about WorkspaceProfile and ConnectionProfileStore but remains
 * ignorant of pipeline details, artifact paths, and YAML manifests.
 *
 * Architecture position:
 *   IPC handler
 *     └── ExecutionEnvironmentManager   ← this file
 *           ├── resolveEc2State / startEc2Instance / stopEc2Instance
 *           └── WorkspaceReplicationEngine (for fence)
 */

import { resolveEc2State, startEc2Instance, stopEc2Instance } from "./workspace-client.js";
import type { WorkspaceReplicationEngine } from "./workspace-replication.js";
import type { ConnectionProfileStore } from "./connection-profiles.js";
import type { WorkspaceCredential, WorkspaceProfile } from "./workspace-types.js";

export interface EnvironmentReadyResult {
  profile: WorkspaceProfile;
  workspaceId: string | null;
  elapsedMs: number;
}

export interface EnvironmentStopResult {
  stopped: boolean;
  fenceResult: {
    artifactsPulled: string[];
    errors: string[];
    fenceComplete: boolean;
  } | null;
}

export interface LaunchEnvironmentOptions {
  /** How long to wait for the instance to reach "running" state (default: 3 minutes). */
  startTimeoutMs?: number;
  /** Poll interval while waiting for "running" (default: 8 seconds). */
  pollIntervalMs?: number;
  /** How long to wait for the NeuroForge server to become reachable (default: 90 seconds). */
  serverReadyTimeoutMs?: number;
}

const DEFAULT_START_TIMEOUT_MS = 3 * 60 * 1000;  // 3 min — EC2 cold start is typically ~60s
const DEFAULT_POLL_INTERVAL_MS = 8_000;
const DEFAULT_SERVER_READY_TIMEOUT_MS = 90_000;

export class ExecutionEnvironmentManager {
  constructor(
    private readonly profiles: ConnectionProfileStore,
    private readonly wre: WorkspaceReplicationEngine,
  ) {}

  /**
   * Full environment startup sequence:
   * 1. Issue start-instances (no-op if already running)
   * 2. Poll describe-instances until state === "running"
   * 3. Resolve new public IP → rebuild serverUrl → save profile
   * 4. Poll GET /api/about until the server responds with 200
   * 5. Return the updated profile — caller can sync immediately
   */
  async launch(
    profileId: string,
    credential: WorkspaceCredential | null,
    options: LaunchEnvironmentOptions = {},
  ): Promise<EnvironmentReadyResult> {
    const startedAt = Date.now();
    const {
      startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
      serverReadyTimeoutMs = DEFAULT_SERVER_READY_TIMEOUT_MS,
    } = options;

    let profile = await this._getProfile(profileId);

    // ── Step 1: Start the instance (idempotent if already running) ─────────────
    const initialHealth = await resolveEc2State(profile);
    if (initialHealth.instanceState !== "running") {
      await startEc2Instance(profile);
    }

    // ── Step 2: Poll until running ────────────────────────────────────────────
    profile = await this._pollUntilRunning(profile, startTimeoutMs, pollIntervalMs);

    // ── Step 3: Save updated serverUrl (new IP after restart) ─────────────────
    profile = await this._resolveAndSaveUrl(profile);

    // ── Step 4: Poll until the NeuroForge server is reachable ─────────────────
    await this._pollUntilServerReady(profile, credential, serverReadyTimeoutMs, pollIntervalMs);

    const workspaceId = await this._fetchWorkspaceId(profile, credential);
    return { profile, workspaceId, elapsedMs: Date.now() - startedAt };
  }

  /**
   * Full environment stop sequence:
   * 1. Run the shutdown fence (pull all uncached artifacts)
   * 2. Issue stop-instances
   * 3. Mark profile as offline
   */
  async stop(
    profileId: string,
    credential: WorkspaceCredential | null,
    workspaceId: string | null,
  ): Promise<EnvironmentStopResult> {
    const profile = await this._getProfile(profileId);

    let fenceResult: EnvironmentStopResult["fenceResult"] = null;
    if (workspaceId) {
      fenceResult = await this.wre.shutdownFence(profile, credential, workspaceId);
    }

    await stopEc2Instance(profile);
    return { stopped: true, fenceResult };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _getProfile(profileId: string): Promise<WorkspaceProfile> {
    const all = await this.profiles.list();
    const profile = all.find((p) => p.id === profileId);
    if (!profile) throw new Error(`Workspace profile '${profileId}' not found.`);
    if (profile.connectionMode !== "instance-id") {
      throw new Error("ExecutionEnvironmentManager only manages instance-id workspaces.");
    }
    return profile;
  }

  private async _pollUntilRunning(
    profile: WorkspaceProfile,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<WorkspaceProfile> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const health = await resolveEc2State(profile);
      if (health.instanceState === "running" && health.publicIp) {
        return profile;
      }
      if (health.instanceState === "terminated" || health.instanceState === "shutting-down") {
        throw new Error(`EC2 instance entered terminal state '${health.instanceState}' during startup.`);
      }
      await sleep(intervalMs);
    }
    throw new Error(`EC2 instance did not reach 'running' state within ${timeoutMs / 1000}s.`);
  }

  private async _resolveAndSaveUrl(profile: WorkspaceProfile): Promise<WorkspaceProfile> {
    const health = await resolveEc2State(profile);
    if (!health.resolvedServerUrl) return profile;
    if (health.resolvedServerUrl === profile.serverUrl) return profile;
    const updated: WorkspaceProfile = {
      ...profile,
      serverUrl: health.resolvedServerUrl,
      serverIdentity: null, // force re-verification on next connect
    };
    await this.profiles.update(updated);
    return updated;
  }

  private async _pollUntilServerReady(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const authHeader = credential
      ? `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`
      : null;
    const headers: Record<string, string> = authHeader ? { Authorization: authHeader } : {};

    while (Date.now() < deadline) {
      try {
        const url = new URL("/api/about", `${profile.serverUrl}/`).toString();
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
        if (resp.ok) return;
      } catch {
        // Connection refused or timeout — instance is still booting
      }
      await sleep(intervalMs);
    }
    throw new Error(`NeuroForge server did not become reachable within ${timeoutMs / 1000}s.`);
  }

  private async _fetchWorkspaceId(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
  ): Promise<string | null> {
    try {
      const authHeader = credential
        ? `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`
        : null;
      const headers: Record<string, string> = authHeader ? { Authorization: authHeader } : {};
      const url = new URL("/api/workspace/identity", `${profile.serverUrl}/`).toString();
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
      if (!resp.ok) return null;
      const body = await resp.json() as { workspace_id?: string };
      return body.workspace_id ?? null;
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
