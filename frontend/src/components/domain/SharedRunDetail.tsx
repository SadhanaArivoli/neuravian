import { CheckCircle2, Circle, Download, Loader2, RefreshCw, XCircle } from "lucide-react";

export type ExecutionLocation = "Local" | "EC2" | "Cluster";

export interface SharedRunDetailModel {
  id: number;
  pipelineId: string;
  pipelineName?: string | null;
  pipelineVersion?: string | null;
  executionLocation: ExecutionLocation;
  executionTarget?: string | null;
  status: string;
  createdAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  command?: string | null;
  containerImage?: string | null;
  containerDigest?: string | null;
  parameters?: Record<string, unknown>;
  dataset?: { id?: number | null; name?: string | null; path?: string | null };
  outputDir?: string | null;
  metadata?: unknown;
  provenance?: unknown;
  artifactCount?: number;
  reportCount?: number;
}

function date(value?: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function formatRunDuration(startedAt?: string | null, finishedAt?: string | null): string {
  if (!startedAt || !finishedAt) return "—";
  const seconds = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const STAGES = ["Queued", "Preparing", "Running", "Finalizing", "Synchronizing", "Completed"];

function stageIndex(status: string): number {
  if (status === "pending" || status === "queued") return 0;
  if (status === "running") return 2;
  if (status === "success") return STAGES.length - 1;
  if (["failed", "cancelled", "interrupted"].includes(status)) return 2;
  return 0;
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === "success"
    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
    : status === "running"
      ? "border-blue-400/20 bg-blue-400/10 text-blue-300"
      : ["failed", "cancelled", "interrupted"].includes(status)
        ? "border-red-400/20 bg-red-400/10 text-red-300"
        : "border-amber-400/20 bg-amber-400/10 text-amber-300";
  return <span className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${tone}`}>{status}</span>;
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className={`mt-1 break-words text-xs text-gray-200 ${mono ? "font-mono" : ""}`}>{value ?? "—"}</dd>
    </div>
  );
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return null;
  return (
    <details className="rounded-lg border border-white/8 bg-black/15">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-300 hover:text-white">{title}</summary>
      <pre className="max-h-72 overflow-auto border-t border-white/8 p-3 text-[10px] leading-relaxed text-gray-400">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function exportModel(model: SharedRunDetailModel) {
  const blob = new Blob([JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), run: model }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `run-${model.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SharedRunDetail({
  model,
  onDuplicate,
  onRunNext,
  headerAction,
  children,
}: {
  model: SharedRunDetailModel;
  onDuplicate?: () => void;
  onRunNext?: () => void;
  headerAction?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const current = stageIndex(model.status);
  const failed = ["failed", "cancelled", "interrupted"].includes(model.status);
  const complete = model.status === "success";
  const pipeline = model.pipelineName || model.pipelineId;

  return (
    <div data-testid="shared-run-detail" className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-white">Run #{model.id} — {pipeline}</h1>
            <StatusBadge status={model.status} />
            <span className="rounded-full border border-accent/20 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">{model.executionLocation}</span>
          </div>
          <p className="mt-1 text-xs text-gray-500">{model.pipelineId}{model.pipelineVersion ? ` · ${model.pipelineVersion}` : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {onRunNext && <button type="button" onClick={onRunNext} className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-gray-950 hover:bg-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Run Next</button>}
          {onDuplicate && <button type="button" onClick={onDuplicate} className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><RefreshCw className="h-3.5 w-3.5" />Duplicate Run</button>}
          <button type="button" onClick={() => exportModel(model)} className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><Download className="h-3.5 w-3.5" />Export JSON</button>
          {headerAction}
        </div>
      </header>

      <section aria-label="Run metadata" className="rounded-xl border border-white/10 bg-surface-raised p-4 shadow-xl shadow-black/10">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Execution location" value={model.executionLocation} />
          <Field label="Execution target" value={model.executionTarget || "This machine"} />
          <Field label="Started" value={date(model.startedAt)} />
          <Field label="Finished" value={date(model.finishedAt)} />
          <Field label="Duration" value={formatRunDuration(model.startedAt, model.finishedAt)} />
          <Field label="Dataset / input" value={model.dataset?.name || (model.dataset?.id ? `Dataset ${model.dataset.id}` : model.dataset?.path) || "—"} />
          <Field label="Artifacts" value={model.artifactCount ?? "—"} />
          <Field label="Reports" value={model.reportCount ?? "—"} />
          {model.containerImage && <Field label="Container image" value={model.containerImage} mono />}
          {model.containerDigest && <Field label="Container digest" value={model.containerDigest} mono />}
          {model.outputDir && <Field label="Output directory" value={model.outputDir} mono />}
        </dl>
        {model.command && <div className="mt-4 border-t border-white/8 pt-4"><Field label="Command" value={<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-black/25 p-3 text-[10px]">{model.command}</pre>} /></div>}
      </section>

      <section aria-label="Execution stages" className="rounded-xl border border-white/10 bg-surface-raised p-4 shadow-xl shadow-black/10">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Execution stages</h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {STAGES.map((label, index) => {
            const done = complete || index < current;
            const active = !complete && !failed && index === current;
            const error = failed && index === current;
            const Icon = done ? CheckCircle2 : active ? Loader2 : error ? XCircle : Circle;
            return <li key={label} className={`flex items-center gap-2 text-xs ${done ? "text-emerald-300" : active ? "text-blue-300" : error ? "text-red-300" : "text-gray-600"}`}><Icon className={`h-4 w-4 shrink-0 ${active ? "animate-spin" : ""}`} />{label}</li>;
          })}
        </ol>
      </section>

      <section aria-label="Run details" className="grid gap-3 lg:grid-cols-3">
        <JsonSection title="Parameters" value={model.parameters ?? {}} />
        <JsonSection title="Metadata" value={model.metadata} />
        <JsonSection title="Provenance" value={model.provenance} />
      </section>
      {children}
    </div>
  );
}
