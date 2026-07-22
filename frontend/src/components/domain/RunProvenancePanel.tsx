import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Copy, Download, RefreshCw, XCircle } from "lucide-react";
import type { Run, RunMetadata, RunProvenance } from "../../api/client";
import { useRunProvenance } from "../../hooks/useRuns";
import { useDataset } from "../../hooks/useDatasets";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmtRuntime(seconds: number | null): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return { copy, copied };
}

// ── sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-2 mt-5 first:mt-0">
      {children}
    </h3>
  );
}

function Row({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-white/5 last:border-0">
      <span className="w-32 shrink-0 text-xs text-gray-500 pt-0.5">{label}</span>
      <span className={`flex-1 text-xs text-gray-200 break-all ${mono ? "font-mono" : ""}`}>
        {children}
      </span>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copy, copied } = useCopy(text);
  return (
    <button
      type="button"
      onClick={copy}
      className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-gray-400 hover:bg-white/10 hover:text-gray-200 transition-colors"
    >
      {copied ? <CheckCircle2 className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

// ── parameter rendering ────────────────────────────────────────────────────────

function buildCliArgs(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => {
      if (v === true) return `--${k}`;
      if (v === false || v === null || v === undefined || v === "") return "";
      if (Array.isArray(v)) return `--${k} ${v.join(" ")}`;
      return `--${k} ${String(v)}`;
    })
    .filter(Boolean)
    .join(" \\\n  ");
}

function ParamsSection({ params, pipelineId }: { params: Record<string, unknown>; pipelineId: string }) {
  const entries = Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== "");
  const jsonText = JSON.stringify(params, null, 2);
  const cliText = `${pipelineId} \\\n  ${buildCliArgs(params)}`;

  if (entries.length === 0) {
    return <p className="text-xs text-gray-500 italic">All defaults used.</p>;
  }

  return (
    <div>
      <div className="rounded-lg border border-white/10 bg-surface-overlay overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left px-3 py-2 text-gray-500 font-medium w-40">Parameter</th>
              <th className="text-left px-3 py-2 text-gray-500 font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([k, v]) => {
              const display = Array.isArray(v) ? v.join(", ") : String(v);
              return (
                <tr key={k} className="border-b border-white/5 last:border-0">
                  <td className="px-3 py-1.5 font-mono text-gray-400">{k}</td>
                  <td className="px-3 py-1.5 font-mono text-gray-200 break-all">{display}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2 mt-2">
        <CopyButton text={jsonText} label="Copy as JSON" />
        <CopyButton text={cliText} label="Copy as CLI" />
      </div>
    </div>
  );
}

// ── export bundle ─────────────────────────────────────────────────────────────

function buildProvenanceBundle(
  run: Run,
  metadata: RunMetadata | undefined,
  prov: RunProvenance | undefined,
): string {
  const bundle = {
    neuravian_provenance: {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
    },
    summary: {
      run_id: run.id,
      status: run.status,
      pipeline_id: run.pipeline_manifest_id,
      pipeline_version: run.pipeline_version,
      dataset_id: run.dataset_id ?? null,
      started_at: run.started_at ?? null,
      finished_at: run.finished_at ?? null,
      runtime_seconds: metadata?.runtime_seconds ?? null,
      execution_type: metadata?.execution_type ?? "unknown",
      execution_target: run.remote_host_id ? "remote" : "local",
    },
    environment: {
      container_image: metadata?.container_image ?? null,
      container_digest: prov?.container_digest ?? null,
      compute_profile: metadata?.compute_profile ?? null,
      execution_type: metadata?.execution_type ?? null,
      command_preview: metadata?.command_preview ?? run.command_preview ?? null,
    },
    dataset: {
      id: metadata?.dataset_id ?? null,
      name: metadata?.dataset_name ?? null,
      path: metadata?.dataset_path ?? null,
    },
    parameters: run.params ?? metadata?.params ?? {},
    outputs: {
      output_dir: run.output_dir ?? metadata?.output_dir ?? null,
    },
    lineage: metadata?.lineage ?? null,
    audit_events: prov?.events ?? [],
  };
  return JSON.stringify(bundle, null, 2);
}

function downloadJson(content: string, filename: string) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── main component ────────────────────────────────────────────────────────────

interface Props {
  run: Run;
  metadata?: RunMetadata;
}

export default function RunProvenancePanel({ run, metadata }: Props) {
  const navigate = useNavigate();
  const { data: prov } = useRunProvenance(run.id);
  const datasetId = metadata?.dataset_id ?? run.dataset_id;
  const { data: dataset } = useDataset(datasetId ?? 0);

  const params = run.params ?? metadata?.params ?? {};
  const outputDir = run.output_dir ?? metadata?.output_dir;
  const commandPreview = run.command_preview ?? metadata?.command_preview;
  const containerImage = metadata?.container_image;
  const executionTarget = run.remote_host_id ? "Remote host" : "Local (this machine)";
  const runtimeSeconds = metadata?.runtime_seconds ?? null;

  // Extract subjects / sessions from params
  const participantLabel = String(params["participant-label"] ?? "").trim();
  const sessionId = String(params["session-id"] ?? "").trim();
  const subjectDisplay = participantLabel
    ? participantLabel.split(/\s+/).map((s: string) => `sub-${s}`).join(", ")
    : `All ${dataset?.subject_count ?? "?"} subjects`;

  function handleDuplicateRun() {
    navigate("/pipelines", {
      state: {
        selectPipeline: run.pipeline_manifest_id,
        paramsOverride: { ...params },
        datasetOverride: datasetId ?? null,
      },
    });
  }

  function handleExport() {
    const content = buildProvenanceBundle(run, metadata, prov);
    downloadJson(content, `provenance-run-${run.id}.json`);
  }

  return (
    <div className="rounded-xl border border-white/10 bg-surface-raised overflow-hidden mb-4">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white/[0.03] border-b border-white/8">
        <h2 className="text-sm font-semibold text-gray-200">Provenance &amp; Reproducibility</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleDuplicateRun}
            className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Duplicate Run
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <Download className="h-3 w-3" />
            Export JSON
          </button>
        </div>
      </div>

      <div className="px-4 py-4 space-y-1">
        {/* ── Pipeline ──────────────────────────────────────────────────── */}
        <SectionHeader>Pipeline</SectionHeader>
        <Row label="Pipeline">
          <span className="font-medium">{metadata?.pipeline_display_name ?? run.pipeline_manifest_id}</span>
        </Row>
        <Row label="Version" mono>
          {prov?.pipeline_version ?? run.pipeline_version ?? "—"}
        </Row>
        <Row label="Execution">
          {executionTarget}
          {metadata?.compute_profile && (
            <span className="ml-2 text-gray-500">({metadata.compute_profile})</span>
          )}
        </Row>
        {containerImage && (
          <Row label="Container" mono>
            {containerImage}
          </Row>
        )}
        {prov?.container_digest && (
          <Row label="Image digest" mono>
            <span title={prov.container_digest} className="text-gray-400">
              {prov.container_digest.replace(/^sha256:/, "sha256:").slice(0, 32)}…
            </span>
            <CopyButton text={prov.container_digest} label="Copy" />
          </Row>
        )}
        {commandPreview && (
          <Row label="Command" mono>
            <div
              className="rounded bg-black/30 px-2 py-1.5 font-mono text-[11px] text-gray-300 whitespace-pre-wrap break-all leading-relaxed max-h-24 overflow-y-auto"
            >
              {commandPreview}
            </div>
          </Row>
        )}

        {/* ── Status & Timing ───────────────────────────────────────────── */}
        <SectionHeader>Timing</SectionHeader>
        <Row label="Status">
          <span className={`inline-flex items-center gap-1.5 font-medium ${
            run.status === "success" ? "text-green-400" :
            run.status === "failed" ? "text-red-400" : "text-gray-300"
          }`}>
            {run.status === "success" && <CheckCircle2 className="h-3.5 w-3.5" />}
            {run.status === "failed" && <XCircle className="h-3.5 w-3.5" />}
            {run.status}
          </span>
        </Row>
        <Row label="Launched">{fmtDate(run.started_at ?? run.created_at)}</Row>
        {run.finished_at && <Row label="Completed">{fmtDate(run.finished_at)}</Row>}
        {runtimeSeconds !== null && (
          <Row label="Wall time">{fmtRuntime(runtimeSeconds)}</Row>
        )}

        {/* ── Inputs ───────────────────────────────────────────────────── */}
        <SectionHeader>Inputs</SectionHeader>
        <Row label="Dataset" mono>
          {metadata?.dataset_path ?? dataset?.path ?? `Dataset #${datasetId}`}
        </Row>
        {dataset?.bids_version && (
          <Row label="BIDS version">{dataset.bids_version}</Row>
        )}
        {dataset && (
          <Row label="Validation">
            <span className={
              dataset.validation_status === "valid" ? "text-green-400" :
              dataset.validation_status === "invalid" ? "text-red-400" : "text-yellow-400"
            }>
              {dataset.validation_status}
            </span>
          </Row>
        )}
        <Row label="Subjects">{subjectDisplay}</Row>
        {sessionId && <Row label="Sessions">{sessionId}</Row>}

        {/* ── Parameters ───────────────────────────────────────────────── */}
        <SectionHeader>Parameters</SectionHeader>
        <ParamsSection
          params={params}
          pipelineId={run.pipeline_manifest_id}
        />

        {/* ── Outputs ──────────────────────────────────────────────────── */}
        {(outputDir) && (
          <>
            <SectionHeader>Outputs</SectionHeader>
            {outputDir && (
              <Row label="Output directory" mono>
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate text-gray-300" title={outputDir}>{outputDir}</span>
                  <CopyButton text={outputDir} label="Copy" />
                </span>
              </Row>
            )}
          </>
        )}

        {/* ── Lineage ──────────────────────────────────────────────────── */}
        {metadata?.lineage && (
          <>
            <SectionHeader>Upstream Lineage</SectionHeader>
            <Row label="Source run">
              <a
                href={`/runs/${metadata.lineage.upstream_run_id}`}
                className="text-accent hover:underline"
              >
                Run #{metadata.lineage.upstream_run_id}
              </a>
              <span className="ml-2 text-gray-500">
                {metadata.lineage.upstream_pipeline_display_name ?? metadata.lineage.upstream_pipeline_id}
              </span>
            </Row>
            {metadata.lineage.artifact_label && (
              <Row label="Artifact used">{metadata.lineage.artifact_label}</Row>
            )}
          </>
        )}

        {/* ── Audit trail ──────────────────────────────────────────────── */}
        {prov?.events && prov.events.length > 0 && (
          <>
            <SectionHeader>Audit Trail</SectionHeader>
            <ol className="space-y-1 pl-1">
              {prov.events.map((e, i) => {
                const labels: Record<string, string> = {
                  run_created: "Run queued",
                  execution_started: "Execution started",
                  execution_finished: "Execution finished",
                };
                return (
                  <li key={i} className="flex items-start gap-2 text-xs">
                    <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-gray-600 shrink-0" />
                    <span className="text-gray-300 font-medium">{labels[e.event_type] ?? e.event_type}</span>
                    <span className="text-gray-500 ml-auto">{fmtDate(e.timestamp)}</span>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
