export class HealthTimeoutError extends Error {
  constructor(readonly service: "backend" | "frontend", readonly url: string) {
    super(`${service[0].toUpperCase()}${service.slice(1)} did not become ready before the startup timeout.`);
    this.name = "HealthTimeoutError";
  }
}

export const BACKEND_HEALTH_URL = "http://127.0.0.1:8000/api/health";
export const FRONTEND_URL = "http://127.0.0.1:3000";

export async function waitForService(
  service: "backend" | "frontend",
  url: string,
  options: { timeoutMs?: number; intervalMs?: number; fetcher?: typeof fetch } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const fetcher = options.fetcher ?? fetch;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(Math.min(intervalMs, 5_000)) });
      if (response.ok) return;
    } catch { /* Service is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new HealthTimeoutError(service, url);
}
