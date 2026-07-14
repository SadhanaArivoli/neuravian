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
  await expect(runSystemChecks(root, { command: runner(failure), portAvailable: async () => true }))
    .rejects.toMatchObject({ kind });
}

describe("system checks", () => {
  it("reports Docker missing", async () => await expectKind("docker", "docker-missing"));
  it("reports a stopped Docker daemon", async () => await expectKind("daemon", "docker-stopped"));
  it("reports Docker Compose missing", async () => await expectKind("compose", "compose-missing"));

  it("records occupied ports for warm-stack detection", async () => {
    const facts = await runSystemChecks(root, { command: runner(undefined), portAvailable: async (port) => port !== 8000 });
    expect(facts.occupiedPorts).toEqual([8000]);
  });

  it("returns local system facts when every check passes", async () => {
    const facts = await runSystemChecks(root, { command: runner(undefined), portAvailable: async () => true });
    expect(facts.dockerVersion).toContain("Docker version");
    expect(facts.composeVersion).toContain("Compose");
    expect(facts.memoryGiB).toBeGreaterThan(0);
    expect(facts.diskAvailableGiB).toBeGreaterThan(0);
    expect(facts.occupiedPorts).toEqual([]);
  });
});
