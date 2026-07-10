import { useQuery } from "@tanstack/react-query";
import { fetchRemoteHosts } from "../api/client";

export function useRemoteHosts() {
  return useQuery({
    queryKey: ["remote-hosts"],
    queryFn: fetchRemoteHosts,
    staleTime: 30_000,
  });
}
