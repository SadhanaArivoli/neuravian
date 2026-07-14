import { describe, expect, it, vi } from "vitest";
import { CommandError } from "../src/main/command.js";
import { runSystemChecks, SystemCheckError, type CommandRunner } from "../src/main/system-checks.js";

const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const ok = (stdout: string) => Promise.resolve({ stdout, stderr: "", exitCode: 0 });

function runner(failure: "docker" | "daemon" | "compose" | undefined): CommandRunner {
  return vi.fn(async (command, args) => {
    if (failure === "docker" && args[0] === "--version") throw new CommandError("not found", command, undefined, "ENOENT");
    if (failure === "daemon" && args[0] === "info") throw new CommandError("stopped", command);
    if (failure === "compose" && args[0] === "compose") throw new CommandError("missing", command);
    if (command === "sw_vers") return await ok("15.5");
    return await ok(args[0] === "compose" ? "Docker Compose version v2" : "Docker version 27");
  });
}

async function expectKind(failure: Parameters<typeof runner>[0], kind: SystemCheckError["kind"]): Promise<void> {
  await expect(runSystemChecks(root, {
    command: runner(failure), portAvailable: async () => true,
    resolveDocker: async () => failure === "docker" ? undefined : "/usr/local/bin/docker",
  }))
    .rejects.toMatchObject({ kind });
}

describe("system checks", () => {
  it("reports Docker missing", async () => await expectKind("docker", "docker-missing"));
  it("reports a stopped Docker daemon", async () => await expectKind("daemon", "docker-stopped"));
  it("reports Docker Compose missing", async () => await expectKind("compose", "compose-missing"));

  it.each([
    ["daemon", "docker-stopped", undefined],
    ["compose", "compose-missing", "unavailable"],
  ] as const)("preserves resolved Docker diagnostics when %s fails", async (failure, kind, composeVersion) => {
    let error: SystemCheckError | undefined;
    try {
      await runSystemChecks(root, {
        command: runner(failure), portAvailable: async () => true,
        resolveDocker: async () => "/usr/local/bin/docker",
      });
    } catch (caught) {
      error = caught as SystemCheckError;
    }
    expect(error).toMatchObject({ kind, facts: { dockerPath: "/usr/local/bin/docker", dockerVersion: "Docker version 27" } });
    expect(error?.facts?.composeVersion).toBe(composeVersion);
  });

  it("records occupied ports for warm-stack detection", async () => {
    const facts = await runSystemChecks(root, {
      command: runner(undefined), portAvailable: async (port) => port !== 8000,
      resolveDocker: async () => "/usr/local/bin/docker",
    });
    expect(facts.occupiedPorts).toEqual([8000]);
  });

  it("returns local system facts when every check passes", async () => {
    const command = runner(undefined);
    const facts = await runSystemChecks(root, {
      command, portAvailable: async () => true, resolveDocker: async () => "/usr/local/bin/docker",
    });
    expect(facts.dockerVersion).toContain("Docker version");
    expect(facts.dockerPath).toBe("/usr/local/bin/docker");
    expect(facts.composeVersion).toContain("Compose");
    expect(vi.mocked(command).mock.calls.filter((call) => call[1][0] === "--version")[0]?.[0]).toBe("/usr/local/bin/docker");
    expect(vi.mocked(command).mock.calls.filter((call) => call[1][0] === "info")[0]?.[0]).toBe("/usr/local/bin/docker");
    expect(vi.mocked(command).mock.calls.filter((call) => call[1][0] === "compose")[0]?.[0]).toBe("/usr/local/bin/docker");
    expect(facts.memoryGiB).toBeGreaterThan(0);
    expect(facts.diskAvailableGiB).toBeGreaterThan(0);
    expect(facts.occupiedPorts).toEqual([]);
  });
});
