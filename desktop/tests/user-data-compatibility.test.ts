import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

describe("configureUserDataCompatibility", () => {
  it("uses the canonical path for a new installation", async () => {
    const setup = await fixture();
    const result = configureUserDataCompatibility(setup.app);
    expect(result.mode).toBe("canonical");
    expect(setup.selected()).toBe(setup.canonical);
  });

  it("keeps an existing legacy profile in place without moving it", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "workspace-profiles.json"), "[]\n");
    const result = configureUserDataCompatibility(setup.app);
    expect(result).toMatchObject({ mode: "legacy-compatible", activePath: legacy, legacyPath: legacy });
    expect(setup.selected()).toBe(legacy);
  });

  it("prefers populated canonical data when both identities exist", async () => {
    const setup = await fixture();
    mkdirSync(setup.canonical);
    writeFileSync(path.join(setup.canonical, "window-state.json"), "{}\n");
    const legacy = path.join(setup.appData, "NeuroForge");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "window-state.json"), "{}\n");
    const result = configureUserDataCompatibility(setup.app);
    expect(result.mode).toBe("canonical");
    expect(setup.selected()).toBe(setup.canonical);
  });

  it("does not move, copy, or delete the legacy directory", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "neuroforge-desktop");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "workspaces.json"), "[]\n");
    configureUserDataCompatibility(setup.app);
    // File must still exist exactly where it was.
    expect(existsSync(path.join(legacy, "workspaces.json"))).toBe(true);
    // Canonical directory must NOT have been created by the compatibility shim.
    expect(existsSync(setup.canonical)).toBe(false);
  });

  it("reports the legacy path for diagnostic logging", async () => {
    const setup = await fixture();
    const legacy = path.join(setup.appData, "NeuroForge");
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "prefs.json"), "{}\n");
    const result = configureUserDataCompatibility(setup.app);
    expect(result.legacyPath).toBe(legacy);
    expect(result.activePath).toBe(legacy);
    expect(result.canonicalPath).toBe(setup.canonical);
  });

  it("uses canonical path for a completely fresh installation (no legacy directories)", async () => {
    const setup = await fixture();
    const result = configureUserDataCompatibility(setup.app);
    expect(result.mode).toBe("canonical");
    expect(result.legacyPath).toBeNull();
    expect(setup.selected()).toBe(setup.canonical);
  });
});
