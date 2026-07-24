import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
});
