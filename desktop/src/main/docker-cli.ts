import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.js";
import type { CommandResult } from "./types.js";

export const DOCKER_FALLBACK_PATHS = Object.freeze([
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
]);

export type DockerLookupCommand = (
  command: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

export interface DockerResolverDependencies {
  env?: NodeJS.ProcessEnv;
  executable?: (candidate: string) => Promise<boolean>;
  command?: DockerLookupCommand;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.resolve(directory, "docker"));
}

function lookupOutput(result: CommandResult): string | undefined {
  const candidate = result.stdout.split(/\r?\n/, 1)[0]?.trim();
  return candidate && path.isAbsolute(candidate) ? candidate : undefined;
}

export async function resolveDockerCli(dependencies: DockerResolverDependencies = {}): Promise<string | undefined> {
  const env = dependencies.env ?? process.env;
  const executable = dependencies.executable ?? isExecutable;
  const command = dependencies.command ?? runCommand;
  const checked = new Set<string>();

  const accept = async (candidate: string | undefined): Promise<string | undefined> => {
    if (!candidate || checked.has(candidate)) return undefined;
    checked.add(candidate);
    return await executable(candidate) ? candidate : undefined;
  };

  for (const candidate of [...pathCandidates(env), ...DOCKER_FALLBACK_PATHS]) {
    const resolved = await accept(candidate);
    if (resolved) return resolved;
  }

  try {
    const result = await command("/usr/bin/which", ["docker"], { env, timeoutMs: 5_000 });
    const resolved = await accept(lookupOutput(result));
    if (resolved) return resolved;
  } catch { /* Continue to the login-shell fallback. */ }

  try {
    const result = await command("/bin/zsh", ["-lc", "command -v docker"], { env, timeoutMs: 5_000 });
    return await accept(lookupOutput(result));
  } catch {
    return undefined;
  }
}
