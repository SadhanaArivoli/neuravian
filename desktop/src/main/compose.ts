import { mkdir } from "node:fs/promises";
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
 * Build the docker compose file arguments for the given context.
 *
 * Development: base file + localhost-only desktop overlay (build: contexts included).
 * Packaged:    ONLY the self-contained docker-compose.packaged.yml — no base file,
 *              no overlay merging, no build: contexts, no source repo references.
 */
export function composeArguments(ctx: ComposeContext): string[] {
  if (ctx.packaged) {
    // Self-contained file — does not reference docker-compose.yml at all.
    return [
      "compose", "--project-name", DESKTOP_PROJECT_NAME,
      "-f", path.join(ctx.resourcesRoot, "desktop", "docker-compose.packaged.yml"),
    ];
  }
  return [
    "compose", "--project-name", DESKTOP_PROJECT_NAME,
    "-f", path.join(ctx.resourcesRoot, "docker-compose.yml"),
    "-f", path.join(ctx.resourcesRoot, "desktop", "docker-compose.desktop.yml"),
  ];
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

  private async environment(): Promise<NodeJS.ProcessEnv> {
    if (this.ctx.packaged) {
      // Ensure the plugins-user directory exists before bind-mounting it.
      await mkdir(path.join(this.ctx.dataDir, "plugins-user"), { recursive: true });
    }
    return {
      ...process.env,
      HOST_UID: String(process.getuid?.() ?? 0),
      HOST_GID: String(process.getgid?.() ?? 0),
      NEURAVIAN_DATA_DIR: this.ctx.dataDir,
      NEURAVIAN_RESOURCES_DIR: path.join(this.ctx.resourcesRoot),
    };
  }

  async pull(): Promise<CommandResult> {
    const env = await this.environment();
    return this.command(
      this.dockerCommand(),
      [...composeArguments(this.ctx), "pull", "--quiet"],
      { cwd: this.ctx.resourcesRoot, env, timeoutMs: STARTUP_TIMEOUTS.composeStartMs },
    );
  }

  async start(): Promise<CommandResult> {
    const env = await this.environment();
    const result = await this.command(
      this.dockerCommand(),
      // In packaged mode images are pre-built; --build would fail (no source).
      [...composeArguments(this.ctx), "up", ...(this.ctx.packaged ? [] : ["--build"]), "--detach"],
      { cwd: this.ctx.resourcesRoot, env, timeoutMs: STARTUP_TIMEOUTS.composeStartMs },
    );
    this.ownership = "owned";
    return result;
  }

  async stop(): Promise<CommandResult | undefined> {
    if (!this.ownsServices) return undefined;
    const env = await this.environment();
    const result = await this.command(this.dockerCommand(), [...composeArguments(this.ctx), "stop"], {
      cwd: this.ctx.resourcesRoot,
      env,
      timeoutMs: 2 * 60_000,
    });
    this.ownership = "none";
    return result;
  }

  async logs(): Promise<string> {
    const env = await this.environment();
    const result = await this.command(this.dockerCommand(), [...composeArguments(this.ctx), "logs", "--tail", "120"], {
      cwd: this.ctx.resourcesRoot,
      env,
      timeoutMs: 20_000,
    });
    return [result.stdout, result.stderr].filter(Boolean).join("\n");
  }
}
