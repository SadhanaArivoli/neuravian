import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureUserDataCompatibility } from "../src/main/user-data-compatibility.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "neuravian-user-data-test-"));
  temporaryDirectories.push(root);
  const appData = path.join(root, "Application Support");
  const canonical = path.join(appData, "neuravian-desktop");
  mkdirSync(appData, { recursive: true });
  let selected = canonical;
  return {
    appData,
    canonical,
    selected: () => selected,
    app: {
      getPath: (name: "appData" | "userData") => name === "appData" ? appData : canonical,
      setPath: (_name: "userData", value: string) => { selected = value; },
    },
  };
}

function writeProfiles(directory: string, profiles: unknown, mode = 0o600): void {
  const workspaces = path.join(directory, "workspaces");
  mkdirSync(workspaces, { recursive: true });
  const file = path.join(workspaces, "workspace-profiles.json");
  writeFileSync(file, `${JSON.stringify(profiles, null, 2)}\n`, { mode });
}

function writeCredentials(directory: string, credentials: unknown, mode = 0o600): void {
  const workspaces = path.join(directory, "workspaces");
  mkdirSync(workspaces, { recursive: true });
  writeFileSync(path.join(workspaces, "workspace-credentials.json"), `${JSON.stringify(credentials, null, 2)}\n`, { mode });
}

function writeElectronCacheFiles(directory: string): void {
  // Mimics what Chromium/Electron write into userData on every launch, unrelated to any
  // app-specific data. These must never be mistaken for a "populated, already-migrated" profile.
  mkdirSync(path.join(directory, "Cache"), { recursive: true });
  mkdirSync(path.join(directory, "GPUCache"), { recursive: true });
  mkdirSync(path.join(directory, "Session Storage"), { recursive: true });
  writeFileSync(path.join(directory, "Local State"), "{}\n");
  writeFileSync(path.join(directory, "Preferences"), "{}\n");
  writeFileSync(path.join(directory, "Cookies"), "");
}

const AWS_PROFILE = [{
  id: "13ec994e-4471-429e-adf3-74a13b6c8d52",
  name: "AWS NeuroForge",
  serverUrl: "https://34-227-13-179.sslip.io",
  authenticationRef: "os-credential:13ec994e-4471-429e-adf3-74a13b6c8d52",
  serverIdentity: "96525865-a884-50c2-9cf2-8dfcd77a111d",
  lastSync: "2026-07-21T20:17:29.799Z",
  connectionState: "offline",
  connectionMode: "instance-id",
  instanceId: "i-06b49e95ee6df24dd",
  awsRegion: "us-east-1",
}];

describe("configureUserDataCompatibility", () => {
  it("1. fresh install: no canonical, no legacy directories at all", async () => {
    const setup = await fixture();
    const result = configureUserDataCompatibility(setup.app);
    expect(result).toMatchObject({ mode: "canonical", legacyPath: null, migrated: false });
    expect(setup.selected()).toBe(setup.canonical);
    expect(existsSync(setup.canonical)).toBe(false);
  });

  it("2. existing NeuroForge install only: legacy has valid profiles, canonical does not exist", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    const result = configureUserDataCompatibility(setup.app);
    expect(result).toMatchObject({ mode: "canonical", activePath: setup.canonical, legacyPath: legacy, migrated: true });
    expect(setup.selected()).toBe(setup.canonical);
    // Migrated into canonical...
    const migrated = JSON.parse(readFileSync(path.join(setup.canonical, "workspaces", "workspace-profiles.json"), "utf8"));
    expect(migrated).toEqual(AWS_PROFILE);
    // ...without touching the legacy original.
    const original = JSON.parse(readFileSync(path.join(legacy, "workspaces", "workspace-profiles.json"), "utf8"));
    expect(original).toEqual(AWS_PROFILE);
  });

  it("3. existing Neuravian install only: canonical already has valid profiles, no legacy directory", async () => {
    const setup = await fixture();
    writeProfiles(setup.canonical, AWS_PROFILE);
    const result = configureUserDataCompatibility(setup.app);
    expect(result).toMatchObject({ mode: "canonical", activePath: setup.canonical, legacyPath: null, migrated: false });
    expect(setup.selected()).toBe(setup.canonical);
  });

  it("4. both installs present with valid profiles: canonical's own (newer) data wins, legacy is never read into it", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    const neuravianProfile = [{ ...AWS_PROFILE[0], id: "different-id", name: "Neuravian native workspace" }];
    writeProfiles(setup.canonical, neuravianProfile);
    const result = configureUserDataCompatibility(setup.app);
    expect(result).toMatchObject({ mode: "canonical", migrated: false });
    const active = JSON.parse(readFileSync(path.join(setup.canonical, "workspaces", "workspace-profiles.json"), "utf8"));
    expect(active).toEqual(neuravianProfile);
  });

  it("5. Neuravian contains only Electron cache files (the original bug): falls back to migrating legacy data", async () => {
    const setup = await fixture();
    mkdirSync(setup.canonical, { recursive: true });
    writeElectronCacheFiles(setup.canonical);
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeElectronCacheFiles(legacy);
    writeProfiles(legacy, AWS_PROFILE);
    writeCredentials(legacy, [{ profileId: AWS_PROFILE[0].id, ciphertext: "encrypted-blob" }]);

    const result = configureUserDataCompatibility(setup.app);

    expect(result).toMatchObject({ mode: "canonical", activePath: setup.canonical, migrated: true });
    expect(setup.selected()).toBe(setup.canonical);
    const migratedProfiles = JSON.parse(readFileSync(path.join(setup.canonical, "workspaces", "workspace-profiles.json"), "utf8"));
    expect(migratedProfiles).toEqual(AWS_PROFILE);
    const migratedCredentials = JSON.parse(readFileSync(path.join(setup.canonical, "workspaces", "workspace-credentials.json"), "utf8"));
    expect(migratedCredentials).toEqual([{ profileId: AWS_PROFILE[0].id, ciphertext: "encrypted-blob" }]);
    // Electron's own cache files must be left alone.
    expect(existsSync(path.join(setup.canonical, "Cache"))).toBe(true);
  });

  it("6. Neuravian contains only local-workspace.json: still migrates legacy profiles without disturbing it", async () => {
    const setup = await fixture();
    const workspaces = path.join(setup.canonical, "workspaces");
    mkdirSync(workspaces, { recursive: true });
    writeFileSync(path.join(workspaces, "local-workspace.json"), JSON.stringify({
      schemaVersion: 1, workspaceId: "local-5df1dc24-a857-4adf-8908-1f8a7f36d058", createdAt: "2026-07-22T17:03:00.000Z",
    }));
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);

    const result = configureUserDataCompatibility(setup.app);

    expect(result).toMatchObject({ mode: "canonical", migrated: true });
    const localWorkspace = JSON.parse(readFileSync(path.join(workspaces, "local-workspace.json"), "utf8"));
    expect(localWorkspace.workspaceId).toBe("local-5df1dc24-a857-4adf-8908-1f8a7f36d058");
    const migratedProfiles = JSON.parse(readFileSync(path.join(workspaces, "workspace-profiles.json"), "utf8"));
    expect(migratedProfiles).toEqual(AWS_PROFILE);
  });

  it("7. successful one-time migration preserves file mode and logs the action", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE, 0o600);
    const messages: string[] = [];

    configureUserDataCompatibility(setup.app, (message) => messages.push(message));

    const destination = path.join(setup.canonical, "workspaces", "workspace-profiles.json");
    expect(existsSync(destination)).toBe(true);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(messages.some((message) => message.includes("migrated workspace-profiles.json"))).toBe(true);
  });

  it("8. second launch after migration is a no-op and never re-copies or overwrites", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);

    const first = configureUserDataCompatibility(setup.app);
    expect(first.migrated).toBe(true);

    // Simulate the user adding a second cloud workspace natively in Neuravian after migration.
    const updatedProfiles = [...AWS_PROFILE, { ...AWS_PROFILE[0], id: "new-id", name: "Second workspace" }];
    writeProfiles(setup.canonical, updatedProfiles);

    const second = configureUserDataCompatibility(setup.app);

    expect(second).toMatchObject({ mode: "canonical", migrated: false });
    // Canonical data added after migration must not be clobbered by a second run.
    const active = JSON.parse(readFileSync(path.join(setup.canonical, "workspaces", "workspace-profiles.json"), "utf8"));
    expect(active).toEqual(updatedProfiles);
  });

  it("9. missing credentials file: profile migration succeeds without a credentials file", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    // No workspace-credentials.json written — e.g. an instance-id-only profile with no stored password.

    const result = configureUserDataCompatibility(setup.app);

    expect(result.migrated).toBe(true);
    expect(existsSync(path.join(setup.canonical, "workspaces", "workspace-profiles.json"))).toBe(true);
    expect(existsSync(path.join(setup.canonical, "workspaces", "workspace-credentials.json"))).toBe(false);
  });

  it("10. corrupt legacy workspace-profiles.json is never migrated", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    mkdirSync(path.join(legacy, "workspaces"), { recursive: true });
    writeFileSync(path.join(legacy, "workspaces", "workspace-profiles.json"), "{ not valid json");

    const result = configureUserDataCompatibility(setup.app);

    // Corrupt data is not "valid workspace data" to migrate, so it falls through to the
    // populated-legacy-directory fallback (canonical is untouched, nothing is copied).
    expect(existsSync(path.join(setup.canonical, "workspaces", "workspace-profiles.json"))).toBe(false);
    expect(result.migrated).toBe(false);
  });

  it("also refuses to migrate when canonical's own workspace-profiles.json is corrupt", async () => {
    const setup = await fixture();
    mkdirSync(path.join(setup.canonical, "workspaces"), { recursive: true });
    writeFileSync(path.join(setup.canonical, "workspaces", "workspace-profiles.json"), "{ not valid json");
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);

    configureUserDataCompatibility(setup.app);

    // A corrupt canonical file already exists, so it is left exactly as-is — never overwritten,
    // even with data known to be good.
    expect(readFileSync(path.join(setup.canonical, "workspaces", "workspace-profiles.json"), "utf8")).toBe("{ not valid json");
  });

  it("never overwrites an existing valid canonical workspace-credentials.json", async () => {
    const setup = await fixture();
    writeProfiles(setup.canonical, []);
    writeCredentials(setup.canonical, [{ profileId: "keep-me", ciphertext: "existing" }]);
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    writeCredentials(legacy, [{ profileId: AWS_PROFILE[0].id, ciphertext: "legacy-blob" }]);

    // Canonical already has its own (empty) profiles list, so it's authoritative and legacy is
    // never consulted at all — credentials must be untouched.
    configureUserDataCompatibility(setup.app);

    const credentials = JSON.parse(readFileSync(path.join(setup.canonical, "workspaces", "workspace-credentials.json"), "utf8"));
    expect(credentials).toEqual([{ profileId: "keep-me", ciphertext: "existing" }]);
  });

  it("keeps an existing legacy-only profile in place without creating a canonical directory when there is no workspace data at all", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "viewer-settings.json"), "{}\n");
    const result = configureUserDataCompatibility(setup.app);
    expect(result).toMatchObject({ mode: "legacy-compatible", activePath: legacy, legacyPath: legacy, migrated: false });
    expect(setup.selected()).toBe(legacy);
    expect(existsSync(setup.canonical)).toBe(false);
  });

  it("does not move or delete the legacy directory's other files", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "window-state.json"), "{}\n");
    configureUserDataCompatibility(setup.app);
    expect(existsSync(path.join(legacy, "window-state.json"))).toBe(true);
  });

  it("uses canonical for a Neuravian-only user with no cloud workspace configured yet (does not divert to an unrelated legacy directory)", async () => {
    const setup = await fixture();
    mkdirSync(setup.canonical, { recursive: true });
    writeElectronCacheFiles(setup.canonical);
    // No legacy directories exist at all.
    const result = configureUserDataCompatibility(setup.app);
    expect(result).toMatchObject({ mode: "canonical", legacyPath: null, migrated: false });
    expect(setup.selected()).toBe(setup.canonical);
  });

  // ── Per-profile state migration (sessions, run history, offline metadata) ──────────────────

  it("migrates workspace-sessions/<profileId>.json alongside the profile files on first migration", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    const profileId = AWS_PROFILE[0].id;
    const sessionData = { schemaVersion: 1, selectedRunId: 42, lastSyncedAt: "2026-07-20T10:00:00.000Z" };
    mkdirSync(path.join(legacy, "workspace-sessions"), { recursive: true });
    writeFileSync(path.join(legacy, "workspace-sessions", `${profileId}.json`), JSON.stringify(sessionData));

    configureUserDataCompatibility(setup.app);

    const migratedSession = JSON.parse(
      readFileSync(path.join(setup.canonical, "workspace-sessions", `${profileId}.json`), "utf8"),
    );
    expect(migratedSession).toEqual(sessionData);
  });

  it("migrates workspace-run-history/<profileId>.json alongside the profile files on first migration", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    const profileId = AWS_PROFILE[0].id;
    const historyData = {
      entries: [
        { runId: 7,  pipelineId: "fastsurfer", status: "success", createdAt: "2026-07-16T12:00:00.000Z" },
        { runId: 5,  pipelineId: "fmriprep",   status: "success", createdAt: "2026-07-16T10:00:00.000Z" },
        { runId: 4,  pipelineId: "pydeface",   status: "success", createdAt: "2026-07-16T09:00:00.000Z" },
      ],
    };
    mkdirSync(path.join(legacy, "workspace-run-history"), { recursive: true });
    writeFileSync(
      path.join(legacy, "workspace-run-history", `${profileId}.json`),
      JSON.stringify(historyData),
    );

    configureUserDataCompatibility(setup.app);

    const migratedHistory = JSON.parse(
      readFileSync(path.join(setup.canonical, "workspace-run-history", `${profileId}.json`), "utf8"),
    );
    expect(migratedHistory.entries).toHaveLength(3);
    expect(migratedHistory.entries[0].pipelineId).toBe("fastsurfer");
  });

  it("recursively migrates workspace-metadata/<profileId>/ tree alongside profile files on first migration", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    const profileId = AWS_PROFILE[0].id;
    const metadataSnapshot = { runs: [{ runId: 4, pipelineId: "pydeface" }, { runId: 5, pipelineId: "fmriprep" }] };
    const metaDir = path.join(legacy, "workspace-metadata", profileId);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(path.join(metaDir, "metadata.json"), JSON.stringify(metadataSnapshot));
    // Nested subdirectory to verify recursion.
    mkdirSync(path.join(metaDir, "sub"), { recursive: true });
    writeFileSync(path.join(metaDir, "sub", "extra.json"), JSON.stringify({ key: "value" }));

    configureUserDataCompatibility(setup.app);

    const migratedMeta = JSON.parse(
      readFileSync(path.join(setup.canonical, "workspace-metadata", profileId, "metadata.json"), "utf8"),
    );
    expect(migratedMeta.runs).toHaveLength(2);
    const nested = JSON.parse(
      readFileSync(path.join(setup.canonical, "workspace-metadata", profileId, "sub", "extra.json"), "utf8"),
    );
    expect(nested.key).toBe("value");
  });

  it("also migrates per-profile state when canonical already has profiles (post-3386212 upgrade path)", async () => {
    // This is exactly the situation a user faces after updating to the build that introduced the
    // rebrand migration (commit 3386212) but BEFORE this fix: workspace-profiles.json was already
    // copied into canonical, so hasWorkspaceProfiles(canonical) is true and the legacy branch was
    // never entered — leaving workspace-run-history and workspace-metadata absent.
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    // Simulate: profiles already migrated in a previous launch.
    writeProfiles(setup.canonical, AWS_PROFILE);
    // Legacy has per-profile state that was never migrated.
    writeProfiles(legacy, AWS_PROFILE);
    const profileId = AWS_PROFILE[0].id;
    const historyData = { entries: [{ runId: 11, pipelineId: "fastsurfer", status: "success" }] };
    mkdirSync(path.join(legacy, "workspace-run-history"), { recursive: true });
    writeFileSync(
      path.join(legacy, "workspace-run-history", `${profileId}.json`),
      JSON.stringify(historyData),
    );
    const metadataSnapshot = { runs: [{ runId: 11, pipelineId: "fastsurfer" }] };
    const metaDir = path.join(legacy, "workspace-metadata", profileId);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(path.join(metaDir, "metadata.json"), JSON.stringify(metadataSnapshot));

    const result = configureUserDataCompatibility(setup.app);

    expect(result).toMatchObject({ mode: "canonical", migrated: false }); // profile files were NOT re-migrated
    // Per-profile state must now be present in canonical.
    const migratedHistory = JSON.parse(
      readFileSync(path.join(setup.canonical, "workspace-run-history", `${profileId}.json`), "utf8"),
    );
    expect(migratedHistory.entries[0].pipelineId).toBe("fastsurfer");
    const migratedMeta = JSON.parse(
      readFileSync(path.join(setup.canonical, "workspace-metadata", profileId, "metadata.json"), "utf8"),
    );
    expect(migratedMeta.runs[0].runId).toBe(11);
  });

  it("does not overwrite existing per-profile state already present in canonical", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    const profileId = AWS_PROFILE[0].id;
    // Canonical already has its own run history (e.g. written by a newer Neuravian launch).
    writeProfiles(setup.canonical, AWS_PROFILE);
    mkdirSync(path.join(setup.canonical, "workspace-run-history"), { recursive: true });
    const existingHistory = { entries: [{ runId: 99, pipelineId: "mriqc", status: "success" }] };
    writeFileSync(
      path.join(setup.canonical, "workspace-run-history", `${profileId}.json`),
      JSON.stringify(existingHistory),
    );
    // Legacy has different (older) history.
    mkdirSync(path.join(legacy, "workspace-run-history"), { recursive: true });
    writeFileSync(
      path.join(legacy, "workspace-run-history", `${profileId}.json`),
      JSON.stringify({ entries: [{ runId: 1, pipelineId: "pydeface" }] }),
    );

    configureUserDataCompatibility(setup.app);

    // Canonical's own history must be preserved.
    const preserved = JSON.parse(
      readFileSync(path.join(setup.canonical, "workspace-run-history", `${profileId}.json`), "utf8"),
    );
    expect(preserved.entries[0].runId).toBe(99);
    expect(preserved.entries[0].pipelineId).toBe("mriqc");
  });

  it("handles missing per-profile state directories gracefully (source may simply not exist)", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    // No workspace-sessions, workspace-run-history, or workspace-metadata directories in legacy.

    expect(() => configureUserDataCompatibility(setup.app)).not.toThrow();

    // None of the per-profile state directories should be created in canonical either.
    const profileId = AWS_PROFILE[0].id;
    expect(existsSync(path.join(setup.canonical, "workspace-sessions", `${profileId}.json`))).toBe(false);
    expect(existsSync(path.join(setup.canonical, "workspace-run-history", `${profileId}.json`))).toBe(false);
    expect(existsSync(path.join(setup.canonical, "workspace-metadata", profileId))).toBe(false);
  });

  it("migrates per-profile state for every profile when there are multiple cloud profiles", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    const secondProfile = { ...AWS_PROFILE[0], id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "Second workspace" };
    const profiles = [AWS_PROFILE[0], secondProfile];
    writeProfiles(legacy, profiles);
    for (const profile of profiles) {
      mkdirSync(path.join(legacy, "workspace-run-history"), { recursive: true });
      writeFileSync(
        path.join(legacy, "workspace-run-history", `${profile.id}.json`),
        JSON.stringify({ entries: [{ runId: 1, pipelineId: "mriqc", profileId: profile.id }] }),
      );
    }

    configureUserDataCompatibility(setup.app);

    for (const profile of profiles) {
      const history = JSON.parse(
        readFileSync(path.join(setup.canonical, "workspace-run-history", `${profile.id}.json`), "utf8"),
      );
      expect(history.entries[0].profileId).toBe(profile.id);
    }
  });

  it("per-profile migration is idempotent: running twice produces identical files and no duplicates", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    const profileId = AWS_PROFILE[0].id;
    const historyData = { entries: [{ runId: 4, pipelineId: "pydeface" }] };
    mkdirSync(path.join(legacy, "workspace-run-history"), { recursive: true });
    writeFileSync(
      path.join(legacy, "workspace-run-history", `${profileId}.json`),
      JSON.stringify(historyData),
    );

    configureUserDataCompatibility(setup.app);
    configureUserDataCompatibility(setup.app);

    const history = JSON.parse(
      readFileSync(path.join(setup.canonical, "workspace-run-history", `${profileId}.json`), "utf8"),
    );
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].runId).toBe(4);
  });

  it("does NOT migrate run-cache (artifact binary files — re-downloadable on demand)", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    writeProfiles(legacy, AWS_PROFILE);
    const serverIdentity = AWS_PROFILE[0].serverIdentity;
    // Write a fake run-cache entry in legacy.
    const cacheDir = path.join(legacy, "run-cache", serverIdentity, "run-7", "artifacts");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path.join(cacheDir, "output.nii.gz"), Buffer.from("fake-nifti-data"));

    configureUserDataCompatibility(setup.app);

    // run-cache must not appear in canonical.
    expect(existsSync(path.join(setup.canonical, "run-cache"))).toBe(false);
  });
});
