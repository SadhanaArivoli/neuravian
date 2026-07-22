import path from "node:path";
import { runCommand } from "./command.js";
import type { CommandResult } from "./types.js";
import { STARTUP_TIMEOUTS } from "./timeouts.js";

export const DESKTOP_PROJECT_NAME = "neuravian-desktop";

export interface ComposeContext {
  /** Directory containing docker-compose.yml and the desktop overlay. */
  resourcesRoot: string;
  /** Writable directory for data volumes (database, logs, derivatives). */
  dataDir: string;
  /** True when running from a packaged .app. */
  packaged: boolean;
}

/**
 * Build the docker compose arguments for the given context.
 *
 * Development: uses the source repo layout with build: contexts.
 * Packaged: uses the pre-built image overlay so Docker never needs source.
 */
export function composeArguments(ctx: ComposeContext): string[] {
  const args = [
    "compose", "--project-name", DESKTOP_PROJECT_NAME,
    "-f", path.join(ctx.resourcesRoot, "docker-compose.yml"),
    "-f", path.join(ctx.resourcesRoot, "desktop", "docker-compose.desktop.yml"),
  ];
  if (ctx.packaged) {
    // The packaged overlay replaces build: contexts with image: references and
    // rewrites volume paths to use the writable userData data directory.
    args.push("-f", path.join(ctx.resourcesRoot, "desktop", "docker-compose.packaged.yml"));
  }
  return args;
}

export class DesktopCompose {
  private ownership: "none" | "owned" | "external" = "none";
  constructor(
    readonly ctx: ComposeContext,
    private readonly command = runCommand,
    private dockerPath?: string,
  ) {}

  /** @deprecated Use ctx.resourcesRoot for source path references. */
  get repositoryRoot(): string { return this.ctx.resourcesRoot; }

  get ownsServices(): boolean { return this.ownership === "owned"; }
  get serviceOwnership(): "none" | "owned" | "external" { return this.ownership; }

  attachExternal(): void { this.ownership = "external"; }
  setDockerPath(dockerPath: string): void { this.dockerPath = dockerPath; }

  private dockerCommand(): string {
    if (!this.dockerPath || !path.isAbsolute(this.dockerPath)) {
      throw new Error("The absolute Docker CLI path must be resolved before running Compose.");
    }
    return this.dockerPath;
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOST_UID: String(process.getuid?.() ?? 0),
      HOST_GID: String(process.getgid?.() ?? 0),
      // Tell the backend where its writable data directory is.
      NEURAVIAN_DATA_DIR: this.ctx.dataDir,
    };
  }

  async start(): Promise<CommandResult> {
    const result = await this.command(
      this.dockerCommand(),
      // In packaged mode images are pre-built; --build would fail (no source).
      [...composeArguments(this.ctx), "up", ...(this.ctx.packaged ? [] : ["--build"]), "--detach"],
      { cwd: this.ctx.resourcesRoot, env: this.environment(), timeoutMs: STARTUP_TIMEOUTS.composeStartMs },
    );
    this.ownership = "owned";
    return result;
  }

  async stop(): Promise<CommandResult | undefined> {
    if (!this.ownsServices) return undefined;
    const result = await this.command(this.dockerCommand(), [...composeArguments(this.ctx), "stop"], {
      cwd: this.ctx.resourcesRoot,
      env: this.environment(),
      timeoutMs: 2 * 60_000,
    });
    this.ownership = "none";
    return result;
  }

  async logs(): Promise<string> {
    const result = await this.command(this.dockerCommand(), [...composeArguments(this.ctx), "logs", "--tail", "120"], {
      cwd: this.ctx.resourcesRoot,
      env: this.environment(),
      timeoutMs: 20_000,
    });
    return [result.stdout, result.stderr].filter(Boolean).join("\n");
  }
}
