import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  LoaderCircle,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import type {
  PipelinePreflightCheck,
  PipelinePreflightResult,
} from "../../api/client";

interface Props {
  result: PipelinePreflightResult | null;
  loading: boolean;
  error: string | null;
  remote: boolean;
}

const STATUS_STYLE = {
  pass: { icon: CheckCircle2, text: "text-emerald-300", bg: "bg-emerald-500/10" },
  warning: { icon: AlertTriangle, text: "text-amber-300", bg: "bg-amber-500/10" },
  fail: { icon: XCircle, text: "text-red-300", bg: "bg-red-500/10" },
  unknown: { icon: CircleHelp, text: "text-gray-300", bg: "bg-white/5" },
} as const;

function CheckRow({ check }: { check: PipelinePreflightCheck }) {
  const style = STATUS_STYLE[check.status];
  const Icon = style.icon;
  return (
    <li className={`rounded-lg px-3 py-2.5 ${style.bg}`}>
      <div className="flex items-start gap-2.5">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.text}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-gray-100">{check.label}</span>
            {check.blocking && check.status === "fail" && (
              <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">
                Blocks launch
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-gray-300">{check.message}</p>
          {check.remediation && check.status !== "pass" && (
            <p className="mt-1 text-xs leading-relaxed text-gray-400">
              <span className="font-medium text-gray-300">How to fix:</span>{" "}
              {check.remediation}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

export function PipelinePreflightPanel({ result, loading, error, remote }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (remote) {
    return (
      <section className="rounded-xl border border-white/10 bg-white/[0.035] p-4" aria-label="Pipeline preflight">
        <p className="text-sm font-medium text-gray-200">Cloud workspace selected</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-400">
          These checks describe only this computer. Confirm the connection and
          available tools in Workspaces before starting the run.
        </p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.035] p-4" aria-label="Pipeline preflight" aria-live="polite">
        <LoaderCircle className="h-4 w-4 animate-spin text-violet-300" aria-hidden="true" />
        <span className="text-sm text-gray-300">Checking this machine and selected inputs…</span>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4" aria-label="Pipeline preflight" role="status">
        <p className="text-sm font-medium text-amber-200">Preflight unavailable</p>
        <p className="mt-1 text-xs text-amber-100/75">{error}</p>
      </section>
    );
  }

  if (!result) return null;
  const failures = result.checks.filter((check) => check.status === "fail");
  const warnings = result.checks.filter((check) => check.status === "warning");
  const passes = result.checks.filter((check) => check.status === "pass");
  const unknown = result.checks.filter((check) => check.status === "unknown");
  const visible = expanded ? result.checks : [...failures, ...warnings, ...unknown];
  const summary = !result.can_launch
    ? `${failures.filter((check) => check.blocking).length} blocking check${failures.filter((check) => check.blocking).length === 1 ? "" : "s"}`
    : warnings.length > 0
      ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`
      : "Ready to launch";

  return (
    <section className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.035]" aria-label="Pipeline preflight" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="flex items-start gap-2.5">
          <ShieldAlert className={`mt-0.5 h-5 w-5 ${result.can_launch ? "text-emerald-300" : "text-red-300"}`} aria-hidden="true" />
          <div>
            <h3 className="text-sm font-semibold text-gray-100">Preflight</h3>
            <p className={`mt-0.5 text-xs ${result.can_launch ? "text-gray-400" : "text-red-300"}`}>{summary}</p>
          </div>
        </div>
        <div className="text-right text-[11px] text-gray-400">
          {passes.length} passed · {warnings.length} warnings · {failures.length} failed
        </div>
      </div>

      {result.empirical_status === "pending-x86_64" && (
        <div className="border-y border-violet-400/15 bg-violet-500/10 px-4 py-2.5 text-xs text-violet-200">
          Pending empirical x86_64 verification. This is not the same as unsupported.
        </div>
      )}

      {visible.length > 0 && (
        <ul className="space-y-2 p-3">
          {visible.map((check) => <CheckRow key={check.id} check={check} />)}
        </ul>
      )}

      {passes.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center justify-center gap-1.5 border-t border-white/8 px-4 py-2.5 text-xs font-medium text-gray-400 transition-colors hover:bg-white/5 hover:text-gray-200 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/50"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? "Hide passed checks" : `Show ${passes.length} passed checks`}
        </button>
      )}
    </section>
  );
}
