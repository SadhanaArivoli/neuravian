import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";

export class CommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly result?: CommandResult,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          finish(() => reject(new CommandError(`Command timed out after ${options.timeoutMs}ms`, command)));
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => reject(new CommandError(error.message, command, undefined, error.code)));
    });
    child.on("close", (exitCode) => {
      const result = { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: exitCode ?? 1 };
      finish(() => {
        if (result.exitCode === 0) resolve(result);
        else reject(new CommandError(`${command} exited with code ${result.exitCode}`, command, result));
      });
    });
  });
}
