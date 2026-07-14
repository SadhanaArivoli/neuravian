import { constants } from "node:fs";
import { access, mkdir, statfs } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CommandError, runCommand } from "./command.js";
import type { CommandResult, SystemFacts } from "./types.js";

export type CheckFailureKind = "docker-missing" | "docker-stopped" | "compose-missing" | "port-conflict" | "system";

export class SystemCheckError extends Error {
  constructor(readonly kind: CheckFailureKind, message: string) {
    super(message);
    this.name = "SystemCheckError";
  }
}

export type CommandRunner = (command: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<CommandResult>;
export type PortChecker = (port: number) => Promise<boolean>;

export async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function versionText(result: CommandResult): string {
  return result.stdout || result.stderr || "available";
}

export async function runSystemChecks(
  repositoryRoot: string,
  dependencies: { command?: CommandRunner; portAvailable?: PortChecker } = {},
): Promise<SystemFacts> {
  const command = dependencies.command ?? runCommand;
  const portAvailable = dependencies.portAvailable ?? isPortAvailable;

  if (process.platform !== "darwin") throw new SystemCheckError("system", "This prototype currently supports macOS only.");
  const required = ["docker-compose.yml", "backend", "frontend", "pipelines", "plugins", "desktop/docker-compose.desktop.yml"];
  for (const relative of required) {
    try { await access(path.join(repositoryRoot, relative), constants.R_OK); }
    catch { throw new SystemCheckError("system", `Required repository item is missing or unreadable: ${relative}`); }
  }
  const dataDirectory = path.join(repositoryRoot, "data");
  await mkdir(dataDirectory, { recursive: true });
  try { await access(dataDirectory, constants.R_OK | constants.W_OK); }
  catch { throw new SystemCheckError("system", "The NeuroForge data directory must be readable and writable."); }

  let docker: CommandResult;
  try { docker = await command("docker", ["--version"], { timeoutMs: 8_000 }); }
  catch (error) {
    if (error instanceof CommandError && error.code === "ENOENT") {
      throw new SystemCheckError("docker-missing", "Docker CLI was not found. Install and start Docker Desktop, then retry.");
    }
    throw new SystemCheckError("docker-missing", "Docker CLI is unavailable. Install and start Docker Desktop, then retry.");
  }
  try { await command("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 12_000 }); }
  catch { throw new SystemCheckError("docker-stopped", "Docker is installed, but its daemon is not responding. Start Docker Desktop, then retry."); }

  let compose: CommandResult;
  try { compose = await command("docker", ["compose", "version"], { timeoutMs: 8_000 }); }
  catch { throw new SystemCheckError("compose-missing", "Docker Compose is unavailable. Update Docker Desktop to a release that includes Compose v2."); }

  for (const port of [8000, 3000]) {
    if (!(await portAvailable(port))) {
      throw new SystemCheckError("port-conflict", `Local port ${port} is already in use. Stop the conflicting service and retry.`);
    }
  }

  const [macOS, disk] = await Promise.all([
    command("sw_vers", ["-productVersion"], { timeoutMs: 5_000 }).catch(() => ({ stdout: os.release(), stderr: "", exitCode: 0 })),
    statfs(dataDirectory),
  ]);
  return {
    macOSVersion: versionText(macOS),
    architecture: process.arch,
    memoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    diskAvailableGiB: Number(((disk.bavail * disk.bsize) / 1024 ** 3).toFixed(1)),
    dockerVersion: versionText(docker),
    composeVersion: versionText(compose),
    repositoryRoot,
  };
}
