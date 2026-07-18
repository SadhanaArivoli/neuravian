import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * After the frontend is healthy, verify that the running Docker image was
 * built from the same git commit as this Electron app.  The commit is baked
 * into build/commit.json at package time (by build-full.mjs) and into the
 * nginx image as /version.json.
 *
 * Returns a warning string if there is a mismatch, null if everything is
 * consistent.  Never throws — a stale frontend is a warning, not a crash.
 */
export async function verifyFrontendCommit(frontendUrl: string): Promise<string | null> {
  // commit.json lives one level above this file (build/main/ → build/)
  const commitJsonPath = path.join(__dirname, "..", "commit.json");
  let expected: string | null = null;
  try {
    const raw = await readFile(commitJsonPath, "utf8");
    expected = (JSON.parse(raw) as { commit?: string }).commit ?? null;
  } catch {
    return null; // dev mode or non-packaged run — skip check
  }
  if (!expected) return null;

  try {
    const response = await fetch(`${frontendUrl}/version.json`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null; // old image without version.json — skip
    const data = await response.json() as { commit?: string };
    const actual = data.commit ?? null;
    if (!actual) return null;
    if (actual !== expected) {
      return (
        `Frontend version mismatch: the running Docker image was built at ${actual.slice(0, 8)} ` +
        `but this app was packaged at ${expected.slice(0, 8)}. ` +
        `Run "npm run dist:mac" to rebuild both.`
      );
    }
  } catch {
    return null; // network not ready — startup will catch other problems
  }
  return null;
}

export class HealthTimeoutError extends Error {
  constructor(readonly service: "backend" | "frontend", readonly url: string) {
    super(`${service[0].toUpperCase()}${service.slice(1)} did not become ready before the startup timeout.`);
    this.name = "HealthTimeoutError";
  }
}

export const BACKEND_HEALTH_URL = "http://127.0.0.1:8000/api/health";
export const FRONTEND_URL = "http://127.0.0.1:3000";

export interface HealthProbe {
  healthy: boolean;
  status?: number;
  url: string;
}

export async function probeService(
  url: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<HealthProbe> {
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      cache: "no-store",
    });
    return { healthy: response.ok, status: response.status, url };
  } catch {
    return { healthy: false, url };
  }
}

export async function waitForService(
  service: "backend" | "frontend",
  url: string,
  options: { timeoutMs?: number; intervalMs?: number; fetcher?: typeof fetch; signal?: AbortSignal; onProbe?: (probe: HealthProbe) => void } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const fetcher = options.fetcher ?? fetch;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (options.signal?.aborted) throw new Error(`${service} startup check was cancelled.`);
    const probe = await probeService(url, { fetcher, timeoutMs: Math.min(intervalMs, 5_000) });
    options.onProbe?.(probe);
    if (probe.healthy) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new HealthTimeoutError(service, url);
}
