import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import RunProvenance from "../components/domain/RunProvenance";
import RunResults from "../components/domain/RunResults";
import { useRun } from "../hooks/useRuns";
import type { RunProgress } from "../api/client";

function getWsBase(): string {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (apiUrl) {
    return apiUrl.replace(/^http/, "ws") + "/runs";
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/runs`;
}
const BASE_WS_URL = getWsBase();

type LogMessage =
  | { type: "log"; line: string }
  | { type: "done"; status: string; error_message: string | null }
  | { type: "heartbeat" }
  | { type: "error"; detail: string }
  | { type: "progress"; data: RunProgress };

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function ProgressPanel({ progress }: { progress: RunProgress }) {
  return (
    <div className="mb-4 rounded-lg border border-blue-500/30 bg-blue-500/10 p-4">
      <div className="flex justify-between text-sm text-blue-300 mb-2">
        <span className="font-medium">
          {progress.current} / {progress.total} {progress.rate_unit}s · {progress.percent}%
        </span>
        <span className="text-blue-400">
          {formatEta(progress.eta_seconds)} remaining · {progress.rate.toFixed(1)}s/{progress.rate_unit}
        </span>
      </div>
      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-blue-500 transition-all duration-500"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
    </div>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending:     "bg-yellow-500/15 text-yellow-300 border-yellow-500/20",
    queued:      "bg-gray-500/15 text-gray-300 border-gray-500/20",
    running:     "bg-blue-500/15 text-blue-300 border-blue-500/20",
    success:     "bg-green-500/15 text-green-300 border-green-500/20",
    failed:      "bg-red-500/15 text-red-300 border-red-500/20",
    cancelled:   "bg-orange-500/15 text-orange-300 border-orange-500/20",
    interrupted: "bg-amber-500/15 text-amber-300 border-amber-500/20",
  };
  const dotColors: Record<string, string> = {
    running: "bg-blue-400 animate-pulse",
    queued:  "bg-gray-400",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        styles[status] ?? "bg-white/10 text-gray-300 border-white/10"
      }`}
    >
      {dotColors[status] && (
        <span className={`h-1.5 w-1.5 rounded-full ${dotColors[status]}`} />
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
  const [progress, setProgress] = useState<RunProgress | null>(run?.progress ?? null);
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
        setLastActivityAt(new Date());
      } else if (msg.type === "progress") {
        setProgress(msg.data);
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

  useEffect(() => {
    if (wsStatus !== "connected" || !lastActivityAt) return;
    const interval = setInterval(() => {
      setSilentSeconds(Math.floor((Date.now() - lastActivityAt.getTime()) / 1000));
    }, 5000);
    return () => clearInterval(interval);
  }, [wsStatus, lastActivityAt]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines]);

  if (!run) {
    return (
      <div className="p-8">
        <div className="h-4 w-32 rounded bg-white/10 animate-pulse" />
      </div>
    );
  }

  const isActive = run.status === "pending" || run.status === "running" || run.status === "queued";

  return (
    <div className="p-8 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link to="/runs" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">
          ← All runs
        </Link>
        <span className="text-gray-600">/</span>
        <h1 className="text-xl font-semibold text-gray-100">
          Run #{run.id} — {run.pipeline_manifest_id}
        </h1>
        <RunStatusBadge status={run.status} />
      </div>

      {/* Meta */}
      <div className="grid grid-cols-2 gap-4 mb-6 rounded-lg border border-white/10 bg-surface-raised p-4 text-sm">
        <div>
          <span className="text-gray-500 text-xs uppercase tracking-wide">Pipeline</span>
          <p className="mt-0.5 font-medium text-gray-200">{run.pipeline_manifest_id} {run.pipeline_version}</p>
        </div>
        <div>
          <span className="text-gray-500 text-xs uppercase tracking-wide">Dataset</span>
          <p className="mt-0.5 font-medium text-gray-200 text-xs font-mono break-all">{run.output_dir ?? "—"}</p>
        </div>
        {run.started_at && (
          <div>
            <span className="text-gray-500 text-xs uppercase tracking-wide">Started</span>
            <p className="mt-0.5 font-medium text-gray-200">{new Date(run.started_at).toLocaleString()}</p>
          </div>
        )}
        {run.finished_at && (
          <div>
            <span className="text-gray-500 text-xs uppercase tracking-wide">Finished</span>
            <p className="mt-0.5 font-medium text-gray-200">{new Date(run.finished_at).toLocaleString()}</p>
          </div>
        )}
      </div>

      {/* Resource warnings */}
      {run.resource_warnings?.length > 0 && (
        <div className="mb-4 space-y-2">
          {run.resource_warnings.map((w, i) => (
            <div
              key={i}
              className="rounded border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300"
            >
              ⚠ {w.message}
            </div>
          ))}
        </div>
      )}

      {/* Progress bar */}
      {progress != null && run.status === "running" && (
        <ProgressPanel progress={progress} />
      )}

      {/* Staleness warning */}
      {run.status === "running" && progress?.last_updated && (() => {
        const progressAgeMs = Date.now() - new Date(progress.last_updated).getTime();
        const staleMinutes = Math.floor(progressAgeMs / 60000);
        return staleMinutes >= 30 ? (
          <div className="mb-4 rounded border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            ⚠ No progress update in {staleMinutes} minutes — pipeline may be stalled.
            Check the log below for recent output.
          </div>
        ) : null;
      })()}

      {/* Error translation panel */}
      {run.status === "failed" && run.error_message && (
        <div className="mb-4 rounded border border-red-500/30 bg-red-500/10 px-4 py-4">
          <h3 className="font-semibold text-red-300 mb-1">What went wrong</h3>
          <p className="text-sm text-red-400 whitespace-pre-wrap">{run.error_message}</p>
        </div>
      )}

      {/* Cancelled / interrupted info */}
      {(run.status === "cancelled" || run.status === "interrupted") && run.error_message && (
        <div className="mb-4 rounded border border-amber-500/30 bg-amber-500/10 px-4 py-4">
          <h3 className="font-semibold text-amber-300 mb-1">
            {run.status === "cancelled" ? "Run cancelled" : "Run interrupted"}
          </h3>
          <p className="text-sm text-amber-400 whitespace-pre-wrap">{run.error_message}</p>
        </div>
      )}

      {/* Command preview */}
      {run.command_preview && (
        <details className="mb-4">
          <summary className="cursor-pointer text-sm text-gray-400 hover:text-gray-200 select-none transition-colors">
            Show exact Docker command
          </summary>
          <pre className="mt-2 rounded border border-white/10 bg-surface-overlay text-gray-200 text-xs p-4 overflow-x-auto whitespace-pre-wrap break-all">
            {run.command_preview}
          </pre>
        </details>
      )}

      {/* Provenance panel */}
      <details className="mb-4">
        <summary className="cursor-pointer text-sm text-gray-400 hover:text-gray-200 select-none transition-colors">
          Provenance record
        </summary>
        <RunProvenance runId={run.id} />
      </details>

      {/* Live log console */}
      <div className="rounded-lg border border-white/10 overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 bg-surface-overlay px-4 py-2">
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
        <div className="bg-[#0d0d14] h-96 overflow-y-auto p-4 font-mono text-xs text-gray-300">
          {logLines.length === 0 && (
            <span className="text-gray-600">
              {run.status === "pending" || run.status === "queued"
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
