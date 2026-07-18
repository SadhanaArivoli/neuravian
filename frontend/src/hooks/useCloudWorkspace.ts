import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "../context/WorkspaceContext";

interface CloudWorkspaceState {
  snapshot: WorkspaceSnapshot | null;
  profile: WorkspaceProfile | null;
  online: boolean;
  loading: boolean;
  error: string | null;
  sync: () => Promise<void>;
}

const REFRESH_MS = 30_000;

/**
 * Returns cloud workspace snapshot data when a cloud workspace is selected.
 * Falls back to { snapshot: null } when local or no cloud profile is active.
 * Safe to call unconditionally — only activates when `selected` starts with "cloud:".
 */
export function useCloudWorkspace(): CloudWorkspaceState {
  const { selected, cloudProfiles } = useWorkspace();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const desktop = window.neuroforgeDesktop;
  const profileId = selected.startsWith("cloud:") ? selected.slice(6) : null;
  const profile = profileId ? cloudProfiles.find((p) => p.id === profileId) ?? null : null;

  const sync = useCallback(async (quiet = false) => {
    if (!desktop || !profileId) return;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const result = await desktop.syncWorkspace(profileId);
      setSnapshot(result.snapshot);
      setOnline(result.online);
    } catch (cause) {
      setOnline(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [desktop, profileId]);

  useEffect(() => {
    if (!profileId) {
      setSnapshot(null);
      setOnline(false);
      setError(null);
      return;
    }
    void sync();
    timerRef.current = setInterval(() => void sync(true), REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [profileId, sync]);

  return {
    snapshot,
    profile,
    online,
    loading,
    error,
    sync: () => sync(false),
  };
}
