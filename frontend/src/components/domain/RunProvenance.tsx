import { useRunProvenance } from "../../hooks/useRuns";

const EVENT_LABELS: Record<string, string> = {
  run_created: "Run queued",
  execution_started: "Execution started",
  execution_finished: "Execution finished",
};

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-3 py-1.5 border-b border-gray-100 last:border-0">
      <span className="w-36 shrink-0 text-xs text-gray-500">{label}</span>
      <span className={`text-xs text-gray-900 break-all ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m ${s % 60}s`;
}

interface Props {
  runId: number;
}

export default function RunProvenance({ runId }: Props) {
  const { data, isLoading, error } = useRunProvenance(runId);

  if (isLoading) {
    return (
      <div className="mt-1 text-xs text-gray-400 px-1 py-2">Loading provenance…</div>
    );
  }

  if (error || !data) {
    return (
      <div className="mt-1 text-xs text-red-500 px-1 py-2">
        Could not load provenance record.
      </div>
    );
  }

  // Pull dataset snapshot info from the run_created event payload
  const createdEvent = data.events.find((e) => e.event_type === "run_created");
  const datasetPath = createdEvent?.payload.dataset_path as string | undefined;
  const datasetHash = createdEvent?.payload.dataset_hash as string | null | undefined;

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
      {/* Tool & image */}
      <div className="px-4 py-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Tool
        </p>
        <Row label="Version" value={data.pipeline_version} mono />
        <Row
          label="Image digest"
          value={
            data.container_digest ? (
              <span title={data.container_digest}>
                {data.container_digest.replace(/^[^@]+@/, "")}
              </span>
            ) : (
              <span className="text-gray-400 italic">not yet captured (run in progress)</span>
            )
          }
          mono
        />
      </div>

      {/* Parameters */}
      <div className="px-4 py-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Parameters
        </p>
        {Object.entries(data.params).length === 0 ? (
          <span className="text-xs text-gray-400 italic">none</span>
        ) : (
          Object.entries(data.params).map(([k, v]) => (
            <Row key={k} label={k} value={String(v)} mono />
          ))
        )}
      </div>

      {/* Dataset snapshot */}
      <div className="px-4 py-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Dataset snapshot
        </p>
        <Row label="Path" value={datasetPath ?? "—"} mono />
        <Row
          label="Manifest hash"
          value={
            datasetHash ? (
              <span title={datasetHash}>{datasetHash.slice(0, 16)}…</span>
            ) : (
              <span className="text-gray-400 italic">
                not available — dataset was imported before hash capture was enabled
              </span>
            )
          }
          mono={!!datasetHash}
        />
      </div>

      {/* Timing */}
      <div className="px-4 py-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Timing
        </p>
        <Row
          label="Created"
          value={data.created_at ? new Date(data.created_at).toLocaleString() : "—"}
        />
        <Row
          label="Started"
          value={data.started_at ? new Date(data.started_at).toLocaleString() : "—"}
        />
        <Row
          label="Finished"
          value={data.finished_at ? new Date(data.finished_at).toLocaleString() : "—"}
        />
        <Row
          label="Wall time"
          value={formatDuration(data.started_at, data.finished_at)}
        />
      </div>

      {/* Event log */}
      <div className="px-4 py-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Audit trail
        </p>
        <ol className="space-y-1">
          {data.events.map((e, i) => (
            <li key={i} className="flex gap-3 items-start">
              <span className="w-1.5 h-1.5 mt-1.5 rounded-full bg-gray-400 shrink-0" />
              <span className="text-xs text-gray-700">
                <span className="font-medium">
                  {EVENT_LABELS[e.event_type] ?? e.event_type}
                </span>
                <span className="ml-2 text-gray-400">
                  {new Date(e.timestamp).toLocaleString()}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
