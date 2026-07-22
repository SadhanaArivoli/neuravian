import os from "node:os";
import type { StartupUpdate, SystemFacts } from "./types.js";

const SECRET_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization)=([^\s&]+)/gi;

export function redactDiagnostics(value: string, homeDirectory = os.homedir()): string {
  let redacted = value.replace(SECRET_PATTERN, "$1=[REDACTED]");
  if (homeDirectory) redacted = redacted.split(homeDirectory).join("~");
  redacted = redacted.replace(/\/Users\/[^/\s]+/g, "/Users/[USER]");
  return redacted;
}

export function formatDiagnostics(input: {
  update: StartupUpdate;
  facts?: Partial<SystemFacts>;
  error?: unknown;
  logTail?: string;
}): string {
  const lines = [
    "Neuravian desktop diagnostics",
    `Status: ${input.update.title}`,
    `Detail: ${input.update.detail}`,
    `Timestamp: ${new Date().toISOString()}`,
  ];
  for (const [key, value] of Object.entries(input.facts ?? {})) {
    lines.push(`${key}: ${String(value)}`);
  }
  if (input.error) lines.push(`Error: ${input.error instanceof Error ? input.error.message : String(input.error)}`);
  if (input.logTail) lines.push("Compose log tail:", input.logTail.slice(-12_000));
  return redactDiagnostics(lines.join("\n"));
}
