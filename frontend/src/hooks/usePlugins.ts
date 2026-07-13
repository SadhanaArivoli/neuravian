import { useQuery } from "@tanstack/react-query";
import { fetchPlugins } from "../api/client";

export function usePlugins() {
  return useQuery({
    queryKey: ["plugins"],
    queryFn: fetchPlugins,
    staleTime: 60_000,
  });
}
