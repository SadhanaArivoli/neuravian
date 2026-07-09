import { useState } from "react";
import type { RunMetadata } from "../../api/client";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRuntime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const PROFILE_LABEL: Record<string, { label: string; className: string }> = {
  "local-ok":     { label: "Local OK",            className: "bg-green-100 text-green-700 border border-green-200" },
  "local-slow":   { label: "Slow locally",        className: "bg-amber-100 text-amber-700 border border-amber-200" },
  "local-unsafe": { label: "Cloud recommended",   className: "bg-red-100 text-red-700 border border-red-200" },
};

// ── CopyPath — truncated monospace path with clipboard copy ───────────────────

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span
        className="font-mono text-xs text-gray-300 truncate"
        title={path}
      >
        {path}
      </span>
      <button
        type="button"
        onClick={copy}
        title="Copy path"
        className="shrink-0 text-gray-500 hover:text-gray-200 transition-colors"
        aria-label="Copy path to clipboard"
      >
        {copied ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-green-400">
            <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M11 3.5A1.5 1.5 0 0 0 9.5 2h-5A1.5 1.5 0 0 0 3 3.5v8A1.5 1.5 0 0 0 4.5 13H5v-2.5A2.5 2.5 0 0 1 7.5 8H11V3.5Zm1.5 5A1 1 0 0 1 13 9.5V13a1 1 0 0 1-1 1H7.5a1 1 0 0 1-1-1V9.5A1 1 0 0 1 7.5 8.5h4a1 1 0 0 1 1 1Z" clipRule="evenodd" />
          </svg>
        )}
      </button>
    </span>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-x-3 py-1.5 border-b border-white/5 last:border-0 min-w-0">
      <dt className="text-xs text-gray-500 self-center shrink-0">{label}</dt>
      <dd className="text-xs text-gray-200 min-w-0">{children}</dd>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface Props {
  metadata: RunMetadata;
}

export default function RunMetadataPanel({ metadata }: Props) {
  const profileBadge = metadata.compute_profile
    ? PROFILE_LABEL[metadata.compute_profile]
    : null;

  const paramEntries = Object.entries(metadata.params ?? {});

  return (
    <details className="mt-4 group rounded-lg border border-white/10 bg-surface-raised overflow-hidden">
      <summary className="flex cursor-pointer select-none list-none items-center justify-between px-4 py-2.5 text-sm font-medium text-gray-200 hover:bg-white/5 transition-colors">
        <span className="flex items-center gap-2">
          {/* Clipboard-list icon */}
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-gray-400">
            <path fillRule="evenodd" d="M4 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 12 2H4Zm1 3.25a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 5.25Zm0 3a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 5 8.25Zm0 3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5h-2A.75.75 0 0 1 5 11.25Z" clipRule="evenodd" />
          </svg>
          Run Metadata
        </span>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"
          className="w-4 h-4 text-gray-500 transition-transform duration-150 group-open:rotate-180">
          <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
        </svg>
      </summary>

      <dl className="px-4 pb-3 pt-1 overflow-hidden">
        {/* Pipeline */}
        <Row label="Pipeline">
          <span className="font-medium">
            {metadata.pipeline_display_name ?? metadata.pipeline_id}
          </span>
          <span className="ml-2 text-gray-500">v{metadata.pipeline_version}</span>
        </Row>

        {/* Status */}
        <Row label="Status">
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            metadata.status === "success" ? "bg-green-100 text-green-700 border border-green-200"
            : metadata.status === "failed"  ? "bg-red-100 text-red-700 border border-red-200"
            : "bg-gray-100 text-gray-600 border border-gray-200"
          }`}>
            {metadata.status}
          </span>
        </Row>

        {/* Runtime */}
        {metadata.runtime_seconds !== null && (
          <Row label="Runtime">
            {formatRuntime(metadata.runtime_seconds)}
            {metadata.started_at && (
              <span className="ml-2 text-gray-500">
                · started {formatDate(metadata.started_at)}
              </span>
            )}
          </Row>
        )}

        {/* Compute profile */}
        {profileBadge && (
          <Row label="Compute profile">
            <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${profileBadge.className}`}>
              {profileBadge.label}
            </span>
          </Row>
        )}

        {/* Execution type */}
        <Row label="Execution">
          {metadata.execution_type === "docker" ? (
            <>
              <span className="mr-1.5">Docker</span>
              {metadata.container_image && (
                <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px] text-gray-300">
                  {metadata.container_image}
                </code>
              )}
            </>
          ) : (
            <span>
              Native
              {metadata.pipeline_id && (
                <code className="ml-1.5 rounded bg-white/10 px-1 py-0.5 font-mono text-[11px] text-gray-300">
                  {metadata.pipeline_id}
                </code>
              )}
            </span>
          )}
        </Row>

        {/* Dataset */}
        <Row label="Dataset">
          <span className="mr-1.5">
            {metadata.dataset_name ?? `Dataset #${metadata.dataset_id}`}
          </span>
          {metadata.dataset_path && (
            <span className="text-gray-500 font-mono text-[11px] truncate" title={metadata.dataset_path}>
              ({metadata.dataset_path})
            </span>
          )}
        </Row>

        {/* Output folder */}
        {metadata.output_dir && (
          <Row label="Output folder">
            <CopyPath path={metadata.output_dir} />
          </Row>
        )}

        {/* Command */}
        {metadata.command_preview && (
          <Row label="Command">
            <div className="min-w-0">
              <code
                className="block font-mono text-[11px] text-gray-300 whitespace-pre-wrap break-all leading-relaxed"
                style={{ maxHeight: "6rem", overflowY: "auto" }}
              >
                {metadata.command_preview}
              </code>
            </div>
          </Row>
        )}

        {/* Parameters */}
        {paramEntries.length > 0 && (
          <Row label="Parameters">
            <dl className="space-y-1 min-w-0">
              {paramEntries.map(([k, v]) => {
                const str = Array.isArray(v) ? v.join(", ") : String(v);
                const isPath = str.startsWith("/") || str.includes("\\");
                return (
                  <div key={k} className="grid grid-cols-[8rem_1fr] gap-x-2 min-w-0">
                    <dt className="text-gray-500 truncate" title={k}>{k}</dt>
                    <dd className="min-w-0">
                      {isPath ? (
                        <CopyPath path={str} />
                      ) : (
                        <code className="font-mono text-[11px] text-gray-300 break-all">{str}</code>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </Row>
        )}
      </dl>
    </details>
  );
}
