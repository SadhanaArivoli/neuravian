/**
 * CloudEventStream
 *
 * Connects to the cloud VM's GET /api/replication/events SSE endpoint and
 * forwards WREEvents to the Electron renderer via webContents.send.
 *
 * One stream per workspace profile. The stream is started when a pipeline
 * run is launched and torn down when the environment stops.
 *
 * Architecture position:
 *   ExecutionEnvironmentManager (run launched)
 *     └── CloudEventStream.connect(profile, credential)
 *           └── GET /api/replication/events  (cloud VM SSE)
 *                 └── mainWindow.webContents.send("cloud:event", event)
 *                       └── renderer subscribes via onCloudEvent IPC
 */

import { BrowserWindow } from "electron";

export interface CloudStreamOptions {
  /** Reconnect delay after a dropped connection (ms). */
  reconnectDelayMs?: number;
  /** Maximum time to spend trying to reconnect before giving up (ms). Use 0 for infinite. */
  maxReconnectMs?: number;
}

const DEFAULT_RECONNECT_DELAY_MS = 5_000;

export class CloudEventStream {
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private startedAt = 0;

  constructor(
    private readonly profileId: string,
    private readonly serverUrl: string,
    private readonly authHeader: string | null,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly options: CloudStreamOptions = {},
  ) {}

  /** Begin streaming. Reconnects automatically on connection loss. */
  start(): void {
    this.stopped = false;
    this.startedAt = Date.now();
    void this._connect();
  }

  /** Stop streaming and cancel any pending reconnect. */
  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async _connect(): Promise<void> {
    if (this.stopped) return;

    this.abortController = new AbortController();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    };
    if (this.authHeader) headers["Authorization"] = this.authHeader;

    const url = new URL("/api/replication/events", `${this.serverUrl}/`).toString();

    try {
      const response = await fetch(url, {
        headers,
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE endpoint returned HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("SSE response has no body.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let eventType = "";
        let dataLine = "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLine = line.slice(5).trim();
          } else if (line === "" && eventType && dataLine) {
            // Complete SSE event received
            if (eventType !== "heartbeat") {
              try {
                const parsed = JSON.parse(dataLine) as Record<string, unknown>;
                this._emit(eventType, parsed);
              } catch {
                // Malformed JSON — skip
              }
            }
            eventType = "";
            dataLine = "";
          }
        }
      }
    } catch (err) {
      if (this.stopped) return;
      // Connection lost — schedule reconnect
      const delay = this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
      const maxMs = this.options.maxReconnectMs ?? 0;
      if (maxMs > 0 && Date.now() - this.startedAt > maxMs) return;
      this.reconnectTimer = setTimeout(() => void this._connect(), delay);
    }
  }

  private _emit(eventType: string, data: Record<string, unknown>): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send("cloud:event", {
      profileId: this.profileId,
      type: eventType,
      ...data,
    });
  }
}

/** Active streams, keyed by profileId. */
const activeStreams = new Map<string, CloudEventStream>();

export function startCloudStream(
  profileId: string,
  serverUrl: string,
  authHeader: string | null,
  getWindow: () => BrowserWindow | null,
): void {
  stopCloudStream(profileId);
  const stream = new CloudEventStream(profileId, serverUrl, authHeader, getWindow);
  activeStreams.set(profileId, stream);
  stream.start();
}

export function stopCloudStream(profileId: string): void {
  const existing = activeStreams.get(profileId);
  if (existing) {
    existing.stop();
    activeStreams.delete(profileId);
  }
}

export function stopAllCloudStreams(): void {
  for (const stream of activeStreams.values()) stream.stop();
  activeStreams.clear();
}
