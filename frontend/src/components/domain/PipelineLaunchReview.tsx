import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import type {
  DatasetSummary,
  Pipeline,
  PipelinePreflightResult,
} from "../../api/client";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(gb: number): string {
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  return `${gb} GB`;
}

function fmtRuntime(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours === Math.floor(hours)) return `${hours}h`;
  return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;
}

// ── sub-components ────────────────────────────────────────────────────────────

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-white/6 last:border-0">
      <span className="w-36 shrink-0 text-xs font-medium text-gray-500 uppercase tracking-wide pt-0.5">{label}</span>
      <div className="flex-1 text-sm text-gray-200">{children}</div>
    </div>
  );
}

function ResourceChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-white/10 bg-white/5 px-4 py-3 min-w-[100px]">
      <span className="text-base font-semibold text-gray-100 tabular-nums">{value}</span>
      <span className="text-[10px] text-gray-500 uppercase tracking-wide mt-0.5">{label}</span>
    </div>
  );
}

function PreflightSummary({ result }: { result: PipelinePreflightResult }) {
  const failures = result.checks.filter((c) => c.status === "fail");
  const warnings = result.checks.filter((c) => c.status === "warning");
  const passes = result.checks.filter((c) => c.status === "pass");

  return (
    <div className="space-y-1.5">
      {failures.map((c) => (
        <div key={c.id} className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2.5">
          <XCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />
          <div>
            <p className="text-sm font-medium text-red-200">{c.label}</p>
            <p className="text-xs text-red-300/80 mt-0.5">{c.message}</p>
            {c.remediation && (
              <p className="text-xs text-gray-400 mt-1"><span className="font-medium text-gray-300">Fix:</span> {c.remediation}</p>
            )}
          </div>
          {c.blocking && (
            <span className="ml-auto shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">
              Blocking
            </span>
          )}
        </div>
      ))}
      {warnings.map((c) => (
        <div key={c.id} className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
          <div>
            <p className="text-sm font-medium text-amber-200">{c.label}</p>
            <p className="text-xs text-amber-300/80 mt-0.5">{c.message}</p>
            {c.remediation && (
              <p className="text-xs text-gray-400 mt-1"><span className="font-medium text-gray-300">Fix:</span> {c.remediation}</p>
            )}
          </div>
        </div>
      ))}
      {passes.length > 0 && failures.length === 0 && warnings.length === 0 && (
        <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2.5">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          <p className="text-sm text-emerald-200">All {passes.length} checks passed</p>
        </div>
      )}
      {passes.length > 0 && (failures.length > 0 || warnings.length > 0) && (
        <p className="text-xs text-gray-500 pl-1">{passes.length} additional checks passed</p>
      )}
    </div>
  );
}

// ── main export ───────────────────────────────────────────────────────────────

export interface LaunchReviewProps {
  pipeline: Pipeline;
  dataset: DatasetSummary;
  subjects: string;
  remoteHostName: string | null;
  preflight: PipelinePreflightResult | null;
  existingRunCount: number;
  launching: boolean;
  launchError: string | null;
  onBack: () => void;
  onLaunch: () => void;
  paramsSnapshot: Record<string, unknown>;
}

export function PipelineLaunchReview({
  pipeline,
  dataset,
  subjects,
  remoteHostName,
  preflight,
  existingRunCount,
  launching,
  launchError,
  onBack,
  onLaunch,
  paramsSnapshot,
}: LaunchReviewProps) {
  const canLaunch = !preflight || preflight.can_launch;
  const res = pipeline.resources;
  const subjectList = subjects
    ? subjects.split(/\s+/).filter(Boolean)
    : null;
  const subjectDisplay = subjectList
    ? subjectList.length <= 6
      ? subjectList.map((s) => `sub-${s}`).join(", ")
      : `${subjectList.slice(0, 5).map((s) => `sub-${s}`).join(", ")} +${subjectList.length - 5} more`
    : `All ${dataset.subject_count} subjects`;

  const executionTarget = remoteHostName
    ? `Cloud / Remote — ${remoteHostName}`
    : "Local (this machine)";

  // Derive notable params for the summary (exclude internal / positional defaults)
  const notableParams = pipeline.parameters
    .filter((p) => !p.internal && !p.advanced && p.name !== "participant-label")
    .filter((p) => {
      const v = paramsSnapshot[p.name];
      return v !== undefined && v !== "" && v !== false;
    })
    .slice(0, 6);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-gray-500 hover:text-gray-200 transition-colors"
        >
          ← Back to parameters
        </button>
      </div>

      <div>
        <h2 className="text-xl font-semibold text-gray-100">Review Run</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Confirm the details below, then submit.
        </p>
      </div>

      {/* ── Job summary ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-white/10 bg-surface-raised overflow-hidden">
        <div className="px-4 py-3 bg-white/[0.03] border-b border-white/8">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Run Summary
          </h3>
        </div>
        <div className="px-4 py-1 divide-y divide-white/5">
          <SummaryRow label="Pipeline">
            <span className="font-medium">{pipeline.display_name}</span>
            {pipeline.container && (
              <span className="ml-2 text-gray-500 text-xs font-mono">
                {pipeline.container.tag.startsWith("sha256:")
                  ? `@${pipeline.container.tag.slice(7, 19)}…`
                  : `v${pipeline.container.tag}`}
              </span>
            )}
          </SummaryRow>
          <SummaryRow label="Dataset">
            <span className="font-mono text-xs text-gray-300 break-all">{dataset.path}</span>
            <span className="ml-2 text-gray-500 text-xs">
              ({dataset.name ?? dataset.path.split("/").pop()})
            </span>
          </SummaryRow>
          <SummaryRow label="Participants">
            <span className="font-mono text-xs">{subjectDisplay}</span>
          </SummaryRow>
          <SummaryRow label="Execution">
            <span>{executionTarget}</span>
          </SummaryRow>
          {pipeline.produces && pipeline.produces.length > 0 && (
            <SummaryRow label="Outputs">
              <div className="space-y-1">
                {pipeline.produces.map((p, i) => (
                  <div key={i}>
                    <span className="font-medium text-violet-300">{p.label ?? p.type}</span>
                    {p.description && (
                      <p className="text-xs text-gray-400 mt-0.5">{p.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </SummaryRow>
          )}
          {notableParams.length > 0 && (
            <SummaryRow label="Parameters">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {notableParams.map((p) => (
                  <span key={p.name} className="text-xs">
                    <span className="text-gray-500 font-mono">{p.name}=</span>
                    <span className="text-gray-300 font-mono">{String(paramsSnapshot[p.name])}</span>
                  </span>
                ))}
              </div>
            </SummaryRow>
          )}
        </div>
      </div>

      {/* ── Resource estimates ───────────────────────────────────────────── */}
      {(res || pipeline.max_runtime_hours) && (
        <div className="rounded-xl border border-white/10 bg-surface-raised overflow-hidden">
          <div className="px-4 py-3 bg-white/[0.03] border-b border-white/8">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Estimated Requirements
            </h3>
          </div>
          <div className="px-4 py-4 flex flex-wrap gap-3">
            {pipeline.max_runtime_hours && (
              <ResourceChip
                label="Duration"
                value={`up to ${fmtRuntime(pipeline.max_runtime_hours)}`}
              />
            )}
            {res?.recommended_ram_gb && (
              <ResourceChip label="RAM" value={`${fmtBytes(res.recommended_ram_gb)}`} />
            )}
            {res?.recommended_cpu_count && (
              <ResourceChip label="CPU" value={`${res.recommended_cpu_count} cores`} />
            )}
            {res?.output_space_gb && (
              <ResourceChip label="Disk out" value={fmtBytes(res.output_space_gb)} />
            )}
            {res?.working_space_gb && (
              <ResourceChip label="Disk work" value={fmtBytes(res.working_space_gb)} />
            )}
          </div>
          {res?.min_ram_gb && res.recommended_ram_gb && res.min_ram_gb < res.recommended_ram_gb && (
            <p className="px-4 pb-3 text-xs text-gray-500">
              Minimum: {res.min_ram_gb} GB RAM, {res.min_cpu_count} CPU.{" "}
              Recommended values shown above.
            </p>
          )}
        </div>
      )}

      {/* ── Existing derivatives diff ────────────────────────────────────── */}
      {existingRunCount > 0 && (
        <div className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
          <div className="text-sm text-amber-200">
            <p className="font-medium">
              {existingRunCount} previous {pipeline.display_name}{" "}
              {existingRunCount === 1 ? "run exists" : "runs exist"} for this dataset.
            </p>
            <p className="mt-1 text-xs text-amber-300/80">
              Launching will create an additional derivative alongside the existing{" "}
              {existingRunCount === 1 ? "one" : `${existingRunCount}`}. Outputs are
              not overwritten — each run writes to its own timestamped directory.
            </p>
          </div>
        </div>
      )}

      {/* ── Preflight ───────────────────────────────────────────────────── */}
      {preflight && (
        <div className="rounded-xl border border-white/10 bg-surface-raised overflow-hidden">
          <div className="px-4 py-3 bg-white/[0.03] border-b border-white/8 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Validation
            </h3>
            <span className={`text-xs font-medium ${preflight.can_launch ? "text-emerald-400" : "text-red-400"}`}>
              {preflight.can_launch ? "Ready" : "Blocking issues"}
            </span>
          </div>
          <div className="px-4 py-3">
            <PreflightSummary result={preflight} />
          </div>
        </div>
      )}

      {/* ── Launch error ─────────────────────────────────────────────────── */}
      {launchError && (
        <p role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {launchError}
        </p>
      )}

      {/* ── Action bar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 pt-2 border-t border-white/8">
        <button
          type="button"
          onClick={onLaunch}
          disabled={launching || !canLaunch}
          className="rounded-lg bg-accent px-8 py-3 text-sm font-semibold text-white shadow-lg shadow-accent/15 transition-all hover:-translate-y-px hover:bg-accent-hover focus:outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {launching ? "Starting run…" : "Start Run"}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={launching}
          className="text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
        >
          Edit parameters
        </button>
        {!canLaunch && preflight && (
          <p className="text-xs text-red-400 ml-auto">
            Resolve blocking checks to enable launch.
          </p>
        )}
      </div>
    </div>
  );
}
