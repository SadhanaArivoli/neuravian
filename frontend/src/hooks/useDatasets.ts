import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchDataset,
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
