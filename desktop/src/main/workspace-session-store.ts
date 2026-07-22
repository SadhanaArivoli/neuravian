/**
 * WorkspaceSessionStore
 *
 * Persists and loads WorkspaceSessions — the permanent representation of a
 * researcher's working context, independent of execution environments.
 *
 * ── Session lifecycle ────────────────────────────────────────────────────────
 *
 * A session is created the first time a profile is loaded (no file on disk →
 * createDefaultSession). It is updated incrementally as the researcher works:
 *
 *   1. After every successful sync: summaries + syncStatus + recentRunHistory.
 *   2. As the researcher navigates: uiState is saved so restarts feel seamless.
 *
 * The session is NEVER the source of truth for run history. That responsibility
 * belongs to RunHistoryStore (workspace-run-history.ts). The session's
 * recentRunHistory field is a display cache (last 50 entries) rebuilt from
 * RunHistoryStore on every sync.
 *
 * ── Persistence layout ───────────────────────────────────────────────────────
 *
 *   <userData>/workspace-sessions/<profileId>.json   ← active session
 *   <userData>/workspace-sessions/<profileId>.bak    ← previous session
 *   <userData>/workspace-sessions/<profileId>-<uuid>.tmp  ← staging (cleaned on success)
 *
 * Envelope format:
 *   {
 *     "schemaVersion": 1,
 *     "savedAt": "<ISO>",
 *     "session": { ...WorkspaceSession }
 *   }
 *
 * ── First-write behavior ─────────────────────────────────────────────────────
 *
 * On the FIRST save for a profile, no .json exists yet, so the backup step
 * (copyFile .json → .bak) produces ENOENT and is silently skipped.  The first
 * save has no backup; if the process crashes between steps 1 and 4 on the first
 * save, the session is lost (returns null on the next load → first-launch behavior).
 * This is acceptable: first launch has no session to recover.
 *
 * From the second save onward, .bak always holds the previous good version.
 *
 * ── Crash-safety guarantees (POSIX / macOS / Linux) ─────────────────────────
 *
 * The write sequence is:
 *   1. Serialize to JSON string in memory.
 *      → If this throws, no file is touched.
 *   2. Open a unique .tmp file (e.g. <profileId>-<uuid>.tmp) and write the JSON.
 *   3. Call filehandle.sync() on the .tmp file to flush OS write buffers to disk.
 *      → After sync() returns, the .tmp data is durable even if the OS crashes.
 *   4. Copy the current .json to .bak (best-effort; failure is logged but
 *      does not abort the save, at the cost of losing the backup for this cycle).
 *   5. Call rename(.tmp, .json).
 *      → On POSIX, rename() replaces the destination atomically at the VFS layer.
 *      → After rename() returns, readers see either the old .json or the new one,
 *         never a partial file.
 *
 * Combined guarantee: if the process or OS crashes after step 5, .json holds
 * the new data (fsynced in step 3, atomically promoted in step 5). .bak holds
 * the previous version for recovery.
 *
 * On crash between steps 2 and 5 (during fsync, backup, or rename):
 *   - .json is unchanged (old data, still valid).
 *   - .tmp may exist (orphan); it is not cleaned up automatically but does not
 *     interfere with future reads or writes (unique names prevent conflicts).
 *   - .bak may be partially written — but .json is still intact.
 *
 * ── Windows caveats ──────────────────────────────────────────────────────────
 *
 * Windows rename() with an existing destination returns EPERM in some
 * circumstances (antivirus lock, Explorer open). The fallback is:
 *   copyFile(.tmp, .json)  →  unlink(.tmp)
 * This is NOT atomic. A crash between copy and unlink leaves .tmp and .json
 * both containing the new data (benign). A crash mid-copyFile leaves .json
 * partially written — but .bak retains the previous good version.
 * Recovery on Windows: try .json → try .bak → return null.
 *
 * ── Concurrent save serialization ────────────────────────────────────────────
 *
 * A per-profile write queue (Map<profileId, Promise<void>>) serializes all
 * save() calls for the same profile. The second save() call chains on the
 * promise returned by the first, capturing its session snapshot at call time.
 * If the first save fails, the second still runs (the chain uses .catch(noop)).
 * This prevents interleaved writes, torn files, and lost-update races.
 *
 * ── Schema evolution ─────────────────────────────────────────────────────────
 *
 * CURRENT_SCHEMA_VERSION is the single source of truth. When the schema changes:
 *   1. Increment CURRENT_SCHEMA_VERSION.
 *   2. Add a migration in _migrate() that handles the previous version.
 *   3. Sessions with an unknown future version fall through to backup/null.
 *
 * ── Performance characteristics ──────────────────────────────────────────────
 *
 * The session is bounded by construction:
 *   recentRunHistory  → max 50 entries  (display cache only)
 *   notifications     → max 100 entries
 *   recentlyViewed    → max 100 IDs
 *
 * A fully-populated session file is ≈ 30–80 KB. Load and save are each < 5 ms
 * on modern hardware for any realistic session size.
 *
 * Complete run history is NOT stored in the session; see RunHistoryStore.
 */

import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  WorkspaceSession,
  SessionRunHistoryEntry,
  SessionUIState,
  WorkspaceCacheState,
  WorkspaceSnapshot,
} from "./workspace-types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const CURRENT_SCHEMA_VERSION = 1;

/** Number of entries kept in session.recentRunHistory (display cache only). */
export const MAX_RECENT_RUN_HISTORY = 50;
/** Hard cap on notification queue. */
export const MAX_NOTIFICATIONS = 100;
/** Hard cap on recently-viewed list. */
export const MAX_RECENTLY_VIEWED = 100;

// ── Envelope ──────────────────────────────────────────────────────────────────

interface SessionEnvelope {
  schemaVersion: number;
  savedAt: string;
  session: WorkspaceSession;
}

// ── Validation ────────────────────────────────────────────────────────────────

function isSessionEnvelope(value: unknown): value is SessionEnvelope {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj["schemaVersion"] === "number" &&
    typeof obj["savedAt"] === "string" &&
    obj["session"] !== null &&
    typeof obj["session"] === "object"
  );
}

function isValidSession(session: unknown): session is WorkspaceSession {
  if (!session || typeof session !== "object") return false;
  const s = session as Record<string, unknown>;
  return typeof s["sessionId"] === "string" && typeof s["profileId"] === "string";
}

// ── Migration ─────────────────────────────────────────────────────────────────

function _migrate(envelope: SessionEnvelope): WorkspaceSession {
  if (envelope.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Session was written by a newer Neuravian (schema v${envelope.schemaVersion}). ` +
      `This build understands up to v${CURRENT_SCHEMA_VERSION}.`,
    );
  }
  // v1 → current: add recentRunHistory alias if only runHistory exists (legacy field name).
  const raw = envelope.session as unknown as Record<string, unknown>;
  if (!Array.isArray(raw["recentRunHistory"]) && Array.isArray(raw["runHistory"])) {
    raw["recentRunHistory"] = raw["runHistory"];
    delete raw["runHistory"];
  }
  return envelope.session as WorkspaceSession;
}

// ── Trim (applied before every save) ─────────────────────────────────────────

function _trim(session: WorkspaceSession): WorkspaceSession {
  return {
    ...session,
    recentRunHistory:
      session.recentRunHistory.length > MAX_RECENT_RUN_HISTORY
        ? session.recentRunHistory.slice(-MAX_RECENT_RUN_HISTORY)
        : session.recentRunHistory,
    notifications:
      session.notifications.length > MAX_NOTIFICATIONS
        ? session.notifications.slice(-MAX_NOTIFICATIONS)
        : session.notifications,
    researchContext: {
      ...session.researchContext,
      recentlyViewed:
        session.researchContext.recentlyViewed.length > MAX_RECENTLY_VIEWED
          ? session.researchContext.recentlyViewed.slice(0, MAX_RECENTLY_VIEWED)
          : session.researchContext.recentlyViewed,
    },
  };
}

// ── Default session factory ───────────────────────────────────────────────────

export function createDefaultSession(profileId: string): WorkspaceSession {
  const now = new Date().toISOString();
  return {
    sessionId: randomUUID(),
    profileId,
    workspaceId: null,
    createdAt: now,
    lastActiveAt: now,
    projectSummaries: [],
    workflowSummaries: [],
    datasetSummaries: [],
    recentRunHistory: [],
    pendingExecutions: [],
    notifications: [],
    uiState: {
      activeView: "home",
      selectedProjectId: null,
      selectedWorkflowId: null,
      selectedRunId: null,
      openPanels: [],
      scrollPositions: {},
    },
    viewerState: {
      lastRunId: null,
      openFiles: [],
      viewerPreference: null,
    },
    syncStatus: {
      lastSyncAt: null,
      lastOnlineAt: null,
      pendingArtifacts: 0,
      syncErrors: [],
    },
    researchContext: {
      annotations: {},
      recentlyViewed: [],
      scratch: "",
      preferences: {},
    },
  };
}

// ── WorkspaceSessionStore ─────────────────────────────────────────────────────

export class WorkspaceSessionStore {
  /**
   * Per-profile write queue.  Serializes concurrent save() calls so two saves
   * for the same profile never overlap on disk.
   *
   * The map value is always a settled-or-pending Promise<void>.  Each new
   * save() captures the session state at call time, chains on the current
   * tail, and replaces the map entry.  The map entry itself is always a
   * catch-nooped promise so the chain never breaks on failure.
   */
  private readonly _queue = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Load the session.  Returns null on first launch or unrecoverable corruption.
   * Recovery order: main file → backup file → null.  Never throws.
   */
  async load(profileId: string): Promise<WorkspaceSession | null> {
    const main = await this._tryRead(this._mainPath(profileId), "main");
    if (main) return main;

    const backup = await this._tryRead(this._backupPath(profileId), "backup");
    if (backup) {
      console.warn(`[SessionStore] ${profileId}: recovered from backup.`);
      return backup;
    }
    return null;
  }

  /** Load the session, or create and persist a fresh default if none exists. */
  async loadOrCreate(profileId: string): Promise<WorkspaceSession> {
    const existing = await this.load(profileId);
    if (existing) return existing;
    const fresh = createDefaultSession(profileId);
    await this.save(fresh);
    return fresh;
  }

  /**
   * Persist the session.  Enqueues the save so concurrent calls for the same
   * profile are serialized; returns a promise that resolves when this specific
   * save is durably committed to disk.
   *
   * The session state is captured at call time, not at execution time.  If two
   * saves are queued, both run in order — the caller's version is always written.
   */
  async save(session: WorkspaceSession): Promise<void> {
    const profileId = session.profileId;
    // Capture the trimmed envelope now, not when the queue slot runs,
    // so the caller's state is exactly what gets written.
    const prepared = this._prepareEnvelope(session);

    const tail = this._queue.get(profileId) ?? Promise.resolve();
    const thisWrite = tail
      .catch(() => {})  // previous failure does not block this save
      .then(() => this._doWrite(profileId, prepared));

    // Keep the queue entry alive so the next save can chain, but swallow
    // rejections at the queue level (callers receive them via thisWrite).
    this._queue.set(profileId, thisWrite.catch(() => {}));
    return thisWrite;
  }

  /**
   * Update session from a successful cloud sync.  Writes and awaits persistence.
   * Called by the workspaces:sync IPC handler — the sync result is not returned
   * to the renderer until this save completes.
   */
  async updateFromSnapshot(
    profileId: string,
    snapshot: WorkspaceSnapshot,
    online: boolean,
    recentHistory: SessionRunHistoryEntry[],
  ): Promise<WorkspaceSession> {
    const session = await this.loadOrCreate(profileId);

    const projectSummaries = snapshot.projects.map((p) => ({
      id: p.id,
      remoteKey: p.remoteKey,
      title: String((p as Record<string, unknown>).title ?? `Project ${p.id}`),
    }));

    const workflowSummaries = snapshot.workflows.map((w) => ({
      id: w.id,
      remoteKey: w.remoteKey,
      name: String((w as Record<string, unknown>).name ?? `Workflow ${w.id}`),
    }));

    const datasetSummaries = snapshot.datasets.map((d) => ({
      id: d.id,
      remoteKey: d.remoteKey,
      name: String((d as Record<string, unknown>).name ?? `Dataset ${d.id}`),
    }));

    const now = new Date().toISOString();
    const pendingArtifacts = snapshot.runs.filter(
      (r) =>
        r.cacheState !== "fully-cached" &&
        r.cacheState !== "offline-cached" &&
        r.status === "success",
    ).length;

    const updated: WorkspaceSession = {
      ...session,
      workspaceId: snapshot.workspaceId,
      projectSummaries,
      workflowSummaries,
      datasetSummaries,
      recentRunHistory: recentHistory,
      syncStatus: {
        lastSyncAt: now,
        lastOnlineAt: online ? now : session.syncStatus.lastOnlineAt,
        pendingArtifacts,
        syncErrors: [],
      },
    };

    await this.save(updated);
    return updated;
  }

  /**
   * Persist only the UI state portion of the session.
   * Called on every navigation change — faster than a full save only in terms
   * of IPC chatter; the underlying write is the same cost.
   */
  async saveUiState(profileId: string, uiState: SessionUIState): Promise<void> {
    const session = await this.loadOrCreate(profileId);
    await this.save({ ...session, uiState });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _mainPath(profileId: string): string {
    return path.join(this.dir, `${profileId}.json`);
  }
  private _backupPath(profileId: string): string {
    return path.join(this.dir, `${profileId}.bak`);
  }

  /** Trim and serialize the session at call time (before queueing). */
  private _prepareEnvelope(session: WorkspaceSession): string {
    const trimmed = _trim(session);
    const envelope: SessionEnvelope = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      session: { ...trimmed, lastActiveAt: new Date().toISOString() },
    };
    return JSON.stringify(envelope, null, 2);
  }

  /**
   * The actual write.  Runs inside the per-profile queue so it is never
   * concurrent with another write for the same profileId.
   *
   * Write sequence:
   *   1. Write JSON to a unique .tmp file.
   *   2. fsync the .tmp file handle → data is durable before main file changes.
   *   3. Copy .json → .bak (best-effort; failure is logged, does not abort).
   *   4. rename .tmp → .json   (atomic on POSIX)
   *      Windows fallback: copyFile + unlink (not atomic; see module docstring).
   *   5. If rename fails for any other reason, unlink .tmp and re-throw.
   */
  private async _doWrite(profileId: string, json: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    const mainPath   = this._mainPath(profileId);
    const backupPath = this._backupPath(profileId);
    // Unique tmp name: prevents stale-tmp collisions from prior crashes.
    const tmpPath    = path.join(this.dir, `${profileId}-${randomUUID()}.tmp`);

    // Step 1 + 2: write and fsync .tmp.
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(json, "utf8");
      await fh.sync();   // flush OS write buffers → durable before rename
    } finally {
      await fh.close();
    }

    // Step 3: backup (best-effort).
    try {
      await copyFile(mainPath, backupPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[SessionStore] ${profileId}: backup failed:`, err);
      }
    }

    // Step 4: promote .tmp → .json.
    try {
      await rename(tmpPath, mainPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        // Windows: rename blocked (antivirus / file lock). Fall back to copy+unlink.
        await copyFile(tmpPath, mainPath);
        await unlink(tmpPath).catch(() => undefined);
      } else {
        // Unexpected failure: clean up orphan .tmp and propagate.
        await unlink(tmpPath).catch(() => undefined);
        throw err;
      }
    }
  }

  private async _tryRead(filePath: string, label: string): Promise<WorkspaceSession | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[SessionStore] Cannot read ${label} (${filePath}):`, err);
      }
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`[SessionStore] ${label} is not valid JSON (${filePath}).`);
      return null;
    }

    if (!isSessionEnvelope(parsed)) {
      console.warn(`[SessionStore] ${label} has unexpected structure (${filePath}).`);
      return null;
    }

    let session: WorkspaceSession;
    try {
      session = _migrate(parsed);
    } catch (err) {
      console.warn(`[SessionStore] ${label} migration failed (${filePath}):`, err);
      return null;
    }

    if (!isValidSession(session)) {
      console.warn(`[SessionStore] ${label} failed validation (${filePath}).`);
      return null;
    }

    return session;
  }
}
