import { Link } from "react-router-dom";
import { useRuns } from "../hooks/useRuns";

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    running: "bg-blue-100 text-blue-800",
    success: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
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

function duration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const secs = Math.round((e - s) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

export default function Runs() {
  const { data: runs, isLoading, error } = useRuns();

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Runs</h1>

      {isLoading && <p className="text-sm text-gray-500">Loading run history…</p>}
      {error && (
        <p className="text-sm text-red-600">{(error as Error).message}</p>
      )}

      {runs && runs.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-8 text-center">
          <p className="text-sm text-gray-500">No runs yet.</p>
          <p className="text-xs text-gray-400 mt-1">
            Go to Pipelines, select MRIQC, and start your first run.
          </p>
        </div>
      )}

      {runs && runs.length > 0 && (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">#</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Pipeline</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Dataset</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Duration</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {runs.map((run) => (
                <tr key={run.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      to={`/runs/${run.id}`}
                      className="font-medium text-blue-600 hover:underline"
                    >
                      {run.id}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-900">
                    {run.pipeline_manifest_id}{" "}
                    <span className="text-gray-400 text-xs">{run.pipeline_version}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    dataset #{run.dataset_id}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {duration(run.started_at, run.finished_at)}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {run.started_at
                      ? new Date(run.started_at).toLocaleString()
                      : new Date(run.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
