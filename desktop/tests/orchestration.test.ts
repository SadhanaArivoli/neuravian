import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesktopCompose, composeArguments } from "../src/main/compose.js";
import { formatDiagnostics, redactDiagnostics } from "../src/main/diagnostics.js";
import { BACKEND_HEALTH_URL, FRONTEND_URL, HealthTimeoutError, waitForService } from "../src/main/health.js";
import { StartupController, type StartupDependencies } from "../src/main/startup.js";
import { StartupStateStore } from "../src/main/state-store.js";
import { DesktopLogger } from "../src/main/logger.js";
import type { StartupUpdate, SystemFacts } from "../src/main/types.js";

const root = path.join(os.tmpdir(), "neuravian-fixture");
const ctx = { resourcesRoot: root, dataDir: path.join(root, "data"), dockerResourcesDir: root, packaged: false };
const facts: SystemFacts = {
  macOSVersion: "15.5", architecture: "arm64", memoryGiB: 16, diskAvailableGiB: 100,
  dockerVersion: "Docker 27", dockerPath: "/usr/local/bin/docker", composeVersion: "Compose v2", repositoryRoot: root, occupiedPorts: [],
};

function composeMock(packaged = false) {
  return {
    ctx: { ...ctx, packaged },
    start: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    stop: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    pull: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    attachExternal: vi.fn(),
    setDockerPath: vi.fn(),
    inspectStack: vi.fn(async () => ({
      detected: false, project: "neuravian-desktop", compatible: false, running: false,
      reasons: ["no managed containers detected"], expectedVersion: null, containers: [],
    })),
    // Allow tests to simulate packaged mode without constructing a real DesktopCompose.
    get ownsServices() { return false; },
    _packaged: packaged,
  } as unknown as DesktopCompose;
}

function dependencies(overrides: Partial<StartupDependencies> = {}): StartupDependencies {
  return {
    systemChecks: vi.fn(async () => facts),
    wait: vi.fn(async () => undefined),
    probe: vi.fn(async (url) => ({ healthy: false, url })),
    now: (() => { let time = 0; return () => ++time; })(),
    makeAttemptId: vi.fn(() => "attempt-1"),
    runtimeIdentity: vi.fn(async () => ({ compatible: true, reasons: [], frontendCommit: "current", backendVersion: "0.1.0" })),
    ...overrides,
  };
}

function controller(compose = composeMock(), updates: StartupUpdate[] = [], deps = dependencies()) {
  return new StartupController(ctx, compose, (update) => updates.push(update), vi.fn(), deps);
}

describe("Compose orchestration", () => {
  it("uses the canonical Compose file plus localhost-only override", () => {
    const args = composeArguments(ctx).join(" ");
    expect(args).toContain(`${root}/docker-compose.yml`);
    expect(args).toContain(`${root}/desktop/docker-compose.desktop.yml`);
    expect(args).toContain("neuravian-desktop");
  });

  it("includes packaged overlay in packaged mode", () => {
    const packedCtx = { resourcesRoot: root, dataDir: path.join(root, "data"), dockerResourcesDir: root, packaged: true };
    const args = composeArguments(packedCtx).join(" ");
    expect(args).toContain("docker-compose.packaged.yml");
    expect(args).not.toContain("--build");
  });

  it("stops only services owned by this launcher and never removes volumes", async () => {
    const calls: string[][] = [];
    const command = vi.fn(async (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    compose.attachExternal();
    expect(await compose.stop()).toBeUndefined();
    await compose.start();
    await compose.stop();
    expect(calls).toHaveLength(2);
    expect(command.mock.calls.every((call) => call[0] === "/usr/local/bin/docker")).toBe(true);
    expect(calls[0]).toContain("up");
    expect(calls[1].at(-1)).toBe("stop");
    expect(calls.flat()).not.toContain("down");
    expect(calls.flat()).not.toContain("-v");
  });

  it("force-recreates containers without down or volume removal", async () => {
    const calls: string[][] = [];
    const command = vi.fn(async (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const compose = new DesktopCompose(ctx, command, "/usr/local/bin/docker");
    await compose.start(true);
    expect(calls[0]).toContain("--force-recreate");
    expect(calls[0]).not.toContain("down");
    expect(calls[0]).not.toContain("-v");
    expect(calls[0]).not.toContain("--volumes");
  });
});

describe("health checks and startup", () => {
  it.each(["backend", "frontend"] as const)("reports a %s startup timeout", async (service) => {
    const url = service === "backend" ? BACKEND_HEALTH_URL : FRONTEND_URL;
    await expect(waitForService(service, url, {
      timeoutMs: 1, intervalMs: 1,
      fetcher: vi.fn(async () => new Response(null, { status: 503 })),
    })).rejects.toBeInstanceOf(HealthTimeoutError);
  });

  it("uses the centralized canonical /api/health endpoint", () => {
    expect(BACKEND_HEALTH_URL).toBe("http://127.0.0.1:8000/api/health");
    expect(BACKEND_HEALTH_URL).not.toMatch(/:8000\/health$/);
    expect(FRONTEND_URL).toBe("http://127.0.0.1:3000");
  });

  it("does not spin forever when /health would return 404", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(waitForService("backend", BACKEND_HEALTH_URL, { timeoutMs: 50, intervalMs: 1, fetcher })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toBe(BACKEND_HEALTH_URL);
  });

  it("cold-starts Compose and waits for backend then frontend", async () => {
    const updates: StartupUpdate[] = [];
    const compose = composeMock();
    const wait = vi.fn(async () => undefined);
    const instance = controller(compose, updates, dependencies({ wait }));
    await expect(instance.run()).resolves.toBe(true);
    expect(compose.start).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.state)).toEqual([
      "checking-system", "starting", "backend-starting", "frontend-starting", "ready",
    ]);
    expect(wait.mock.calls[0].slice(0, 2)).toEqual(["backend", BACKEND_HEALTH_URL]);
    expect(wait.mock.calls[1].slice(0, 2)).toEqual(["frontend", FRONTEND_URL]);
  });

  it("attaches only to a compatible current managed stack", async () => {
    const warmFacts = { ...facts, occupiedPorts: [8000, 3000] };
    const compose = composeMock();
    vi.mocked(compose.inspectStack).mockResolvedValue({
      detected: true, project: "neuravian-desktop", compatible: true, running: true,
      reasons: [], expectedVersion: "0.1.0", containers: [],
    });
    const updates: StartupUpdate[] = [];
    const deps = dependencies({
      systemChecks: vi.fn(async () => warmFacts),
      probe: vi.fn(async (url) => ({ healthy: true, status: 200, url })),
    });
    await expect(controller(compose, updates, deps).run()).resolves.toBe(true);
    expect(compose.attachExternal).toHaveBeenCalledTimes(1);
    expect(compose.start).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ state: "ready", detail: expect.stringContaining("existing") });
  });

  it.each([
    ["stale frontend image", "frontend image ID differs"],
    ["stale backend image", "backend image ID differs"],
    ["changed Compose configuration", "backend Compose configuration differs"],
  ])("force-recreates a managed stack with %s", async (_label, reason) => {
    const compose = composeMock();
    vi.mocked(compose.inspectStack)
      .mockResolvedValueOnce({ detected: true, project: "neuravian-desktop", compatible: false, running: true, reasons: [reason], expectedVersion: "0.1.0", containers: [] })
      .mockResolvedValueOnce({ detected: true, project: "neuravian-desktop", compatible: true, running: true, reasons: [], expectedVersion: "0.1.0", containers: [] });
    await expect(controller(compose, [], dependencies({
      systemChecks: vi.fn(async () => ({ ...facts, occupiedPorts: [8000, 3000] })),
      probe: vi.fn(async (url) => ({ healthy: true, status: 200, url })),
    })).run()).resolves.toBe(true);
    expect(compose.start).toHaveBeenCalledWith(true);
    expect(compose.attachExternal).not.toHaveBeenCalled();
  });

  it("rejects unrelated healthy services occupying the ports", async () => {
    const compose = composeMock();
    const result = await controller(compose, [], dependencies({
      systemChecks: vi.fn(async () => ({ ...facts, occupiedPorts: [8000, 3000] })),
      probe: vi.fn(async (url) => ({ healthy: true, status: 200, url })),
    })).run();
    expect(result).toBe(false);
    expect(compose.attachExternal).not.toHaveBeenCalled();
    expect(compose.start).not.toHaveBeenCalled();
  });

  it("recreates stopped old Neuravian containers", async () => {
    const compose = composeMock();
    vi.mocked(compose.inspectStack)
      .mockResolvedValueOnce({ detected: true, project: "neuravian-desktop", compatible: false, running: false, reasons: ["frontend image ID differs"], expectedVersion: "0.1.0", containers: [] })
      .mockResolvedValueOnce({ detected: true, project: "neuravian-desktop", compatible: true, running: true, reasons: [], expectedVersion: "0.1.0", containers: [] });
    await controller(compose).run();
    expect(compose.start).toHaveBeenCalledWith(true);
  });

  it("does not force recreation when no managed containers exist", async () => {
    const compose = composeMock();
    await controller(compose).run();
    expect(compose.start).toHaveBeenCalledWith(false);
  });

  it("handles a frontend that is ready before backend polling completes", async () => {
    const wait = vi.fn(async () => undefined);
    await controller(composeMock(), [], dependencies({
      probe: vi.fn(async (url) => ({ healthy: url === FRONTEND_URL, status: url === FRONTEND_URL ? 200 : undefined, url })),
      wait,
    })).run();
    expect(wait.mock.calls.map((call) => call[0])).toEqual(["backend", "frontend"]);
  });

  it("renders a visible recoverable failure with stage and elapsed time", async () => {
    const updates: StartupUpdate[] = [];
    await controller(composeMock(), updates, dependencies({
      systemChecks: vi.fn(async () => { throw new Error("broken check"); }),
    })).run();
    expect(updates.at(-1)).toMatchObject({ state: "failed", recoverable: true, stage: "system checks" });
    expect(updates.at(-1)?.elapsedMs).toBeGreaterThan(0);
  });

  it("allows retry after a failed attempt", async () => {
    const checks = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(facts);
    let attempt = 0;
    const deps = dependencies({ systemChecks: checks, makeAttemptId: () => `attempt-${++attempt}` });
    const instance = controller(composeMock(), [], deps);
    await expect(instance.run()).resolves.toBe(false);
    await expect(instance.retry()).resolves.toBe(true);
    expect(checks).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repeated startup and Retry requests", async () => {
    let release!: (facts: SystemFacts) => void;
    const pending = new Promise<SystemFacts>((resolve) => { release = resolve; });
    const checks = vi.fn(async () => await pending);
    const compose = composeMock();
    const instance = controller(compose, [], dependencies({ systemChecks: checks }));
    const first = instance.run();
    const second = instance.run();
    const retry = instance.retry();
    expect(first).toBe(second);
    expect(second).toBe(retry);
    release(facts);
    await first;
    expect(checks).toHaveBeenCalledTimes(1);
    expect(compose.start).toHaveBeenCalledTimes(1);
  });
});

describe("renderer state replay", () => {
  const ready: StartupUpdate = { state: "ready", title: "Ready", detail: "Healthy", attemptId: "a1" };

  it("replays Ready to a renderer that subscribes late", () => {
    const store = new StartupStateStore({ state: "checking-system", title: "Checking", detail: "Starting" });
    store.set(ready);
    const received: StartupUpdate[] = [];
    store.subscribe((update) => received.push(update));
    expect(received).toEqual([ready]);
  });

  it("returns current Ready state when the event preceded listener registration", () => {
    const store = new StartupStateStore(ready);
    expect(store.get()).toEqual(ready);
  });

  it("does not duplicate listeners after unsubscribe", () => {
    const store = new StartupStateStore(ready);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.set({ ...ready, detail: "updated" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.listenerCount).toBe(0);
  });

  it("startup shell queries state and reports Ready before main URL switch", async () => {
    const renderer = await readFile(new URL("../src/renderer/app.js", import.meta.url), "utf8");
    const main = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    expect(renderer).toContain("getStartupState().then(applyStartupUpdate)");
    expect(renderer).toContain("reportStartupStateReceived(update)");
    expect(main).toContain('ipcMain.handle("startup:get-state"');
    expect(main).toContain("loadMainApplication()");
  });
});

describe("diagnostics privacy", () => {
  it("writes concurrent startup traces in stage order and redacts private values", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "neuravian-logger-"));
    try {
      const logger = await DesktopLogger.create(directory);
      const writes = [
        logger.trace({ stage: 1, name: "first" }),
        logger.trace({ stage: 2, name: "second", detail: "/Users/alice/private token=abcd" }),
        logger.trace({ stage: 3, name: "third" }),
      ];
      await Promise.all(writes);
      const output = await readFile(logger.filePath, "utf8");
      expect(output.match(/stage=\d/g)).toEqual(["stage=1", "stage=2", "stage=3"]);
      expect(output).not.toContain("alice");
      expect(output).not.toContain("abcd");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts home paths and credentials", () => {
    const value = redactDiagnostics("/Users/alice/private token=abcd password=hunter2", "/Users/alice");
    expect(value).toContain("~/private");
    expect(value).not.toContain("alice");
    expect(value).not.toContain("abcd");
    expect(value).not.toContain("hunter2");
  });

  it("formats a useful diagnostic report", () => {
    const output = formatDiagnostics({ update: { state: "failed", title: "Startup failed", detail: "No daemon" }, facts });
    expect(output).toContain("Neuravian desktop diagnostics");
    expect(output).toContain("Docker 27");
    expect(output).toContain("dockerPath: /usr/local/bin/docker");
    expect(output).toContain("composeVersion: Compose v2");
  });
});
