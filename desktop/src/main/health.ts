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
