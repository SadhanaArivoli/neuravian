import { useEffect } from "react";

type CloudEvent = {
  profileId: string;
  type: string;
  [key: string]: unknown;
};

/**
 * Subscribe to live events forwarded from the cloud VM's SSE stream.
 *
 * Events flow: cloud VM /api/replication/events → Electron main process →
 * cloud:event IPC → this hook → your callback.
 *
 * Only available in the desktop app (window.neuroforgeDesktop?.onCloudEvent).
 * In the web app the callback is never called.
 *
 * @param callback - called for every event. Stable reference recommended (use useCallback).
 * @param filter   - optional profileId to receive events from only one workspace.
 */
export function useCloudEvents(
  callback: (event: CloudEvent) => void,
  filter?: string,
): void {
  useEffect(() => {
    const desktop = window.neuroforgeDesktop;
    if (!desktop?.onCloudEvent) return;

    const handler = (event: CloudEvent) => {
      if (filter && event.profileId !== filter) return;
      callback(event);
    };

    const unsubscribe = desktop.onCloudEvent(handler);
    return unsubscribe;
  }, [callback, filter]);
}
