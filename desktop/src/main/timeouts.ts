export const STARTUP_TIMEOUTS = Object.freeze({
  systemCheckMs: 10_000,
  dockerDaemonMs: 10_000,
  composeStartMs: 30_000,
  backendHealthMs: 60_000,
  frontendHealthMs: 60_000,
  rendererLoadMs: 30_000,
  requestMs: 5_000,
});

export class StageTimeoutError extends Error {
  constructor(readonly stage: string, readonly timeoutMs: number) {
    super(`${stage} timed out after ${Math.round(timeoutMs / 1_000)} seconds.`);
    this.name = "StageTimeoutError";
  }
}

export async function withTimeout<T>(promise: Promise<T>, stage: string, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StageTimeoutError(stage, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
