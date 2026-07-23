import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDesktopConfig, saveDesktopConfig } from "../src/main/desktop-config.js";
import { belongsToDifferentMacUser, canonicalDirectory, isPathWithin } from "../src/main/dataset-root.js";

const temporary: string[] = [];
async function temp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "neuravian-dataset-root-"));
  temporary.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("per-user desktop dataset configuration", () => {
  it("recognizes a saved root belonging to another macOS user", () => {
    expect(belongsToDifferentMacUser("/Users/olduser/Documents", "/Users/testuser")).toBe(true);
    expect(belongsToDifferentMacUser("/Users/testuser/Documents", "/Users/testuser")).toBe(false);
  });
  it("creates a fresh config from the current user's Documents path", async () => {
    const root = await temp();
    const documents = path.join(root, "Users/testuser/Documents");
    const userData = path.join(root, "Users/testuser/Library/Application Support/neuravian-desktop");
    await mkdir(documents, { recursive: true });
    const config = await loadDesktopConfig(userData, { documentsPath: documents, homePath: path.join(root, "Users/testuser") });
    expect(config.datasetsDir).toBe(await realpath(documents));
  });

  it("migrates a stale root from another Mac user", async () => {
    const root = await temp();
    const documents = path.join(root, "Documents");
    const stale = path.join(root, "missing-other-user/Documents");
    const userData = path.join(root, "Application Support/neuravian-desktop");
    await mkdir(documents, { recursive: true });
    await mkdir(userData, { recursive: true });
    await writeFile(path.join(userData, "config.json"), JSON.stringify({ version: 1, datasetsDir: stale }));
    const migrations: string[] = [];
    const config = await loadDesktopConfig(userData, { documentsPath: documents, homePath: root, onMigration: (message) => migrations.push(message) });
    expect(config.datasetsDir).toBe(await realpath(documents));
    expect(migrations).toHaveLength(1);
  });

  it("resets a missing configured root without deleting unrelated files", async () => {
    const root = await temp();
    const documents = path.join(root, "Documents");
    const userData = path.join(root, "Application Support");
    await mkdir(documents, { recursive: true });
    await mkdir(userData, { recursive: true });
    await writeFile(path.join(userData, "config.json"), JSON.stringify({ version: 1, datasetsDir: path.join(root, "gone") }));
    await writeFile(path.join(userData, "keep.txt"), "user data");
    expect((await loadDesktopConfig(userData, { documentsPath: documents, homePath: root })).datasetsDir).toBe(await realpath(documents));
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(path.join(userData, "keep.txt"), "utf8"))).toBe("user data");
  });

  it("canonicalizes paths containing spaces", async () => {
    const root = await temp();
    const directory = path.join(root, "MRI Data", "BIDS Root");
    await mkdir(directory, { recursive: true });
    expect(await canonicalDirectory(`${directory}/../BIDS Root/`)).toBe(await realpath(directory));
  });

  it("persists only canonical existing directories", async () => {
    const root = await temp();
    const directory = path.join(root, "data");
    await mkdir(directory);
    await saveDesktopConfig(root, { datasetsDir: `${directory}/.` });
    expect((await loadDesktopConfig(root, { documentsPath: directory, homePath: root })).datasetsDir).toBe(await realpath(directory));
  });
});

describe("dataset containment", () => {
  it("accepts a dataset inside the root and the root itself", () => {
    expect(isPathWithin("/Users/testuser/Documents/OpenNeuro/ds000001", "/Users/testuser/Documents")).toBe(true);
    expect(isPathWithin("/Users/testuser/Documents", "/Users/testuser/Documents")).toBe(true);
  });

  it("rejects outside and sibling-prefix paths", () => {
    expect(isPathWithin("/Users/testuser/Downloads/ds000001", "/Users/testuser/Documents")).toBe(false);
    expect(isPathWithin("/Users/testuser/Documents/database", "/Users/testuser/Documents/data")).toBe(false);
  });

  it("canonicalization collapses traversal", async () => {
    const root = await temp();
    const documents = path.join(root, "Documents");
    const outside = path.join(root, "outside");
    await mkdir(documents); await mkdir(outside);
    expect(isPathWithin(await canonicalDirectory(path.join(documents, "../outside")), await canonicalDirectory(documents))).toBe(false);
  });

  it("resolves symlinks before containment decisions", async () => {
    const root = await temp();
    const documents = path.join(root, "Documents");
    const outside = path.join(root, "outside");
    await mkdir(documents); await mkdir(outside);
    const link = path.join(documents, "linked-dataset");
    await symlink(outside, link);
    expect(isPathWithin(await canonicalDirectory(link), await canonicalDirectory(documents))).toBe(false);
  });
});

describe("native dataset directory IPC", () => {
  it("exposes root selection and BIDS dataset selection through the isolated preload", async () => {
    const preload = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/preload/index.ts", import.meta.url), "utf8"));
    const main = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"));
    expect(preload).toContain('ipcRenderer.invoke("datasets:choose-root")');
    expect(preload).toContain('ipcRenderer.invoke("datasets:browse-for-folder")');
    expect(main).toContain('properties: ["openDirectory", "createDirectory"]');
    expect(main).toContain('buttons: ["Cancel", "Use parent folder"]');
    expect(main).toContain("isPathWithin(datasetPath, root)");
  });
});
