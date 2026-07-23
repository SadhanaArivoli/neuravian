import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimePaths, findRepositoryRoot, isRepositoryRoot } from "../src/main/paths.js";

const tmp: string[] = [];
afterEach(async () => {
  await Promise.all(tmp.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "neuravian-repo-"));
  tmp.push(root);
  await Promise.all([
    mkdir(path.join(root, "backend"), { recursive: true }),
    mkdir(path.join(root, "frontend"), { recursive: true }),
    mkdir(path.join(root, "pipelines"), { recursive: true }),
    mkdir(path.join(root, "plugins"), { recursive: true }),
    writeFile(path.join(root, "docker-compose.yml"), "services: {}\n"),
  ]);
  return root;
}

async function makeEmpty(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "neuravian-empty-"));
  tmp.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// isRepositoryRoot
// ---------------------------------------------------------------------------
describe("isRepositoryRoot", () => {
  it("returns true for a directory with all required entries", async () => {
    const root = await makeRepo();
    expect(isRepositoryRoot(root)).toBe(true);
  });

  it("returns false when docker-compose.yml is missing", async () => {
    const root = await makeEmpty();
    await Promise.all([
      mkdir(path.join(root, "backend")),
      mkdir(path.join(root, "frontend")),
      mkdir(path.join(root, "pipelines")),
      mkdir(path.join(root, "plugins")),
    ]);
    expect(isRepositoryRoot(root)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findRepositoryRoot
// ---------------------------------------------------------------------------
describe("findRepositoryRoot", () => {
  it("finds the repo by walking up from a subdirectory", async () => {
    const root = await makeRepo();
    const sub = path.join(root, "desktop", "build", "main");
    await mkdir(sub, { recursive: true });
    expect(findRepositoryRoot(sub)).toBe(root);
  });

  it("honours the NEURAVIAN_REPO_ROOT override", async () => {
    const root = await makeRepo();
    const empty = await makeEmpty();
    expect(findRepositoryRoot(empty, root)).toBe(root);
  });

  it("throws when no repository root can be found", async () => {
    const empty = await makeEmpty();
    expect(() => findRepositoryRoot(empty, undefined)).toThrow("Could not locate the Neuravian repository");
  });
});

// ---------------------------------------------------------------------------
// resolveRuntimePaths — development mode
// ---------------------------------------------------------------------------
describe("resolveRuntimePaths — development", () => {
  it("uses the repository root and data/ subdir when not packaged", async () => {
    const root = await makeRepo();
    const subDir = path.join(root, "desktop", "build", "main");
    await mkdir(subDir, { recursive: true });

    const result = resolveRuntimePaths({
      isPackaged: false,
      resourcesPath: "/unused",
      userDataPath: "/unused",
      dirname: subDir,
    });

    expect(result.packaged).toBe(false);
    expect(result.resourcesRoot).toBe(root);
    expect(result.dataDir).toBe(path.join(root, "data"));
    // In dev mode, dockerResourcesDir is the repo root (already under /Users/).
    expect(result.dockerResourcesDir).toBe(root);
  });

  it("throws when no repository root can be found in development", async () => {
    const empty = await makeEmpty();
    expect(() => resolveRuntimePaths({
      isPackaged: false,
      resourcesPath: "/unused",
      userDataPath: "/unused",
      dirname: empty,
    })).toThrow("Could not locate the Neuravian repository");
  });

  it("NEURAVIAN_REPO_ROOT override is honoured via findRepositoryRoot directly", async () => {
    const root = await makeRepo();
    const empty = await makeEmpty();
    // resolveRuntimePaths calls findRepositoryRoot(dirname, process.env.NEURAVIAN_REPO_ROOT)
    // Test the override through findRepositoryRoot directly since env mutation in tests is fragile.
    expect(findRepositoryRoot(empty, root)).toBe(root);
  });
});

// ---------------------------------------------------------------------------
// resolveRuntimePaths — packaged mode
// ---------------------------------------------------------------------------
describe("resolveRuntimePaths — packaged", () => {
  it("uses resourcesPath/app-resources and userData/data when packaged", () => {
    const userData = "/Users/researcher/Library/Application Support/neuravian-desktop";
    const result = resolveRuntimePaths({
      isPackaged: true,
      resourcesPath: "/Applications/Neuravian.app/Contents/Resources",
      userDataPath: userData,
      dirname: "/Applications/Neuravian.app/Contents/Resources/app.asar/build/main",
    });

    expect(result.packaged).toBe(true);
    expect(result.resourcesRoot).toBe(
      "/Applications/Neuravian.app/Contents/Resources/app-resources",
    );
    expect(result.dataDir).toBe(`${userData}/data`);
    // dockerResourcesDir must be under userData (/Users/…), never under /Applications.
    expect(result.dockerResourcesDir).toBe(`${userData}/resources`);
    expect(result.dockerResourcesDir).not.toContain("/Applications");
  });

  it("does not attempt repository root search when packaged", () => {
    // Even with a dirname that has no repository above it, packaged mode must not throw.
    expect(() => resolveRuntimePaths({
      isPackaged: true,
      resourcesPath: "/Applications/Neuravian.app/Contents/Resources",
      userDataPath: "/Users/researcher/Library/Application Support/neuravian-desktop",
      dirname: "/tmp/no-repo-here",
    })).not.toThrow();
  });

  it("never returns the source repository root when packaged", () => {
    // Packaged apps must be self-contained; they must not reach back to the dev machine.
    const result = resolveRuntimePaths({
      isPackaged: true,
      resourcesPath: "/Applications/Neuravian.app/Contents/Resources",
      userDataPath: "/Users/researcher/Library/Application Support/neuravian-desktop",
      dirname: "/Applications/Neuravian.app/Contents/Resources/app.asar/build/main",
    });
    expect(result.resourcesRoot).toContain("Contents/Resources");
    expect(result.resourcesRoot).not.toContain("neuravian-desktop/build");
  });

  it("both Docker volume paths are under /Users when packaged", () => {
    const result = resolveRuntimePaths({
      isPackaged: true,
      resourcesPath: "/Applications/Neuravian.app/Contents/Resources",
      userDataPath: "/Users/researcher/Library/Application Support/neuravian-desktop",
      dirname: "/Applications/Neuravian.app/Contents/Resources/app.asar/build/main",
    });
    // Neither Docker mount source may point into /Applications.
    expect(result.dataDir.startsWith("/Applications")).toBe(false);
    expect(result.dockerResourcesDir.startsWith("/Applications")).toBe(false);
    expect(result.dataDir.startsWith("/Users")).toBe(true);
    expect(result.dockerResourcesDir.startsWith("/Users")).toBe(true);
  });
});
