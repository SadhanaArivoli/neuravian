/**
 * Verifies that packaged-mode Compose invocations always receive correctly
 * resolved environment variables and never mount paths inside /Applications.
 */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesktopCompose, composeArguments, type ComposeContext } from "../src/main/compose.js";

const userData = "/Users/researcher/Library/Application Support/neuravian-desktop";
const bundleResources = "/Applications/Neuravian.app/Contents/Resources/app-resources";
const datasetsRoot = "/Users/researcher/Documents/MRI Data";

function packedCtx(): ComposeContext {
  return {
    resourcesRoot: bundleResources,
    dataDir: path.join(userData, "data"),
    dockerResourcesDir: path.join(userData, "resources"),
    datasetsDir: datasetsRoot,
    packaged: true,
  };
}

function devCtx(): ComposeContext {
  const root = "/Users/researcher/projects/neuravian";
  return {
    resourcesRoot: root,
    dataDir: path.join(root, "data"),
    dockerResourcesDir: root,
    datasetsDir: datasetsRoot,
    packaged: false,
  };
}

// ---------------------------------------------------------------------------
// composeArguments
// ---------------------------------------------------------------------------
describe("composeArguments — packaged", () => {
  it("selects exactly one compose file", () => {
    const args = composeArguments(packedCtx());
    const files = args.reduce<string[]>((acc, v, i, a) => {
      if (a[i - 1] === "-f") acc.push(v);
      return acc;
    }, []);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/docker-compose\.packaged\.yml$/);
  });

  it("compose file is inside the app bundle (resourcesRoot), not userData", () => {
    const ctx = packedCtx();
    const args = composeArguments(ctx);
    const file = args[args.indexOf("-f") + 1];
    expect(file.startsWith(bundleResources)).toBe(true);
    expect(file.startsWith(userData)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DesktopCompose.environment — tested via a command-capturing spy
// ---------------------------------------------------------------------------
describe("DesktopCompose environment — packaged", () => {
  async function captureEnv(ctx: ComposeContext): Promise<NodeJS.ProcessEnv> {
    let captured: NodeJS.ProcessEnv = {};
    const spy = vi.fn(async (_cmd: string, _args: readonly string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      captured = opts?.env ?? {};
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const compose = new DesktopCompose(ctx, spy, "/usr/local/bin/docker");
    // Trigger start() which calls environment() internally.
    await compose.start();
    return captured;
  }

  it("always injects NEURAVIAN_DATA_DIR", async () => {
    const env = await captureEnv(packedCtx());
    expect(env["NEURAVIAN_DATA_DIR"]).toBe(path.join(userData, "data"));
  });

  it("always injects NEURAVIAN_RESOURCES_DIR", async () => {
    const env = await captureEnv(packedCtx());
    expect(env["NEURAVIAN_RESOURCES_DIR"]).toBe(path.join(userData, "resources"));
  });

  it("injects the fully resolved per-user HOST_DATASETS_DIR", async () => {
    const env = await captureEnv(packedCtx());
    expect(env["HOST_DATASETS_DIR"]).toBe(datasetsRoot);
    expect(env["HOST_DATASETS_DIR"]).not.toContain("~");
  });

  it("NEURAVIAN_DATA_DIR is never inside /Applications", async () => {
    const env = await captureEnv(packedCtx());
    expect(env["NEURAVIAN_DATA_DIR"]!.startsWith("/Applications")).toBe(false);
  });

  it("NEURAVIAN_RESOURCES_DIR is never inside /Applications", async () => {
    const env = await captureEnv(packedCtx());
    expect(env["NEURAVIAN_RESOURCES_DIR"]!.startsWith("/Applications")).toBe(false);
  });

  it("NEURAVIAN_DATA_DIR is under the userData directory", async () => {
    const env = await captureEnv(packedCtx());
    expect(env["NEURAVIAN_DATA_DIR"]!.startsWith(userData)).toBe(true);
  });

  it("NEURAVIAN_RESOURCES_DIR is under the userData directory", async () => {
    const env = await captureEnv(packedCtx());
    expect(env["NEURAVIAN_RESOURCES_DIR"]!.startsWith(userData)).toBe(true);
  });

  it("NEURAVIAN_RESOURCES_DIR differs from NEURAVIAN_DATA_DIR", async () => {
    const env = await captureEnv(packedCtx());
    expect(env["NEURAVIAN_RESOURCES_DIR"]).not.toBe(env["NEURAVIAN_DATA_DIR"]);
  });

  it("dev mode also injects both env vars", async () => {
    const env = await captureEnv(devCtx());
    expect(env["NEURAVIAN_DATA_DIR"]).toBeDefined();
    expect(env["NEURAVIAN_RESOURCES_DIR"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// pull() also receives the environment
// ---------------------------------------------------------------------------
describe("DesktopCompose.pull environment", () => {
  it("pull injects NEURAVIAN_DATA_DIR and NEURAVIAN_RESOURCES_DIR", async () => {
    let captured: NodeJS.ProcessEnv = {};
    const spy = vi.fn(async (_cmd: string, _args: readonly string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      captured = opts?.env ?? {};
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const compose = new DesktopCompose(packedCtx(), spy, "/usr/local/bin/docker");
    await compose.pull();
    expect(captured["NEURAVIAN_DATA_DIR"]).toBeDefined();
    expect(captured["NEURAVIAN_RESOURCES_DIR"]).toBeDefined();
    expect(captured["NEURAVIAN_DATA_DIR"]!.startsWith("/Applications")).toBe(false);
    expect(captured["NEURAVIAN_RESOURCES_DIR"]!.startsWith("/Applications")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// composeCwd — packaged mode must never use /Applications as cwd
// ---------------------------------------------------------------------------
describe("DesktopCompose cwd — packaged", () => {
  function captureCwd(ctx: ComposeContext): Promise<string> {
    return new Promise((resolve) => {
      const spy = vi.fn(async (_cmd: string, _args: readonly string[], opts?: { cwd?: string }) => {
        resolve(opts?.cwd ?? "");
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      new DesktopCompose(ctx, spy, "/usr/local/bin/docker").start();
    });
  }

  it("packaged mode uses dataDir as cwd, not resourcesRoot", async () => {
    const ctx = packedCtx();
    const cwd = await captureCwd(ctx);
    expect(cwd).toBe(ctx.dataDir);
    expect(cwd).not.toBe(ctx.resourcesRoot);
  });

  it("packaged cwd is never inside /Applications", async () => {
    const cwd = await captureCwd(packedCtx());
    expect(cwd.startsWith("/Applications")).toBe(false);
  });

  it("packaged cwd is under the userData directory", async () => {
    const cwd = await captureCwd(packedCtx());
    expect(cwd.startsWith(userData)).toBe(true);
  });

  it("dev mode uses resourcesRoot as cwd", async () => {
    const ctx = devCtx();
    const cwd = await captureCwd(ctx);
    expect(cwd).toBe(ctx.resourcesRoot);
  });
});

// ---------------------------------------------------------------------------
// electron-builder.yml must not bundle docker-compose.yml (the dev file)
// ---------------------------------------------------------------------------
describe("electron-builder.yml — no dev compose in bundle", () => {
  it("does not copy the root docker-compose.yml into app-resources", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(
      new URL("../electron-builder.yml", import.meta.url),
      "utf8",
    );
    // The dev compose file must not be bundled — it has build: contexts and
    // source-code mounts that break packaged mode and confuse Docker Compose
    // project-directory discovery when cwd is app-resources.
    const lines = text.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    const problematic = lines.filter(
      (l) => l.includes("docker-compose.yml") && !l.includes("packaged") && !l.includes("desktop"),
    );
    expect(problematic).toHaveLength(0);
  });
});
