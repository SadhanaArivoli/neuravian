/**
 * Empirical tests for WorkspaceSessionStore and RunHistoryStore.
 *
 * All tests operate on real temporary directories on disk.
 * No mocks, no stubs for filesystem operations.
 *
 * Verification levels used in this file:
 *   VERIFIED        — test exercises the real code path and asserts the outcome.
 *   NOT VERIFIED    — explicitly noted where a scenario cannot be exercised in
 *                     a standard test (e.g. mid-write power failure).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceSessionStore,
  createDefaultSession,
  MAX_RECENT_RUN_HISTORY,
  MAX_NOTIFICATIONS,
  MAX_RECENTLY_VIEWED,
} from "../src/main/workspace-session-store.js";
import { RunHistoryStore } from "../src/main/workspace-run-history.js";
import type { SessionRunHistoryEntry, WorkspaceSession } from "../src/main/workspace-types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let dir: string;
let sessionStore: WorkspaceSessionStore;
let runHistoryStore: RunHistoryStore;

beforeEach(async () => {
  dir = await (async () => {
    const base = join(tmpdir(), `nf-session-test-${randomUUID()}`);
    await mkdir(base, { recursive: true });
    return base;
  })();
  sessionStore = new WorkspaceSessionStore(join(dir, "sessions"));
  runHistoryStore = new RunHistoryStore(join(dir, "history"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(n: number): SessionRunHistoryEntry {
  return {
    runId: n,
    remoteKey: `run-${n}`,
    pipelineId: `fmriprep`,
    pipelineName: `fmriprep`,
    datasetId: 1,
    status: "success",
    launchedAt: new Date(Date.now() - n * 1000).toISOString(),
    finishedAt: new Date(Date.now() - (n - 1) * 1000).toISOString(),
    cacheState: "fully-cached",
    artifactCount: 10,
    fenceComplete: true,
  };
}

function makeSession(profileId: string, overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return { ...createDefaultSession(profileId), ...overrides };
}

// ── Section 1: WorkspaceSessionStore — basic correctness ─────────────────────

describe("WorkspaceSessionStore — basic correctness", () => {
  it("VERIFIED: returns null for a missing session file", async () => {
    const result = await sessionStore.load("nonexistent");
    expect(result).toBeNull();
  });

  it("VERIFIED: saves and reloads a session round-trip", async () => {
    const session = makeSession("profile-1");
    session.syncStatus.lastSyncAt = "2025-01-01T00:00:00.000Z";
    session.researchContext.scratch = "test note";

    await sessionStore.save(session);
    const loaded = await sessionStore.load("profile-1");

    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe(session.sessionId);
    expect(loaded!.profileId).toBe("profile-1");
    expect(loaded!.syncStatus.lastSyncAt).toBe("2025-01-01T00:00:00.000Z");
    expect(loaded!.researchContext.scratch).toBe("test note");
  });

  it("VERIFIED: loadOrCreate creates and persists a default session on first use", async () => {
    const session = await sessionStore.loadOrCreate("new-profile");
    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Re-loading returns the same session (was persisted).
    const again = await sessionStore.load("new-profile");
    expect(again?.sessionId).toBe(session.sessionId);
  });

  it("VERIFIED: two profiles are stored independently", async () => {
    const a = makeSession("profile-a");
    const b = makeSession("profile-b");
    a.researchContext.scratch = "notes for A";
    b.researchContext.scratch = "notes for B";

    await Promise.all([sessionStore.save(a), sessionStore.save(b)]);

    const loadedA = await sessionStore.load("profile-a");
    const loadedB = await sessionStore.load("profile-b");

    expect(loadedA?.researchContext.scratch).toBe("notes for A");
    expect(loadedB?.researchContext.scratch).toBe("notes for B");
    expect(loadedA?.sessionId).not.toBe(loadedB?.sessionId);
  });
});

// ── Section 2: Corruption recovery ────────────────────────────────────────────

describe("WorkspaceSessionStore — corruption recovery", () => {
  it("VERIFIED: recovers from corrupt main file using backup", async () => {
    // The .bak is created on the SECOND save (first save has no existing .json to back up).
    // So two saves are required before the backup exists.
    const session = makeSession("profile-r1");
    session.syncStatus.lastSyncAt = "2025-06-01T00:00:00.000Z";
    await sessionStore.save(session);
    // Second save: copies the first .json to .bak, then writes a new .json.
    session.syncStatus.lastSyncAt = "2025-06-01T00:00:00.000Z"; // same value — only .bak matters
    await sessionStore.save(session);

    // Now corrupt the main file. .bak still holds the valid first version.
    const mainPath = join(dir, "sessions", "profile-r1.json");
    await writeFile(mainPath, "{ this is not valid json", "utf8");

    const loaded = await sessionStore.load("profile-r1");
    // VERIFIED: backup is used when main is corrupt.
    expect(loaded).not.toBeNull();
    expect(loaded!.syncStatus.lastSyncAt).toBe("2025-06-01T00:00:00.000Z");
  });

  it("VERIFIED: returns null when both main and backup are corrupt", async () => {
    await sessionStore.save(makeSession("profile-r2"));

    const mainPath   = join(dir, "sessions", "profile-r2.json");
    const backupPath = join(dir, "sessions", "profile-r2.bak");
    await writeFile(mainPath,   "CORRUPT", "utf8");
    await writeFile(backupPath, "CORRUPT", "utf8");

    const loaded = await sessionStore.load("profile-r2");
    expect(loaded).toBeNull();
  });

  it("VERIFIED: returns null for a file that is valid JSON but not a session envelope", async () => {
    const mainPath = join(dir, "sessions", "profile-r3.json");
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(mainPath, JSON.stringify({ foo: "bar" }), "utf8");

    expect(await sessionStore.load("profile-r3")).toBeNull();
  });

  it("VERIFIED: returns null for a future schema version (unrecognized by this build)", async () => {
    const mainPath = join(dir, "sessions", "profile-r4.json");
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(
      mainPath,
      JSON.stringify({ schemaVersion: 999, savedAt: new Date().toISOString(), session: { sessionId: "x", profileId: "profile-r4" } }),
      "utf8",
    );

    expect(await sessionStore.load("profile-r4")).toBeNull();
  });

  it("VERIFIED: migrates legacy runHistory field name to recentRunHistory", async () => {
    // Write a session file using the old field name.
    const mainPath = join(dir, "sessions", "profile-legacy.json");
    await mkdir(join(dir, "sessions"), { recursive: true });
    const legacySession = {
      ...createDefaultSession("profile-legacy"),
      runHistory: [makeEntry(1)],   // old field name
    };
    // Delete recentRunHistory if it exists on the defaultSession.
    delete (legacySession as Record<string, unknown>)["recentRunHistory"];
    await writeFile(
      mainPath,
      JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), session: legacySession }),
      "utf8",
    );

    const loaded = await sessionStore.load("profile-legacy");
    expect(loaded).not.toBeNull();
    expect(loaded!.recentRunHistory).toHaveLength(1);
    expect(loaded!.recentRunHistory[0].remoteKey).toBe("run-1");
  });

  it("VERIFIED: stale .tmp file does not interfere with a subsequent load", async () => {
    // Simulate a stale .tmp left by a previous crash.
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(
      join(dir, "sessions", "profile-stale-garbage.tmp"),
      "this is junk",
      "utf8",
    );

    // Load should not fail or read the .tmp file.
    expect(await sessionStore.load("profile-stale")).toBeNull();

    // Save should work normally; a new unique .tmp is created and cleaned up.
    await sessionStore.save(makeSession("profile-stale"));
    expect(await sessionStore.load("profile-stale")).not.toBeNull();
  });
});

// ── Section 3: Write queue (serialization) ────────────────────────────────────

describe("WorkspaceSessionStore — write queue / concurrent saves", () => {
  it("VERIFIED: two concurrent saves for the same profile produce a valid final file", async () => {
    const a = makeSession("profile-concurrent");
    a.researchContext.scratch = "version A";
    const b = { ...a, researchContext: { ...a.researchContext, scratch: "version B" } };

    // Fire both without awaiting the first.
    const [, ] = await Promise.all([sessionStore.save(a), sessionStore.save(b)]);

    const loaded = await sessionStore.load("profile-concurrent");
    expect(loaded).not.toBeNull();
    // Both saves completed; the final file is one of them (B arrives last in this test).
    expect(["version A", "version B"]).toContain(loaded!.researchContext.scratch);
  });

  it("VERIFIED: ten rapid saves for the same profile all complete without corruption", async () => {
    const base = makeSession("profile-rapid");
    const saves = Array.from({ length: 10 }, (_, i) =>
      sessionStore.save({
        ...base,
        researchContext: { ...base.researchContext, scratch: `save-${i}` },
      }),
    );
    await Promise.all(saves);

    const loaded = await sessionStore.load("profile-rapid");
    expect(loaded).not.toBeNull();
    // File must be valid JSON and parse correctly.
    const raw = await readFile(join(dir, "sessions", "profile-rapid.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("VERIFIED: saves for different profiles do not interfere with each other", async () => {
    const saves = Array.from({ length: 5 }, (_, i) =>
      sessionStore.save(makeSession(`profile-parallel-${i}`)),
    );
    await Promise.all(saves);

    for (let i = 0; i < 5; i++) {
      expect(await sessionStore.load(`profile-parallel-${i}`)).not.toBeNull();
    }
  });
});

// ── Section 4: Trim / cap enforcement ────────────────────────────────────────

describe("WorkspaceSessionStore — cap enforcement", () => {
  it(`VERIFIED: recentRunHistory is capped at ${MAX_RECENT_RUN_HISTORY}`, async () => {
    const session = makeSession("profile-cap-runs");
    session.recentRunHistory = Array.from({ length: 200 }, (_, i) => makeEntry(i));

    await sessionStore.save(session);
    const loaded = await sessionStore.load("profile-cap-runs");
    expect(loaded!.recentRunHistory).toHaveLength(MAX_RECENT_RUN_HISTORY);
    // Keeps the MOST RECENT (last inserted) entries.
    expect(loaded!.recentRunHistory[0].runId).toBe(200 - MAX_RECENT_RUN_HISTORY);
  });

  it(`VERIFIED: notifications are capped at ${MAX_NOTIFICATIONS}`, async () => {
    const session = makeSession("profile-cap-notif");
    session.notifications = Array.from({ length: 300 }, (_, i) => ({
      notificationId: `n-${i}`,
      type: "run:complete" as const,
      message: `Run ${i} complete`,
      timestamp: new Date().toISOString(),
      runId: i,
      read: false,
    }));

    await sessionStore.save(session);
    const loaded = await sessionStore.load("profile-cap-notif");
    expect(loaded!.notifications).toHaveLength(MAX_NOTIFICATIONS);
  });

  it(`VERIFIED: recentlyViewed is capped at ${MAX_RECENTLY_VIEWED}`, async () => {
    const session = makeSession("profile-cap-viewed");
    session.researchContext.recentlyViewed = Array.from({ length: 300 }, (_, i) => `obj-${i}`);

    await sessionStore.save(session);
    const loaded = await sessionStore.load("profile-cap-viewed");
    expect(loaded!.researchContext.recentlyViewed).toHaveLength(MAX_RECENTLY_VIEWED);
  });
});

// ── Section 5: Unicode and special characters ─────────────────────────────────

describe("WorkspaceSessionStore — Unicode and special characters", () => {
  it("VERIFIED: persists and restores Unicode in scratch notes and tags", async () => {
    const session = makeSession("profile-unicode");
    session.researchContext.scratch =
      "研究ノート\nمذكرات البحث\n𝄞 Müller-Lyer 🧠 cortex\n\0null byte";
    session.researchContext.annotations["subject-001"] = {
      note: "Straße & café — データ",
      tags: ["lesão", "αδιέξοδο", "研究"],
    };
    session.projectSummaries = [
      { id: 1, remoteKey: "proj-1", title: "ABIDE II — 자폐스펙트럼" },
    ];

    await sessionStore.save(session);
    const loaded = await sessionStore.load("profile-unicode");
    expect(loaded!.researchContext.scratch).toBe(session.researchContext.scratch);
    expect(loaded!.researchContext.annotations["subject-001"].note).toBe("Straße & café — データ");
    expect(loaded!.researchContext.annotations["subject-001"].tags).toEqual(["lesão", "αδιέξοδο", "研究"]);
    expect(loaded!.projectSummaries[0].title).toBe("ABIDE II — 자폐스펙트럼");
  });
});

// ── Section 6: RunHistoryStore — correctness ──────────────────────────────────

describe("RunHistoryStore — correctness", () => {
  it("VERIFIED: returns empty array for a missing profile", async () => {
    expect(await runHistoryStore.load("nonexistent")).toEqual([]);
  });

  it("VERIFIED: append and load round-trip", async () => {
    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    await runHistoryStore.append("profile-h1", entries);

    const loaded = await runHistoryStore.load("profile-h1");
    expect(loaded).toHaveLength(3);
    expect(loaded.map((e) => e.remoteKey)).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("VERIFIED: append is idempotent — duplicate remoteKeys are not added twice", async () => {
    await runHistoryStore.append("profile-h2", [makeEntry(1), makeEntry(2)]);
    await runHistoryStore.append("profile-h2", [makeEntry(2), makeEntry(3)]); // run-2 is a dup

    const loaded = await runHistoryStore.load("profile-h2");
    expect(loaded).toHaveLength(3);
  });

  it("VERIFIED: append updates mutable fields for existing entries", async () => {
    const initial = { ...makeEntry(1), status: "running", finishedAt: null };
    await runHistoryStore.append("profile-h3", [initial]);

    const updated = { ...makeEntry(1), status: "success", finishedAt: "2025-06-01T00:00:00.000Z" };
    await runHistoryStore.append("profile-h3", [updated]);

    const loaded = await runHistoryStore.load("profile-h3");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe("success");
    expect(loaded[0].finishedAt).toBe("2025-06-01T00:00:00.000Z");
  });

  it("VERIFIED: run history is never trimmed — accumulates unbounded", async () => {
    const batch = Array.from({ length: 600 }, (_, i) => makeEntry(i + 1));
    await runHistoryStore.append("profile-h4", batch);

    const loaded = await runHistoryStore.load("profile-h4");
    expect(loaded).toHaveLength(600);
  });

  it("VERIFIED: loadRecent returns the N most recent entries", async () => {
    const entries = Array.from({ length: 100 }, (_, i) => makeEntry(i + 1));
    await runHistoryStore.append("profile-h5", entries);

    const recent = await runHistoryStore.loadRecent("profile-h5", 10);
    expect(recent).toHaveLength(10);
    // Most recent = highest runId (entries were appended in order 1..100)
    expect(recent[recent.length - 1].runId).toBe(100);
  });

  it("VERIFIED: loadPage paginates newest-first", async () => {
    const entries = Array.from({ length: 50 }, (_, i) => makeEntry(i + 1));
    await runHistoryStore.append("profile-h6", entries);

    const page0 = await runHistoryStore.loadPage("profile-h6", 0, 10);
    expect(page0.totalCount).toBe(50);
    expect(page0.hasMore).toBe(true);
    expect(page0.entries[0].runId).toBe(50); // newest first

    const page4 = await runHistoryStore.loadPage("profile-h6", 4, 10);
    expect(page4.hasMore).toBe(false);
    expect(page4.entries[0].runId).toBe(10); // oldest entries
  });

  it("VERIFIED: two profile histories are independent", async () => {
    await runHistoryStore.append("profile-ha", [makeEntry(1)]);
    await runHistoryStore.append("profile-hb", [makeEntry(2), makeEntry(3)]);

    expect(await runHistoryStore.load("profile-ha")).toHaveLength(1);
    expect(await runHistoryStore.load("profile-hb")).toHaveLength(2);
  });
});

// ── Section 7: RunHistoryStore — concurrent writes ───────────────────────────

describe("RunHistoryStore — concurrent appends", () => {
  it("VERIFIED: 10 concurrent appends for the same profile produce a valid, non-corrupt file", async () => {
    const batches = Array.from({ length: 10 }, (_, batchIdx) =>
      Array.from({ length: 5 }, (_, entryIdx) => makeEntry(batchIdx * 5 + entryIdx + 1)),
    );

    await Promise.all(batches.map((batch) => runHistoryStore.append("profile-concurrent-h", batch)));

    const loaded = await runHistoryStore.load("profile-concurrent-h");
    // All 50 unique runs should be present (no duplicates, no corruption).
    expect(loaded).toHaveLength(50);
    const keys = new Set(loaded.map((e) => e.remoteKey));
    expect(keys.size).toBe(50);
  });
});

// ── Section 8: Benchmarks ─────────────────────────────────────────────────────

describe("Benchmarks — actual I/O timing measurements", () => {
  async function benchmark(
    label: string,
    count: number,
  ): Promise<{ saveMs: number; loadMs: number; fileSizeKb: number }> {
    const profileId = `bench-${count}`;
    const entries = Array.from({ length: count }, (_, i) => makeEntry(i + 1));

    await runHistoryStore.append(profileId, entries);

    // Measure load time.
    const t0 = performance.now();
    const loaded = await runHistoryStore.load(profileId);
    const loadMs = performance.now() - t0;

    expect(loaded).toHaveLength(count);

    // Measure save time (append of 1 new entry).
    const newEntry = makeEntry(count + 1);
    const t1 = performance.now();
    await runHistoryStore.append(profileId, [newEntry]);
    const saveMs = performance.now() - t1;

    // File size.
    const raw = await readFile(join(dir, "history", `${profileId}.json`), "utf8");
    const fileSizeKb = raw.length / 1024;

    console.log(
      `[Benchmark] ${label.padEnd(20)} | load: ${loadMs.toFixed(1).padStart(7)} ms` +
      ` | save: ${saveMs.toFixed(1).padStart(7)} ms | size: ${fileSizeKb.toFixed(0).padStart(6)} KB`,
    );

    return { saveMs, loadMs, fileSizeKb };
  }

  it("VERIFIED: 100 entries", async () => {
    const r = await benchmark("100 entries", 100);
    // Should be well under 200 ms on any reasonable hardware.
    expect(r.loadMs).toBeLessThan(200);
    expect(r.saveMs).toBeLessThan(200);
  });

  it("VERIFIED: 500 entries", async () => {
    const r = await benchmark("500 entries", 500);
    expect(r.loadMs).toBeLessThan(500);
    expect(r.saveMs).toBeLessThan(500);
  });

  it("VERIFIED: 5 000 entries", async () => {
    const r = await benchmark("5 000 entries", 5_000);
    // Acceptable degradation at 5k. Document but do not fail on CI.
    console.log(`[Note] 5 000 entries load: ${r.loadMs.toFixed(0)} ms — acceptable if < 200 ms`);
    expect(r.loadMs).toBeLessThan(1000); // hard upper bound
  });

  it("VERIFIED: 25 000 entries", async () => {
    const r = await benchmark("25 000 entries", 25_000);
    console.log(`[Note] 25 000 entries load: ${r.loadMs.toFixed(0)} ms — use pagination if > 100 ms`);
    // Document the degradation; hard limit of 5 s to catch runaway cases.
    expect(r.loadMs).toBeLessThan(5000);
  });

  it("VERIFIED: session store save+load for a fully-populated session", async () => {
    const session = makeSession("bench-session");
    session.recentRunHistory = Array.from({ length: MAX_RECENT_RUN_HISTORY }, (_, i) => makeEntry(i));
    session.notifications = Array.from({ length: MAX_NOTIFICATIONS }, (_, i) => ({
      notificationId: `n-${i}`,
      type: "run:complete" as const,
      message: `Run ${i} complete`,
      timestamp: new Date().toISOString(),
      runId: i,
      read: false,
    }));
    session.researchContext.recentlyViewed = Array.from({ length: MAX_RECENTLY_VIEWED }, (_, i) => `obj-${i}`);
    session.researchContext.scratch = "A".repeat(10_000); // 10 KB of notes

    const t0 = performance.now();
    await sessionStore.save(session);
    const saveMs = performance.now() - t0;

    const t1 = performance.now();
    const loaded = await sessionStore.load("bench-session");
    const loadMs = performance.now() - t1;

    const raw = await readFile(join(dir, "sessions", "bench-session.json"), "utf8");
    const sizeKb = raw.length / 1024;

    console.log(
      `[Benchmark] ${"full session".padEnd(20)} | save: ${saveMs.toFixed(1).padStart(7)} ms` +
      ` | load: ${loadMs.toFixed(1).padStart(7)} ms | size: ${sizeKb.toFixed(0).padStart(6)} KB`,
    );

    expect(loaded).not.toBeNull();
    expect(saveMs).toBeLessThan(200);
    expect(loadMs).toBeLessThan(200);
  });
});

// ── Section 9: NOT VERIFIED scenarios (documented) ───────────────────────────

/*
 * The following scenarios CANNOT be verified in a standard test environment
 * because they require injecting failures mid-write at the OS level:
 *
 * NOT VERIFIED: process crash after writeFile but before filehandle.sync() completes.
 *   → On POSIX, the tmp file may contain partial data. The main .json is untouched.
 *   → .bak (if written) holds the previous version; main .json is still valid.
 *   → Recovery: load main (still valid) or load backup.
 *
 * NOT VERIFIED: process crash after filehandle.sync() but before rename().
 *   → The fsynced .tmp file is an orphan. The main .json is untouched.
 *   → .bak holds the previous version; main .json is still valid.
 *   → Recovery: load main (still valid) or load backup.
 *   → Orphaned .tmp files accumulate on crash loops but do not cause read errors.
 *
 * NOT VERIFIED: process crash mid-copyFile (backup step).
 *   → The .bak file may be partially written.
 *   → The main .json is untouched at this point.
 *   → On the next save, a new .bak is written, replacing the partial one.
 *
 * NOT VERIFIED: OS crash mid-rename (POSIX).
 *   → After rename() returns successfully, the directory entry is atomically updated.
 *   → If the OS crashes before the inode is committed, the filesystem journal
 *     (ext4/APFS/HFS+) guarantees the directory returns to a consistent state.
 *   → Either the old .json or the new .json is visible after recovery; never a partial file.
 *
 * NOT VERIFIED: Windows antivirus locking the destination file during rename.
 *   → The EPERM fallback (copyFile + unlink) is exercised by the fallback code path.
 *   → A crash mid-copyFile on Windows leaves the main .json partially overwritten.
 *   → Recovery: load .bak (the previous complete version).
 *
 * NOT VERIFIED: disk full during writeFile(.tmp).
 *   → writeFile throws; the main .json and .bak are untouched.
 *   → The .tmp file may be partially written (OS behavior varies).
 *   → No data loss: the previous session is still in .json.
 */
