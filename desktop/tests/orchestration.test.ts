import { describe, expect, it, vi } from "vitest";
import { DesktopCompose, composeArguments } from "../src/main/compose.js";
import { formatDiagnostics, redactDiagnostics } from "../src/main/diagnostics.js";
import { BACKEND_HEALTH_URL, FRONTEND_URL, HealthTimeoutError, waitForService } from "../src/main/health.js";
import { StartupController } from "../src/main/startup.js";
import type { StartupUpdate, SystemFacts } from "../src/main/types.js";

const root = "/tmp/neuroforge-fixture";
const facts: SystemFacts = {
  macOSVersion: "15.5", architecture: "arm64", memoryGiB: 16, diskAvailableGiB: 100,
  dockerVersion: "Docker 27", composeVersion: "Compose v2", repositoryRoot: root,
};

describe("Compose orchestration", () => {
  it("uses the canonical Compose file plus localhost-only override", () => {
    const args = composeArguments(root).join(" ");
    expect(args).toContain(`${root}/docker-compose.yml`);
    expect(args).toContain(`${root}/desktop/docker-compose.desktop.yml`);
    expect(args).toContain("neuroforge-desktop");
  });

  it("stops only services owned by this launcher and never removes volumes", async () => {
    const calls: string[][] = [];
    const command = vi.fn(async (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const compose = new DesktopCompose(root, command);
    expect(await compose.stop()).toBeUndefined();
    await compose.start();
    await compose.stop();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("up");
    expect(calls[1].at(-1)).toBe("stop");
    expect(calls.flat()).not.toContain("down");
    expect(calls.flat()).not.toContain("-v");
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

  it("uses localhost-only health and application URLs", () => {
    expect(BACKEND_HEALTH_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(FRONTEND_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(BACKEND_HEALTH_URL).not.toContain("0.0.0.0");
  });

  it("performs a successful startup in order", async () => {
    const updates: StartupUpdate[] = [];
    const compose = { start: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) } as unknown as DesktopCompose;
    const wait = vi.fn(async () => undefined);
    const controller = new StartupController(root, compose, (update) => updates.push(update), {
      systemChecks: vi.fn(async () => facts), wait,
    });
    await expect(controller.run()).resolves.toBe(true);
    expect(updates.map((update) => update.state)).toEqual([
      "checking-system", "starting", "backend-starting", "frontend-starting", "ready",
    ]);
    expect(wait).toHaveBeenNthCalledWith(1, "backend", BACKEND_HEALTH_URL);
    expect(wait).toHaveBeenNthCalledWith(2, "frontend", FRONTEND_URL);
  });

  it("allows retry after a failed attempt", async () => {
    const compose = { start: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) } as unknown as DesktopCompose;
    const systemChecks = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(facts);
    const states: string[] = [];
    const controller = new StartupController(root, compose, (update) => states.push(update.state), {
      systemChecks, wait: vi.fn(async () => undefined),
    });
    await expect(controller.run()).resolves.toBe(false);
    await expect(controller.run()).resolves.toBe(true);
    expect(systemChecks).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("ready");
  });
});

describe("diagnostics privacy", () => {
  it("redacts home paths and credentials", () => {
    const value = redactDiagnostics("/Users/alice/private token=abcd password=hunter2", "/Users/alice");
    expect(value).toContain("~/private");
    expect(value).not.toContain("alice");
    expect(value).not.toContain("abcd");
    expect(value).not.toContain("hunter2");
  });

  it("formats a useful diagnostic report", () => {
    const output = formatDiagnostics({ update: { state: "failed", title: "Startup failed", detail: "No daemon" }, facts });
    expect(output).toContain("NeuroForge desktop diagnostics");
    expect(output).toContain("Docker 27");
  });
});
