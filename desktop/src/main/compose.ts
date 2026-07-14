import os from "node:os";
import path from "node:path";
import { runCommand } from "./command.js";
import type { CommandResult } from "./types.js";

export const DESKTOP_PROJECT_NAME = "neuroforge-desktop";

export function composeArguments(repositoryRoot: string): string[] {
  return [
    "compose", "--project-name", DESKTOP_PROJECT_NAME,
    "-f", path.join(repositoryRoot, "docker-compose.yml"),
    "-f", path.join(repositoryRoot, "desktop", "docker-compose.desktop.yml"),
  ];
}

export class DesktopCompose {
  private owned = false;
  constructor(
    readonly repositoryRoot: string,
    private readonly command = runCommand,
  ) {}

  get ownsServices(): boolean { return this.owned; }

  private environment(): NodeJS.ProcessEnv {
    return { ...process.env, HOST_UID: String(process.getuid?.() ?? 0), HOST_GID: String(process.getgid?.() ?? 0) };
  }

  async start(): Promise<CommandResult> {
    const result = await this.command("docker", [...composeArguments(this.repositoryRoot), "up", "--build", "--detach"], {
      cwd: this.repositoryRoot,
      env: this.environment(),
      timeoutMs: 20 * 60_000,
    });
    this.owned = true;
    return result;
  }

  async stop(): Promise<CommandResult | undefined> {
    if (!this.owned) return undefined;
    const result = await this.command("docker", [...composeArguments(this.repositoryRoot), "stop"], {
      cwd: this.repositoryRoot,
      env: this.environment(),
      timeoutMs: 2 * 60_000,
    });
    this.owned = false;
    return result;
  }

  async logs(): Promise<string> {
    const result = await this.command("docker", [...composeArguments(this.repositoryRoot), "logs", "--tail", "120"], {
      cwd: this.repositoryRoot,
      env: this.environment(),
      timeoutMs: 20_000,
    });
    return [result.stdout, result.stderr].filter(Boolean).join("\n");
  }
}
