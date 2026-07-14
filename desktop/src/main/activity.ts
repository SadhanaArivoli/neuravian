import { BACKEND_HEALTH_URL } from "./health.js";

const API_ORIGIN = new URL(BACKEND_HEALTH_URL).origin;

export interface ActiveRunStatus {
  active: boolean;
  runIds: number[];
}

export async function queryActiveRuns(fetcher: typeof fetch = fetch): Promise<ActiveRunStatus> {
  const [queueResponse, runsResponse] = await Promise.all([
    fetcher(`${API_ORIGIN}/api/runs/queue`, { signal: AbortSignal.timeout(5_000) }),
    fetcher(`${API_ORIGIN}/api/runs`, { signal: AbortSignal.timeout(5_000) }),
  ]);
  if (!queueResponse.ok || !runsResponse.ok) throw new Error("Could not confirm whether a scientific run is active.");
  const queue = await queueResponse.json() as { running_run_id?: number | null; queued?: Array<{ run_id: number }> };
  const runs = await runsResponse.json() as Array<{ id: number; status: string }>;
  const ids = new Set<number>();
  if (queue.running_run_id != null) ids.add(queue.running_run_id);
  for (const item of queue.queued ?? []) ids.add(item.run_id);
  for (const run of runs) if (["pending", "queued", "running"].includes(run.status)) ids.add(run.id);
  return { active: ids.size > 0, runIds: [...ids].sort((a, b) => a - b) };
}
