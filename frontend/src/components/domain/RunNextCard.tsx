import { useNavigate } from "react-router-dom";
import type { ComputeProfile, RunArtifact } from "../../api/client";
import { useCompatiblePipelines } from "../../hooks/useRuns";

// ── Compute profile badge ─────────────────────────────────────────────────────

const PROFILE_BADGE: Record<ComputeProfile, { label: string; className: string }> = {
  "local-ok": {
    label: "Local OK",
    className: "bg-green-100 text-green-700 border border-green-200",
  },
  "local-slow": {
    label: "Slow locally",
    className: "bg-amber-100 text-amber-700 border border-amber-200",
  },
  "local-unsafe": {
    label: "Cloud recommended",
    className: "bg-red-100 text-red-700 border border-red-200",
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
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RunNextCard({ artifacts }: Props) {
  const navigate = useNavigate();

  // Only resolved artifacts can feed downstream pipelines.
  const resolvedTypes = [
    ...new Set(artifacts.filter((a) => a.resolved).map((a) => a.type)),
  ];

  const { data: compatible = [], isLoading } = useCompatiblePipelines(resolvedTypes);

  // Hide entirely when there is nothing to show.
  if (resolvedTypes.length === 0 || (!isLoading && compatible.length === 0)) {
    return null;
  }

  // Don't flash an empty card while loading; wait silently.
  if (isLoading) return null;

  function handleConfigure(pipelineId: string) {
    // Navigate to the Pipelines page and signal which pipeline to pre-select.
    // React Router state is used (not URL params) so:
    //   - No JSON in URLs
    //   - State is ephemeral (not bookmarked / shared)
    //   - Future prefill data can be added to the same state object
    navigate("/pipelines", { state: { selectPipeline: pipelineId } });
  }

  return (
    <div className="mt-6 rounded-lg border border-gray-200 bg-white overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-200">
        {/* Arrow-circle icon */}
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
          <span className="text-sm font-semibold text-gray-800">Run Next</span>
          <span className="ml-2 text-xs text-gray-500">
            These pipelines can use outputs from this run.
          </span>
        </div>
      </div>

      {/* Pipeline list */}
      <ul className="divide-y divide-gray-100">
        {compatible.map((p) => (
          <li
            key={p.pipeline_id}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-gray-800 truncate">
                  {p.display_name}
                </span>
                <ComputeProfileBadge profile={p.compute_profile} />
              </div>
              {p.accept_label && (
                <p className="mt-0.5 text-xs text-gray-500 truncate">
                  Uses {p.accept_label}
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={() => handleConfigure(p.pipeline_id)}
              className="shrink-0 rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20 transition-colors"
            >
              Configure →
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
