import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../context/WorkspaceContext";

export interface AllCloudSnapshot {
  profile: WorkspaceProfile;
  snapshot: WorkspaceSnapshot | null;
  online: boolean;
  loading: boolean;
  error: string | null;
  sync: () => void;
}

const REFRESH_MS = 30_000;

/**
 * Fetches WorkspaceSnapshots for ALL connected cloud profiles.
 * Only activates when selected === "all". Returns [] otherwise.
 */
export function useAllCloudSnapshots(): AllCloudSnapshot[] {
  const { selected, cloudProfiles } = useWorkspace();
  const desktop = window.neuroforgeDesktop;
  const isAll = selected === "all";
  const [snapshots, setSnapshots] = useState<Map<string, Omit<AllCloudSnapshot, "profile" | "sync">>>(new Map());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async (quiet = false) => {
    if (!desktop || !isAll || cloudProfiles.length === 0) return;
    await Promise.allSettled(
      cloudProfiles.map(async (profile) => {
        if (!quiet) {
          setSnapshots((prev) => {
            const next = new Map(prev);
            const existing = prev.get(profile.id) ?? { snapshot: null, online: false, error: null };
            next.set(profile.id, { ...existing, loading: true });
            return next;
          });
        }
        try {
          const result = await desktop.syncWorkspace(profile.id);
          setSnapshots((prev) => {
            const next = new Map(prev);
            next.set(profile.id, { snapshot: result.snapshot, online: result.online, loading: false, error: null });
            return next;
          });
        } catch (e) {
          setSnapshots((prev) => {
            const next = new Map(prev);
            next.set(profile.id, {
              snapshot: prev.get(profile.id)?.snapshot ?? null,
              online: false,
              loading: false,
              error: e instanceof Error ? e.message : String(e),
            });
            return next;
          });
        }
      }),
    );
  }, [desktop, isAll, cloudProfiles]);

  useEffect(() => {
    if (!isAll) {
      setSnapshots(new Map());
      return;
    }
    void fetchAll();
    timerRef.current = setInterval(() => void fetchAll(true), REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isAll, fetchAll]);

  if (!isAll) return [];
  return cloudProfiles.map((profile) => ({
    profile,
    ...(snapshots.get(profile.id) ?? { snapshot: null, online: false, loading: true, error: null }),
    sync: () => void fetchAll(),
  }));
}
