import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRun, fetchRun, fetchRunFile, fetchRunResults, fetchRuns, type RunCreate } from "../api/client";

export function useRuns() {
  return useQuery({
    queryKey: ["runs"],
    queryFn: fetchRuns,
    refetchInterval: 5000, // poll while runs might be in progress
  });
}

export function useRun(id: number) {
  return useQuery({
    queryKey: ["runs", id],
    queryFn: () => fetchRun(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" ? 2000 : false;
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

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RunCreate) => createRun(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}
