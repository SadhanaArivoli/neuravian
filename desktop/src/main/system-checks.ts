import { constants } from "node:fs";
import { access, mkdir, statfs } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./command.js";
import { resolveDockerCli } from "./docker-cli.js";
import type { CommandResult, SystemFacts } from "./types.js";
import { STARTUP_TIMEOUTS } from "./timeouts.js";

export type CheckFailureKind = "docker-missing" | "docker-stopped" | "compose-missing" | "port-conflict" | "system";

export class SystemCheckError extends Error {
  constructor(readonly kind: CheckFailureKind, message: string, readonly facts?: Partial<SystemFacts>) {
    super(message);
    this.name = "SystemCheckError";
  }
}

export type CommandRunner = (command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<CommandResult>;
export type PortChecker = (port: number) => Promise<boolean>;
export type CheckTrace = (stage: number, name: string, detail?: string) => void;

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

export interface SystemCheckContext {
  /** Directory where docker-compose.yml, pipelines/, plugins/ etc. live. Read-only. */
  resourcesRoot: string;
  /** Writable directory for database and run outputs. Created if absent. */
  dataDir: string;
  /** True when running from a packaged .app. Adjusts which files are required. */
  packaged?: boolean;
}

export async function runSystemChecks(
  context: SystemCheckContext | string,
  dependencies: { command?: CommandRunner; portAvailable?: PortChecker; trace?: CheckTrace; resolveDocker?: () => Promise<string | undefined> } = {},
): Promise<SystemFacts> {
  // Accept a plain string for backward compatibility with existing tests.
  const ctx: SystemCheckContext = typeof context === "string"
    ? { resourcesRoot: context, dataDir: path.join(context, "data"), packaged: false }
    : context;

  const command = dependencies.command ?? runCommand;
  const portAvailable = dependencies.portAvailable ?? isPortAvailable;
  const trace = dependencies.trace ?? (() => undefined);

  if (process.platform !== "darwin") throw new SystemCheckError("system", "This prototype currently supports macOS only.");

  // Packaged mode: only the self-contained packaged compose file is needed —
  // docker-compose.yml and docker-compose.desktop.yml are not loaded.
  // Dev mode: the source repo with build contexts must be present.
  const required = ctx.packaged
    ? ["desktop/docker-compose.packaged.yml", "pipelines", "plugins"]
    : ["docker-compose.yml", "backend", "frontend", "pipelines", "plugins", "desktop/docker-compose.desktop.yml"];

  for (const relative of required) {
    try { await access(path.join(ctx.resourcesRoot, relative), constants.R_OK); }
    catch { throw new SystemCheckError("system", `Required ${ctx.packaged ? "app resource" : "repository item"} is missing or unreadable: ${relative}`); }
  }

  const dataDirectory = ctx.dataDir;
  await mkdir(dataDirectory, { recursive: true });
  try { await access(dataDirectory, constants.R_OK | constants.W_OK); }
  catch { throw new SystemCheckError("system", "The Neuravian data directory must be readable and writable."); }

  const dockerPath = await (dependencies.resolveDocker ?? (() => resolveDockerCli({ command })))();
  if (!dockerPath) {
    throw new SystemCheckError("docker-missing", "Docker CLI was not found in the app PATH, standard macOS locations, Docker Desktop, or a login shell.");
  }
  let docker: CommandResult;
  try { docker = await command(dockerPath, ["--version"], { timeoutMs: 8_000 }); }
  catch { throw new SystemCheckError("docker-missing", "The resolved Docker CLI could not be executed.", { dockerPath }); }
  trace(7, "Docker CLI detected", `path=${dockerPath}; ${versionText(docker)}`);
  try { await command(dockerPath, ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: STARTUP_TIMEOUTS.dockerDaemonMs }); }
  catch {
    throw new SystemCheckError(
      "docker-stopped",
      "Docker is installed, but its daemon is not responding. Start Docker Desktop, then retry.",
      { dockerPath, dockerVersion: versionText(docker) },
    );
  }
  trace(8, "Docker daemon healthy");

  let compose: CommandResult;
  try { compose = await command(dockerPath, ["compose", "version"], { timeoutMs: 8_000 }); }
  catch {
    throw new SystemCheckError(
      "compose-missing",
      "Docker Compose is unavailable. Update Docker Desktop to a release that includes Compose v2.",
      { dockerPath, dockerVersion: versionText(docker), composeVersion: "unavailable" },
    );
  }
  trace(9, "Compose detected", versionText(compose));
  trace(10, ctx.packaged ? "Packaged app resources resolved" : "Repository/runtime resources resolved");

  const occupiedPorts: number[] = [];
  for (const port of [8000, 3000]) {
    if (!(await portAvailable(port))) {
      occupiedPorts.push(port);
    }
  }
  trace(11, "Ports checked", occupiedPorts.length ? `occupied=${occupiedPorts.join(",")}` : "available=8000,3000");

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
    dockerPath,
    composeVersion: versionText(compose),
    repositoryRoot: ctx.resourcesRoot,
    occupiedPorts,
  };
}
