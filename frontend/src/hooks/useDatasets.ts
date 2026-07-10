import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchDataset,
  fetchDatasetArtifacts,
  fetchDatasetDashboard,
  fetchDatasetScans,
  fetchDatasets,
  registerDataset,
} from "../api/client";

export function useDatasets() {
  return useQuery({
    queryKey: ["datasets"],
    queryFn: fetchDatasets,
  });
}

export function useDataset(id: number) {
  return useQuery({
    queryKey: ["datasets", id],
    queryFn: () => fetchDataset(id),
  });
}

export function useDatasetScans(datasetId: number) {
  return useQuery({
    queryKey: ["datasets", datasetId, "scans"],
    queryFn: () => fetchDatasetScans(datasetId),
  });
}

export function useRegisterDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => registerDataset(path),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export function useDatasetDashboard(id: number) {
  return useQuery({
    queryKey: ["datasets", id, "dashboard"],
    queryFn: () => fetchDatasetDashboard(id),
    staleTime: 30_000,
  });
}

export function useDatasetArtifacts(id: number) {
  return useQuery({
    queryKey: ["datasets", id, "artifacts"],
    queryFn: () => fetchDatasetArtifacts(id),
    staleTime: 30_000,
  });
}
