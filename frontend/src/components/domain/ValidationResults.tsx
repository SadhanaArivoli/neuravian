import { CheckCircle, AlertTriangle, XCircle, Loader2, Clock } from "lucide-react";
import type { ValidationIssue, ValidationIssues } from "../../api/client";

const STATUS_STYLES = {
  valid: "bg-green-900/40 border-green-700 text-green-300",
  warning: "bg-yellow-900/40 border-yellow-700 text-yellow-300",
  invalid: "bg-red-900/40 border-red-700 text-red-300",
  error: "bg-red-900/40 border-red-700 text-red-300",
  indexing: "bg-blue-900/40 border-blue-700 text-blue-300",
  pending: "bg-gray-800 border-gray-600 text-gray-400",
} as const;

const STATUS_META: Record<string, { label: string; icon: React.ReactNode }> = {
  valid:    { label: "Valid BIDS dataset",      icon: <CheckCircle className="h-4 w-4" /> },
  warning:  { label: "Valid with warnings",     icon: <AlertTriangle className="h-4 w-4" /> },
  invalid:  { label: "Validation errors found", icon: <XCircle className="h-4 w-4" /> },
  error:    { label: "Could not validate",      icon: <XCircle className="h-4 w-4" /> },
  indexing: { label: "Indexing…",               icon: <Loader2 className="h-4 w-4 animate-spin" /> },
  pending:  { label: "Pending",                 icon: <Clock className="h-4 w-4" /> },
};

interface StatusBannerProps {
  status: string;
}

export function ValidationStatusBanner({ status }: StatusBannerProps) {
  const style = STATUS_STYLES[status as keyof typeof STATUS_STYLES] ?? STATUS_STYLES.pending;
  const { label, icon } = STATUS_META[status] ?? { label: status, icon: null };
  return (
    <div className={`inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium ${style}`}>
      {icon}{label}
    </div>
  );
}

interface IssueCardProps {
  issue: ValidationIssue;
  level: "error" | "warning";
}

function IssueCard({ issue, level }: IssueCardProps) {
  const border = level === "error" ? "border-red-700/50" : "border-yellow-700/50";
  const badge =
    level === "error"
      ? "bg-red-900/50 text-red-300"
      : "bg-yellow-900/50 text-yellow-300";

  return (
    <div className={`rounded-md border ${border} bg-surface-overlay p-4 space-y-2`}>
      <div className="flex items-start gap-2">
        <span className={`rounded px-1.5 py-0.5 text-xs font-mono ${badge}`}>
          {issue.code}
        </span>
      </div>
      <p className="text-sm text-gray-100">{issue.friendly}</p>
      {issue.fix_hint && (
        <p className="text-xs text-gray-400">
          <span className="font-medium text-gray-300">Fix: </span>
          {issue.fix_hint}
        </p>
      )}
      {issue.files.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300">
            {issue.files.length} affected file{issue.files.length !== 1 ? "s" : ""}
          </summary>
          <ul className="mt-1 space-y-0.5 pl-2">
            {issue.files.map((f) => (
              <li key={f} className="font-mono text-xs text-gray-400 truncate">
                {f}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

interface ValidationResultsProps {
  issues: ValidationIssues;
}

export function ValidationResults({ issues }: ValidationResultsProps) {
  const hasAny = issues.errors.length > 0 || issues.warnings.length > 0;

  if (!hasAny) {
    return (
      <p className="text-sm text-gray-400">
        No issues found. Your dataset looks good!
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {issues.errors.length > 0 && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-400">
            Errors ({issues.errors.length})
          </h4>
          <div className="space-y-2">
            {issues.errors.map((e) => (
              <IssueCard key={e.code} issue={e} level="error" />
            ))}
          </div>
        </section>
      )}
      {issues.warnings.length > 0 && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-yellow-400">
            Warnings ({issues.warnings.length})
          </h4>
          <div className="space-y-2">
            {issues.warnings.map((w) => (
              <IssueCard key={w.code} issue={w} level="warning" />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
