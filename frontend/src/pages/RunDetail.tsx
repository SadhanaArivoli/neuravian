import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import RunResults from "../components/domain/RunResults";
import { useRun } from "../hooks/useRuns";

function getWsBase(): string {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (apiUrl) {
    return apiUrl.replace(/^http/, "ws") + "/runs";
  }
  // In production (nginx), use window.location so we get the right host and port
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/runs`;
}
const BASE_WS_URL = getWsBase();

type LogMessage =
  | { type: "log"; line: string }
  | { type: "done"; status: string; error_message: string | null }
  | { type: "heartbeat" }
  | { type: "error"; detail: string };

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    running: "bg-blue-100 text-blue-800",
    success: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        styles[status] ?? "bg-gray-100 text-gray-700"
      }`}
    >
      {status === "running" && (
        <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
      )}
      {status}
    </span>
  );
}

export default function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const runId = Number(id);
  const { data: run, refetch } = useRun(runId);

  const [logLines, setLogLines] = useState<string[]>([]);
  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "closed">(
    "connecting"
  );
  const [lastActivityAt, setLastActivityAt] = useState<Date | null>(null);
  const [silentSeconds, setSilentSeconds] = useState(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const wsUrl = `${BASE_WS_URL}/${runId}/logs/stream`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setWsStatus("connecting");
    setLastActivityAt(null);
    setSilentSeconds(0);

    ws.onopen = () => setWsStatus("connected");

    ws.onmessage = (ev) => {
      const msg: LogMessage = JSON.parse(ev.data);
      if (msg.type === "log") {
        setLogLines((prev) => [...prev, msg.line]);
        setLastActivityAt(new Date());
        setSilentSeconds(0);
      } else if (msg.type === "heartbeat") {
        // Server is alive — update activity timestamp so users know the
        // connection is healthy even during quiet processing phases.
        setLastActivityAt(new Date());
      } else if (msg.type === "done") {
        setWsStatus("closed");
        refetch();
      }
    };

    ws.onerror = () => setWsStatus("closed");
    ws.onclose = () => setWsStatus("closed");

    return () => {
      ws.close();
    };
  }, [runId, refetch]);

  // Tick a "quiet for Xs" counter whenever connected and no new log lines.
  useEffect(() => {
    if (wsStatus !== "connected" || !lastActivityAt) return;
    const interval = setInterval(() => {
      setSilentSeconds(Math.floor((Date.now() - lastActivityAt.getTime()) / 1000));
    }, 5000);
    return () => clearInterval(interval);
  }, [wsStatus, lastActivityAt]);

  // Auto-scroll to bottom as new log lines arrive
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines]);

  if (!run) {
    return (
      <div className="p-8">
        <div className="h-4 w-32 bg-gray-200 rounded animate-pulse" />
      </div>
    );
  }

  const isActive = run.status === "pending" || run.status === "running";

  return (
    <div className="p-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link to="/runs" className="text-sm text-gray-500 hover:text-gray-700">
          ← All runs
        </Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-xl font-semibold text-gray-900">
          Run #{run.id} — {run.pipeline_manifest_id}
        </h1>
        <StatusBadge status={run.status} />
      </div>

      {/* Meta */}
      <div className="grid grid-cols-2 gap-4 mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
        <div>
          <span className="text-gray-500">Pipeline</span>
          <p className="font-medium">{run.pipeline_manifest_id} {run.pipeline_version}</p>
        </div>
        <div>
          <span className="text-gray-500">Dataset</span>
          <p className="font-medium text-xs font-mono break-all">{run.output_dir ?? "—"}</p>
        </div>
        {run.started_at && (
          <div>
            <span className="text-gray-500">Started</span>
            <p className="font-medium">{new Date(run.started_at).toLocaleString()}</p>
          </div>
        )}
        {run.finished_at && (
          <div>
            <span className="text-gray-500">Finished</span>
            <p className="font-medium">{new Date(run.finished_at).toLocaleString()}</p>
          </div>
        )}
      </div>

      {/* Resource warnings (from run creation) */}
      {run.resource_warnings?.length > 0 && (
        <div className="mb-4 space-y-2">
          {run.resource_warnings.map((w, i) => (
            <div
              key={i}
              className="rounded border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800"
            >
              ⚠ {w.message}
            </div>
          ))}
        </div>
      )}

      {/* Error translation panel */}
      {run.status === "failed" && run.error_message && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-4">
          <h3 className="font-semibold text-red-800 mb-1">What went wrong</h3>
          <p className="text-sm text-red-700 whitespace-pre-wrap">{run.error_message}</p>
        </div>
      )}

      {/* Command preview */}
      {run.command_preview && (
        <details className="mb-4">
          <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700 select-none">
            Show exact Docker command
          </summary>
          <pre className="mt-2 rounded bg-gray-900 text-gray-100 text-xs p-4 overflow-x-auto whitespace-pre-wrap break-all">
            {run.command_preview}
          </pre>
        </details>
      )}

      {/* Live log console */}
      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between bg-gray-900 px-4 py-2">
          <span className="text-xs text-gray-400 font-mono">stdout / stderr</span>
          <span className="text-xs text-gray-500">
            {wsStatus === "connected" && isActive ? (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                {silentSeconds >= 10
                  ? `live · quiet for ${silentSeconds < 60 ? `${silentSeconds}s` : `${Math.floor(silentSeconds / 60)}m ${silentSeconds % 60}s`}`
                  : "live"}
              </span>
            ) : wsStatus === "closed" ? (
              "stream ended"
            ) : (
              "connecting…"
            )}
          </span>
        </div>
        <div className="bg-gray-950 h-96 overflow-y-auto p-4 font-mono text-xs text-gray-200">
          {logLines.length === 0 && (
            <span className="text-gray-600">
              {run.status === "pending"
                ? "Waiting for run to start…"
                : "No log output yet."}
            </span>
          )}
          {logLines.map((line, i) => (
            <div key={i} className="leading-5">
              {line}
            </div>
          ))}
          {wsStatus === "connected" && isActive && silentSeconds >= 30 && (
            <div className="mt-2 text-gray-600 italic">
              — pipeline is running, no new output for{" "}
              {silentSeconds < 60
                ? `${silentSeconds}s`
                : `${Math.floor(silentSeconds / 60)}m ${silentSeconds % 60}s`}{" "}
              —
            </div>
          )}
          <div ref={logEndRef} />
        </div>
      </div>

      {/* Results viewer */}
      {run.status === "success" && <RunResults runId={run.id} />}
    </div>
  );
}
