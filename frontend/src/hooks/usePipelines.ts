import { useQuery } from "@tanstack/react-query";
import { fetchPipeline, fetchPipelines } from "../api/client";

export function usePipelines() {
  return useQuery({
    queryKey: ["pipelines"],
    queryFn: fetchPipelines,
  });
}

export function usePipeline(id: string | null) {
  return useQuery({
    queryKey: ["pipelines", id],
    queryFn: () => fetchPipeline(id!),
    enabled: id !== null,
  });
}
