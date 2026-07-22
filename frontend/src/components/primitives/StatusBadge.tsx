interface Props {
  connected: boolean;
  loading: boolean;
}

export function StatusBadge({ connected, loading }: Props) {
  if (loading) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-gray-400">
        <span className="h-2 w-2 rounded-full bg-gray-500 animate-pulse" />
        Connecting…
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span
        className={`h-2 w-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
      />
      <span className={connected ? "text-green-400" : "text-red-400"}>
        {connected ? "Ready" : "Neuravian is offline"}
      </span>
    </span>
  );
}
