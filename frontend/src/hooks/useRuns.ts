import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRun, fetchCompatiblePipelines, fetchRun, fetchRunFile, fetchRunProvenance, fetchRunResults, fetchRuns, type CompatiblePipeline, type RunCreate } from "../api/client";

export const shouldPollRun = (status: string | undefined) =>
  status === "pending" || status === "queued" || status === "running";

export function useRuns() {
  return useQuery({
    queryKey: ["runs"],
    queryFn: fetchRuns,
    refetchInterval: (query) => {
      const runs = query.state.data;
      return runs?.some((run) => ["pending", "queued", "running"].includes(run.status))
        ? 5000
        : false;
    },
  });
}

export function useRun(id: number) {
  return useQuery({
    queryKey: ["runs", id],
    queryFn: () => fetchRun(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return shouldPollRun(status) ? 2000 : false;
    },
  });
}

export function useRunResults(runId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["runs", runId, "results"],
    queryFn: () => fetchRunResults(runId),
    enabled,
  });
}

export function useRunFile<T>(runId: number, filePath: string | null) {
  return useQuery({
    queryKey: ["runs", runId, "files", filePath],
    queryFn: () => fetchRunFile<T>(runId, filePath!),
    enabled: !!filePath,
  });
}

export function useRunProvenance(runId: number) {
  return useQuery({
    queryKey: ["runs", runId, "provenance"],
    queryFn: () => fetchRunProvenance(runId),
  });
}

/**
 * Given a list of artifact type slugs (from a run's resolved artifacts),
 * fetch all compatible downstream pipelines and deduplicate by pipeline_id.
 * Ordering from the backend is preserved (local-ok first, then alphabetical).
 */
export function useCompatiblePipelines(artifactTypes: string[]) {
  // Stable query key: sort types so order of resolution doesn't cause cache misses.
  const sortedTypes = [...artifactTypes].sort();

  return useQuery<CompatiblePipeline[]>({
    queryKey: ["compatible-pipelines", ...sortedTypes],
    queryFn: async () => {
      if (sortedTypes.length === 0) return [];
      const batches = await Promise.all(
        sortedTypes.map((t) => fetchCompatiblePipelines(t))
      );
      // Merge and deduplicate by pipeline_id, preserving first occurrence.
      // The backend already sorts each batch by compute_profile then name,
      // so iterating in order keeps the best-sorted entry per pipeline.
      const seen = new Set<string>();
      const merged: CompatiblePipeline[] = [];
      for (const batch of batches) {
        for (const p of batch) {
          if (!seen.has(p.pipeline_id)) {
            seen.add(p.pipeline_id);
            merged.push(p);
          }
        }
      }
      return merged;
    },
    enabled: sortedTypes.length > 0,
    staleTime: 60_000, // manifest data is stable; no need to re-fetch aggressively
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RunCreate) => createRun(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}
