/**
 * WorkspaceReplicationEngine (WRE)
 *
 * Single source of truth for every synchronization operation in NeuroForge.
 * All push, pull, artifact download, and shutdown-fence operations flow
 * through this class — nowhere else.
 *
 * Dependency diagram (what WRE knows about vs. what is opaque to it):
 *
 *   WorkspaceReplicationEngine
 *     ├── knows:  WorkspaceProfile (serverUrl, auth)
 *     ├── knows:  WorkspaceClient.synchronize()   ← metadata snapshot pull
 *     ├── knows:  syncRun() / inspectRunCache()   ← artifact download (run-cache.ts)
 *     ├── knows:  WREEvent bus                    ← fires events, never polls
 *     └── opaque: ExecutionEnvironmentType        ← never reads providerConfig
 *                 pipeline manifest ids           ← never reads YAML files
 *                 TransportRef.location           ← never interprets storage paths
 *
 * The WRE does NOT know about:
 *   - EC2, AWS, Azure, GCP, Slurm — those live in provider plugins
 *   - Caddy, sslip.io, IP resolution — those live in WorkspaceInfrastructure
 *   - Pipeline-specific artifact paths — those come from ArtifactManifest objects
 *   - The local backend (localhost:8000) — that is a separate concern
 */

import path from "node:path";
import { createHash } from "node:crypto";
import {
  inspectRunCache,
  syncRun,
  type SyncManifest,
  type SyncResult,
} from "./run-cache.js";
import {
  type NeuroForgeObject,
  type NeuroForgeObjectType,
  type ReplicationSnapshot,
  type WREEvent,
  isNeuroForgeObject,
} from "./workspace-types.js";
import type { WorkspaceClient } from "./workspace-client.js";
import type { WorkspaceCredential, WorkspaceProfile } from "./workspace-types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WREConfig {
  artifactCacheRoot: string;
  client: WorkspaceClient;
  fetcher?: typeof fetch;
}

export interface PushResult {
  pushed: string[];
  skipped: string[];
  errors: Array<{ objectId: string; error: string }>;
}

export interface ShutdownFenceResult {
  artifactsPulled: string[];
  errors: string[];
  fenceComplete: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function authorization(credential: WorkspaceCredential | null): string | null {
  if (!credential) return null;
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
}

function authedHeaders(credential: WorkspaceCredential | null): Record<string, string> {
  const auth = authorization(credential);
  return {
    "Content-Type": "application/json",
    ...(auth ? { Authorization: auth } : {}),
  };
}

function replicationUrl(serverUrl: string, path: string): string {
  return new URL(path.replace(/^\//, ""), `${serverUrl}/`).toString();
}

/** SHA256 of the canonical JSON serialization of a payload. */
function contentHash(payload: unknown): string {
  const canonical = JSON.stringify(payload, Object.keys(payload as object).sort(), undefined);
  return createHash("sha256").update(canonical).digest("hex");
}

// ── WorkspaceReplicationEngine ────────────────────────────────────────────────

export class WorkspaceReplicationEngine {
  private readonly eventListeners: Array<(event: WREEvent) => void> = [];

  constructor(private readonly config: WREConfig) {}

  // ── Event bus ──────────────────────────────────────────────────────────────

  on(listener: (event: WREEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx !== -1) this.eventListeners.splice(idx, 1);
    };
  }

  private emit(event: WREEvent): void {
    for (const listener of this.eventListeners) {
      try { listener(event); } catch { /* listener errors must not block replication */ }
    }
  }

  // ── Metadata snapshot (cloud → desktop) ───────────────────────────────────
  // This delegates entirely to WorkspaceClient.synchronize(). The WRE fires
  // an event after each successful sync so downstream subscribers can react.

  async synchronize(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
  ): ReturnType<WorkspaceClient["synchronize"]> {
    const result = await this.config.client.synchronize(profile, credential);
    if (result.online) {
      this.emit({ type: "workspace:snapshot-ready", workspaceId: result.snapshot.workspaceId, snapshot: result.snapshot });
      // Emit status-changed for any runs whose status may have changed.
      for (const run of result.snapshot.runs) {
        this.emit({
          type: "run:status-changed",
          runObjectId: run.remoteKey,
          status: run.status,
          workspaceId: result.snapshot.workspaceId,
        });
      }
    }
    return result;
  }

  // ── Object push (desktop → cloud) ─────────────────────────────────────────
  // Replaces workspaces:push-project and workspaces:push-workflow.
  // Handles upsert: compares against cloud snapshot before deciding to push.
  // Does not know what objectType means — it is opaque below this layer.

  async pushObjects(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
    objects: NeuroForgeObject[],
  ): Promise<PushResult> {
    const result: PushResult = { pushed: [], skipped: [], errors: [] };
    if (objects.length === 0) return result;

    // Fetch cloud snapshot to avoid re-pushing objects the cloud already has.
    let cloudSnapshot: ReplicationSnapshot | null = null;
    try {
      const snapshotUrl = replicationUrl(profile.serverUrl, "/api/replication/snapshot");
      const resp = await (this.config.fetcher ?? fetch)(snapshotUrl, {
        headers: authedHeaders(credential),
      });
      if (resp.ok) cloudSnapshot = await resp.json() as ReplicationSnapshot;
    } catch {
      // If snapshot fails, push all objects unconditionally.
    }

    const cloudRevisions = new Map(
      cloudSnapshot?.objects.map((o) => [o.objectId, o]) ?? [],
    );

    for (const obj of objects) {
      const cloud = cloudRevisions.get(obj.objectId);
      if (cloud && cloud.revision >= obj.revision && cloud.contentHash === obj.contentHash) {
        result.skipped.push(obj.objectId);
        continue;
      }
      try {
        const url = replicationUrl(profile.serverUrl, `/api/replication/objects/${obj.objectId}`);
        const resp = await (this.config.fetcher ?? fetch)(url, {
          method: "PUT",
          headers: authedHeaders(credential),
          body: JSON.stringify(obj),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => resp.statusText);
          result.errors.push({ objectId: obj.objectId, error: `HTTP ${resp.status}: ${text}` });
        } else {
          result.pushed.push(obj.objectId);
          this.emit({ type: "workspace:connected", workspaceId: profile.serverIdentity ?? profile.id });
        }
      } catch (err) {
        result.errors.push({
          objectId: obj.objectId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  /**
   * Build a NeuroForgeObject from a plain payload.
   * The caller supplies the objectId (desktop-assigned UUID), objectType,
   * and current revision. The WRE computes the contentHash.
   */
  buildObject(
    objectId: string,
    objectType: NeuroForgeObjectType,
    revision: number,
    payload: unknown,
    timestamps?: { createdAt?: string; modifiedAt?: string },
  ): NeuroForgeObject {
    const now = new Date().toISOString();
    return {
      objectId,
      objectType,
      revision,
      contentHash: contentHash(payload),
      createdAt: timestamps?.createdAt ?? now,
      modifiedAt: timestamps?.modifiedAt ?? now,
      payload: payload as NeuroForgeObject["payload"],
    };
  }

  // ── Artifact download (cloud → desktop) ───────────────────────────────────
  // Delegates to run-cache.ts syncRun(). The WRE is the single caller for
  // artifact downloads — WorkspaceClient.synchronize() auto-sync also routes
  // through here via the event bus.

  async syncArtifacts(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
    workspaceId: string,
    runId: number,
    relativePaths: string[],
  ): Promise<SyncResult> {
    const fetcher = this._authedFetcher(credential);
    const manifest = await this._fetchManifest(profile, fetcher, runId);
    const requested = new Set(relativePaths);
    manifest.artifacts = manifest.artifacts
      .filter((a) => requested.has(a.relativePath))
      .map((a) => ({ ...a, url: new URL(a.url, `${profile.serverUrl}/`).toString() }));
    if (manifest.artifacts.length !== requested.size) {
      throw new Error("One or more requested artifacts are not in the run manifest.");
    }
    return await syncRun(path.join(this.config.artifactCacheRoot, workspaceId), manifest, fetcher);
  }

  async syncAllRunArtifacts(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
    workspaceId: string,
    runId: number,
  ): Promise<SyncResult> {
    const fetcher = this._authedFetcher(credential);
    const manifest = await this._fetchManifest(profile, fetcher, runId);
    manifest.artifacts = manifest.artifacts.map((a) => ({
      ...a,
      url: new URL(a.url, `${profile.serverUrl}/`).toString(),
    }));
    return await syncRun(path.join(this.config.artifactCacheRoot, workspaceId), manifest, fetcher);
  }

  // ── Auto-sync (triggered by event bus) ────────────────────────────────────
  // Replaces the fire-and-forget block embedded in WorkspaceClient.synchronize().
  // Callers register this as a listener on the WRE event bus; it reacts to
  // run:status-changed events and downloads artifacts for completed runs.

  readonly autoSync = (event: WREEvent): void => {
    if (event.type !== "run:status-changed") return;
    if (event.status !== "success") return;
    // Trigger artifact download in the background. The workspaceId + runObjectId
    // are sufficient to locate the run; the profile must be looked up by the caller.
    // This method intentionally does nothing async directly — the caller wires
    // the actual download by subscribing to the event bus and calling syncAllRunArtifacts.
    // See the IPC handler in index.ts for the wiring.
    this.emit({
      type: "artifact:available",
      runObjectId: event.runObjectId,
      relativePath: "*",
      workspaceId: event.workspaceId,
    });
  };

  // ── Shutdown fence ─────────────────────────────────────────────────────────
  // Must complete before the VM is terminated.
  // Pulls all artifacts for completed runs that are not yet fully cached.
  // Called by the "Stop Instance" button before sending the EC2 terminate call.

  async shutdownFence(
    profile: WorkspaceProfile,
    credential: WorkspaceCredential | null,
    workspaceId: string,
  ): Promise<ShutdownFenceResult> {
    const result: ShutdownFenceResult = { artifactsPulled: [], errors: [], fenceComplete: false };
    try {
      // Get the current snapshot to find all runs.
      const { snapshot } = await this.synchronize(profile, credential);
      const completedRuns = snapshot.runs.filter(
        (run) => run.status === "success" && run.cacheState !== "fully-cached" && run.cacheState !== "offline-cached",
      );
      for (const run of completedRuns) {
        try {
          const syncResult = await this.syncAllRunArtifacts(
            profile, credential, workspaceId, run.id,
          );
          result.artifactsPulled.push(...syncResult.downloaded);
        } catch (err) {
          result.errors.push(
            `run ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      result.fenceComplete = result.errors.length === 0;
    } catch (err) {
      result.errors.push(`snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.emit({ type: "vm:shutdown-requested", workspaceId });
    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _authedFetcher(credential: WorkspaceCredential | null): typeof fetch {
    const auth = authorization(credential);
    const base = this.config.fetcher ?? fetch;
    if (!auth) return base;
    return (input, init = {}) => base(input, {
      ...init,
      headers: { ...init.headers, Authorization: auth },
    });
  }

  private async _fetchManifest(
    profile: WorkspaceProfile,
    fetcher: typeof fetch,
    runId: number,
  ): Promise<SyncManifest> {
    const url = new URL(`/api/runs/${runId}/sync-manifest`, `${profile.serverUrl}/`).toString();
    const resp = await fetcher(url);
    if (!resp.ok) throw new Error(`Sync manifest fetch failed: HTTP ${resp.status}`);
    return resp.json() as Promise<SyncManifest>;
  }
}
