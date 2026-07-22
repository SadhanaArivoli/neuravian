import { classifyNeuroArtifact, type ArtifactViewModel } from "./neuroArtifactView";

export type ArtifactOrigin = "local" | "cloud" | "remote" | "synchronized" | "imported" | "cached";
export type ArtifactAvailability = "available" | "streaming" | "synchronizing" | "unavailable" | "error";
export type ArtifactViewerAdapter = "neuroimage" | "surface" | "report" | "image" | "structured" | "text" | "download";

export interface CanonicalArtifactInput {
  id: string | number;
  name: string;
  relativePath: string;
  origin?: ArtifactOrigin;
  family?: string | null;
  scientificRole?: string | null;
  mediaType?: string | null;
  size?: number | null;
  checksum?: string | null;
  sourceRunId?: number | null;
  provenanceUrl?: string | null;
  contentUrl?: string | null;
  availability?: ArtifactAvailability;
  synchronized?: boolean;
  materialized?: boolean;
  canDownload?: boolean;
  pipelineId?: string;
}

export interface CanonicalArtifact extends CanonicalArtifactInput {
  origin: ArtifactOrigin;
  availability: ArtifactAvailability;
  synchronized: boolean;
  materialized: boolean;
  canDownload: boolean;
  view: ArtifactViewModel;
  viewer: ArtifactViewerAdapter;
}

export function selectArtifactViewer(view: ArtifactViewModel): ArtifactViewerAdapter {
  if (view.kind === "volume") return "neuroimage";
  if (view.kind === "surface" || view.kind === "surface-overlay" || view.kind === "annotation") return "surface";
  if (view.kind === "report") return "report";
  if (view.kind === "image") return "image";
  if (view.kind === "table" || view.kind === "statistics" || view.kind === "metadata") return "structured";
  if (view.kind === "log") return "text";
  return "download";
}

export function normalizeArtifact(input: CanonicalArtifactInput): CanonicalArtifact {
  const view = classifyNeuroArtifact({
    artifactId: input.id,
    name: input.name,
    path: input.relativePath,
    size: input.size ?? undefined,
  }, input.pipelineId);
  return {
    ...input,
    origin: input.origin ?? "local",
    availability: input.availability ?? "available",
    synchronized: input.synchronized ?? (input.origin === "synchronized" || input.origin === "cached"),
    materialized: input.materialized ?? (input.origin !== "cloud" && input.origin !== "remote"),
    canDownload: input.canDownload ?? true,
    view,
    viewer: selectArtifactViewer(view),
  };
}

export function artifactAvailabilityLabel(artifact: CanonicalArtifact) {
  if (artifact.availability === "synchronizing") return "Synchronizing";
  if (artifact.availability === "streaming") return "Streaming from workspace";
  if (artifact.availability === "unavailable" || artifact.availability === "error") return "Temporarily unavailable";
  return artifact.materialized ? "Available locally" : "Available from workspace";
}
