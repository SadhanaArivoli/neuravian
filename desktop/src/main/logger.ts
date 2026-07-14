import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { redactDiagnostics } from "./diagnostics.js";

export interface StartupTrace {
  attemptId?: string;
  stage: number | string;
  name: string;
  detail?: string;
  elapsedMs?: number;
}

export class DesktopLogger {
  private queue: Promise<void> = Promise.resolve();
  private constructor(readonly directory: string, readonly filePath: string) {}

  static async create(directory: string): Promise<DesktopLogger> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new DesktopLogger(directory, path.join(directory, "startup.log"));
  }

  trace(event: StartupTrace): Promise<void> {
    const fields = [
      new Date().toISOString(),
      `attempt=${event.attemptId ?? "app"}`,
      `stage=${event.stage}`,
      `name=${event.name}`,
      event.elapsedMs == null ? "" : `elapsed_ms=${event.elapsedMs}`,
      event.detail ? `detail=${event.detail.replace(/\s+/g, " ")}` : "",
    ].filter(Boolean);
    const line = `${redactDiagnostics(fields.join(" "))}\n`;
    this.queue = this.queue.then(async () => {
      await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600 });
    });
    return this.queue;
  }
}
