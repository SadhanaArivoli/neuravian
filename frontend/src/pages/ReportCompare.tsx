import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { compareReports, type ReportComparison, type ReportPipelineDiff } from "../api/client";

// ── Delta badge ───────────────────────────────────────────────────────────────

function Delta({ n }: { n: number }) {
  if (n === 0) return <span className="text-gray-500">±0</span>;
  return (
    <span className={n > 0 ? "text-green-400" : "text-red-400"}>
      {n > 0 ? "+" : ""}{n}
    </span>
  );
}

function Pill({ label, color }: { label: string; color: "green" | "red" | "blue" | "gray" }) {
  const cls: Record<string, string> = {
    green: "bg-green-500/15 text-green-300",
    red: "bg-red-500/15 text-red-300",
    blue: "bg-blue-500/15 text-blue-300",
    gray: "bg-white/8 text-gray-400",
  };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls[color]}`}>{label}</span>;
}

// ── Pipeline diff rows ────────────────────────────────────────────────────────

function PipelineDiffRow({ diff }: { diff: ReportPipelineDiff }) {
  const pill =
    diff.change === "added" ? <Pill label="added" color="green" /> :
    diff.change === "removed" ? <Pill label="removed" color="red" /> :
    <Pill label="modified" color="blue" />;

  return (
    <div className="px-4 py-3 space-y-1">
      <div className="flex items-center gap-2">
        <code className="text-xs font-mono text-gray-300">{diff.pipeline}</code>
        {pill}
      </div>
      {diff.details && (
        <div className="pl-3 space-y-1">
          {diff.details.version && (
            <p className="text-xs text-gray-500">
              Version: <code className="text-red-300">{diff.details.version.a ?? "—"}</code>
              {" → "}
              <code className="text-green-300">{diff.details.version.b ?? "—"}</code>
            </p>
          )}
          {diff.details.artifact_count && (
            <p className="text-xs text-gray-500">
              Artifacts: <span className="text-gray-300">{diff.details.artifact_count.a} → {diff.details.artifact_count.b}</span>
            </p>
          )}
          {diff.details.params && Object.entries(diff.details.params).map(([k, v]) => (
            <p key={k} className="text-xs text-gray-500">
              <code className="text-gray-400">{k}</code>:{" "}
              <code className="text-red-300">{String(v.a ?? "—")}</code>
              {" → "}
              <code className="text-green-300">{String(v.b ?? "—")}</code>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, children, noChange }: { title: string; children: React.ReactNode; noChange?: boolean }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-2">
        {title}
        {noChange && <Pill label="no change" color="gray" />}
      </h3>
      <div className="rounded-lg border border-white/8 bg-surface-raised divide-y divide-white/5">
        {children}
      </div>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatRow({ label, a, b }: { label: string; a: React.ReactNode; b: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 px-4 py-2.5 text-xs">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-300 font-mono">{a}</span>
      <span className="text-gray-300 font-mono">{b}</span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReportCompare() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const datasetId = Number(id);
  const aId = Number(params.get("a") ?? 0);
  const bId = Number(params.get("b") ?? 0);

  const { data: cmp, isLoading, error } = useQuery<ReportComparison>({
    queryKey: ["report-compare", datasetId, aId, bId],
    queryFn: () => compareReports(datasetId, aId, bId),
    enabled: aId > 0 && bId > 0,
    staleTime: 60_000,
  });

  if (!aId || !bId) {
    return (
      <div className="p-8">
        <p className="text-sm text-red-400">Missing report IDs in URL (?a=X&b=Y).</p>
        <Link to={`/datasets/${datasetId}/reports`} className="text-xs text-accent mt-2 inline-block">← Reports</Link>
      </div>
    );
  }

  if (isLoading) {
    return <div className="p-8"><p className="text-sm text-gray-400 animate-pulse">Loading comparison…</p></div>;
  }

  if (error || !cmp) {
    return (
      <div className="p-8">
        <p className="text-sm text-red-400">{error ? String(error) : "Failed to load comparison."}</p>
        <Link to={`/datasets/${datasetId}/reports`} className="text-xs text-accent mt-2 inline-block">← Reports</Link>
      </div>
    );
  }

  const noRunChange = cmp.runs.added.length === 0 && cmp.runs.removed.length === 0;
  const noPipelineChange = cmp.pipelines.length === 0;
  const noWarningChange = cmp.warnings.added.length === 0 && cmp.warnings.removed.length === 0;

  return (
    <div className="p-8 max-w-3xl space-y-8">
      <div>
        <Link to={`/datasets/${datasetId}/reports`} className="text-xs text-gray-500 hover:text-gray-300">
          ← Reports
        </Link>
        <h2 className="text-2xl font-semibold mt-1">
          Report #{cmp.report_a.id} vs #{cmp.report_b.id}
        </h2>
        <p className="text-xs text-gray-500 mt-0.5">Structured diff — no AI-generated interpretation.</p>
      </div>

      {/* Summary header */}
      <Section title="Summary">
        <div className="grid grid-cols-3 gap-4 px-4 py-2.5 text-xs font-semibold text-gray-500">
          <span>Metric</span>
          <span>Report #{cmp.report_a.id}</span>
          <span>Report #{cmp.report_b.id}</span>
        </div>
        <StatRow
          label="Generated"
          a={new Date(cmp.report_a.created_at).toLocaleString()}
          b={new Date(cmp.report_b.created_at).toLocaleString()}
        />
        <StatRow label="Total runs" a={cmp.report_a.total_runs} b={cmp.report_b.total_runs} />
        <StatRow label="Successful runs" a={cmp.report_a.success_runs} b={cmp.report_b.success_runs} />
        <StatRow
          label="Total artifacts"
          a={cmp.artifacts.a}
          b={<span>{cmp.artifacts.b} (<Delta n={cmp.artifacts.delta} />)</span>}
        />
      </Section>

      {/* Runs */}
      <Section title="Runs" noChange={noRunChange}>
        {noRunChange ? (
          <div className="px-4 py-3 text-xs text-gray-500">Same runs in both reports.</div>
        ) : (
          <>
            {cmp.runs.added.length > 0 && (
              <div className="px-4 py-3">
                <p className="text-xs font-medium text-green-400 mb-1">Added ({cmp.runs.added.length})</p>
                <div className="flex flex-wrap gap-1.5">
                  {cmp.runs.added.map((rid) => (
                    <code key={rid} className="text-xs bg-green-500/10 text-green-300 rounded px-1.5 py-0.5">run-{rid}</code>
                  ))}
                </div>
              </div>
            )}
            {cmp.runs.removed.length > 0 && (
              <div className="px-4 py-3">
                <p className="text-xs font-medium text-red-400 mb-1">Removed ({cmp.runs.removed.length})</p>
                <div className="flex flex-wrap gap-1.5">
                  {cmp.runs.removed.map((rid) => (
                    <code key={rid} className="text-xs bg-red-500/10 text-red-300 rounded px-1.5 py-0.5">run-{rid}</code>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Section>

      {/* Pipelines */}
      <Section title="Pipeline changes" noChange={noPipelineChange}>
        {noPipelineChange ? (
          <div className="px-4 py-3 text-xs text-gray-500">Same pipelines, versions, and parameters.</div>
        ) : (
          cmp.pipelines.map((d) => <PipelineDiffRow key={`${d.pipeline}-${d.change}`} diff={d} />)
        )}
      </Section>

      {/* Warnings */}
      <Section title="Warnings" noChange={noWarningChange}>
        {noWarningChange ? (
          <div className="px-4 py-3 text-xs text-gray-500">Same warnings in both reports.</div>
        ) : (
          <>
            {cmp.warnings.added.map((w) => (
              <div key={w} className="flex items-start gap-2 px-4 py-2.5">
                <Pill label="added" color="red" />
                <span className="text-xs text-gray-300">{w}</span>
              </div>
            ))}
            {cmp.warnings.removed.map((w) => (
              <div key={w} className="flex items-start gap-2 px-4 py-2.5">
                <Pill label="resolved" color="green" />
                <span className="text-xs text-gray-400 line-through">{w}</span>
              </div>
            ))}
          </>
        )}
      </Section>

      <div className="text-xs text-gray-600 border-t border-white/5 pt-4">
        Comparison is based on the structured JSON report data. Narrative wording is not compared.
        No AI-generated interpretation is included.
      </div>
    </div>
  );
}
