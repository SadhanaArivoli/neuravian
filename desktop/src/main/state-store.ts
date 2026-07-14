import type { StartupUpdate } from "./types.js";

export class StartupStateStore {
  private listeners = new Set<(update: StartupUpdate) => void>();

  constructor(private current: StartupUpdate) {}

  get(): StartupUpdate { return { ...this.current }; }

  set(update: StartupUpdate): void {
    this.current = { ...update };
    for (const listener of this.listeners) listener(this.get());
  }

  subscribe(listener: (update: StartupUpdate) => void): () => void {
    this.listeners.add(listener);
    listener(this.get());
    return () => this.listeners.delete(listener);
  }

  get listenerCount(): number { return this.listeners.size; }
}
