import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { ComputeProfile, PrefillContext, RunArtifact } from "../../api/client";
import { useCompatiblePipelines, useRun } from "../../hooks/useRuns";
import { usePipelines } from "../../hooks/usePipelines";

// ── Compute profile badge ─────────────────────────────────────────────────────

const PROFILE_BADGE: Record<ComputeProfile, { label: string; className: string }> = {
  "local-ok": {
    label: "Local OK",
    className: "border border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  },
  "local-slow": {
    label: "Slow locally",
    className: "border border-amber-500/20 bg-amber-500/10 text-amber-300",
  },
  "local-unsafe": {
    label: "Cloud recommended",
    className: "border border-red-500/20 bg-red-500/10 text-red-300",
  },
};

function ComputeProfileBadge({ profile }: { profile: ComputeProfile | null }) {
  if (!profile || !(profile in PROFILE_BADGE)) return null;
  const { label, className } = PROFILE_BADGE[profile];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  artifacts: RunArtifact[];
  runId: number;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RunNextCard({ artifacts, runId }: Props) {
  const navigate = useNavigate();

  // Only resolved artifacts can feed downstream pipelines.
  const resolvedTypes = [
    ...new Set(artifacts.filter((a) => a.resolved).map((a) => a.type)),
  ];

  const { data: compatible = [], isLoading } = useCompatiblePipelines(resolvedTypes);

  // Fetch the current run and all pipeline summaries to get the upstream
  // pipeline's display name for the provenance helper text.
  const { data: run } = useRun(runId);
  const { data: allPipelines } = usePipelines();
  const sourceDisplayName = useMemo(() => {
    if (!run || !allPipelines) return "";
    return allPipelines.find((p) => p.id === run.pipeline_manifest_id)?.display_name ?? run.pipeline_manifest_id;
  }, [run, allPipelines]);

  // Hide entirely when there is nothing to show.
  if (resolvedTypes.length === 0 || (!isLoading && compatible.length === 0)) {
    return null;
  }

  // Don't flash an empty card while loading; wait silently.
  if (isLoading) return null;

  function handleConfigure(pipelineId: string, p: (typeof compatible)[0]) {
    // Find the resolved artifact whose type matches what this pipeline accepts.
    const artifact = p.accept_type
      ? artifacts.find((a) => a.resolved && a.type === p.accept_type)
      : undefined;

    const hostPath = artifact?.host_paths?.[0] ?? null;

    let prefill: PrefillContext | null = null;

    const sourcePipelineId = run?.pipeline_manifest_id ?? "";

    if (p.accept_dataset_slot) {
      // Dataset-slot pipelines (MRIQC, fMRIPrep) receive the BIDS dataset via the
      // dataset selector, not a named parameter. Path prefill is not supported here
      // without a reverse DB lookup. The user must pick the dataset manually.
      prefill = {
        runId,
        sourcePipelineId,
        sourceDisplayName,
        artifactType: artifact?.type ?? p.accept_type ?? "",
        artifactLabel: artifact?.label ?? p.accept_label ?? "",
        param: null,
        path: null,
        isDatasetSlot: true,
      };
    } else if (p.accept_param && hostPath) {
      prefill = {
        runId,
        sourcePipelineId,
        sourceDisplayName,
        artifactType: artifact?.type ?? p.accept_type ?? "",
        artifactLabel: artifact?.label ?? p.accept_label ?? "",
        param: p.accept_param,
        path: hostPath,
        isDatasetSlot: false,
      };
    }

    // Navigate to the Pipelines page and signal which pipeline to pre-select.
    // React Router state (not URL params) keeps state ephemeral and URL clean.
    navigate("/pipelines", { state: { selectPipeline: pipelineId, prefill } });
  }

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-white/10 bg-surface-raised shadow-xl shadow-black/10" aria-labelledby="run-next-heading">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/8 bg-white/[0.035] px-4 py-3">
        <svg
          className="h-4 w-4 text-accent shrink-0"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
            clipRule="evenodd"
          />
        </svg>
        <div>
          <span id="run-next-heading" className="text-sm font-semibold text-gray-100">Run Next</span>
          <span className="ml-2 text-xs text-gray-400">
            These pipelines can use outputs from this run.
          </span>
        </div>
      </div>

      {/* Pipeline list */}
      <ul className="divide-y divide-white/5">
        {compatible.map((p) => (
          <li
            key={p.pipeline_id}
            className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-white/[0.025]"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="truncate text-sm font-medium text-gray-200">
                  {p.display_name}
                </span>
                <ComputeProfileBadge profile={p.compute_profile} />
              </div>
              {p.accept_label && (
                <p className="mt-0.5 truncate text-xs text-gray-400">
                  Uses {p.accept_label}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => handleConfigure(p.pipeline_id, p)}
              className="shrink-0 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-violet-200 transition-colors hover:bg-accent/20"
            >
              Configure →
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
