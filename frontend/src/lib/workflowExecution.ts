import type { ComputeProfile, RunArtifact } from "../api/client";

export type ExecutionRequirement = "local-capable" | "cloud-recommended" | "cloud-required" | "unavailable";
export type WorkflowExecutionStatus =
  | "planned" | "running-local" | "handoff-required" | "synchronizing-inputs"
  | "starting-remote" | "running-remote" | "synchronizing-results" | "failed" | "complete";

export interface PlannableNode {
  id: string;
  pipelineId: string;
  displayName: string;
  computeProfile: ComputeProfile | null;
  inputArtifactType: string;
}

export interface PlannedNode extends PlannableNode {
  requirement: ExecutionRequirement;
  executionLocation: "Local" | "Cloud" | null;
  reason: string;
}

export interface TransferCandidate {
  artifactKey: string;
  relativePath: string;
  hostPath: string;
  sizeBytes: number | null;
  sha256: string | null;
}

export function classifyExecutionRequirement(
  profile: ComputeProfile | null,
  options: { localAvailable?: boolean; cloudAvailable?: boolean } = {},
): ExecutionRequirement {
  const localAvailable = options.localAvailable ?? true;
  const cloudAvailable = options.cloudAvailable ?? true;
  if (!profile) return "unavailable";
  if (profile === "local-ok") return localAvailable ? "local-capable" : cloudAvailable ? "cloud-recommended" : "unavailable";
  if (profile === "local-slow") return cloudAvailable ? "cloud-recommended" : localAvailable ? "local-capable" : "unavailable";
  return cloudAvailable ? "cloud-required" : "unavailable";
}

export function planWorkflowExecution(
  nodes: PlannableNode[],
  options: { localAvailable?: boolean; cloudAvailable?: boolean } = {},
): PlannedNode[] {
  return nodes.map((node) => {
    const requirement = classifyExecutionRequirement(node.computeProfile, options);
    const executionLocation = requirement === "unavailable"
      ? null
      : requirement === "cloud-required" || requirement === "cloud-recommended"
        ? "Cloud"
        : "Local";
    const reason = requirement === "local-capable"
      ? "Supported on this machine."
      : requirement === "cloud-recommended"
        ? "May be slow or resource-intensive locally."
        : requirement === "cloud-required"
          ? "This pipeline is not approved for local execution."
          : "No compatible execution environment is available.";
    return { ...node, requirement, executionLocation, reason };
  });
}

export function firstCloudHandoffIndex(plan: PlannedNode[], completedNodeIds: Set<string>): number {
  return plan.findIndex((node) => !completedNodeIds.has(node.id) && node.executionLocation === "Cloud");
}

/** Select only the artifact type consumed by the next node; never upload a whole run directory. */
export function requiredUpstreamTransfers(artifacts: RunArtifact[], inputArtifactType: string): TransferCandidate[] {
  const matches = artifacts.filter((artifact) => artifact.resolved && artifact.type === inputArtifactType);
  const transfers: TransferCandidate[] = [];
  for (const artifact of matches) {
    const paths = artifact.host_paths.length ? artifact.host_paths : artifact.paths;
    for (let index = 0; index < paths.length; index++) {
      const hostPath = paths[index]!;
      transfers.push({
        artifactKey: `${artifact.type}-${index}`,
        relativePath: hostPath.split(/[\\/]/).pop() ?? `${artifact.type}-${index}`,
        hostPath,
        sizeBytes: null,
        sha256: null,
      });
    }
  }
  return transfers;
}

export function nextIncompleteNode<T extends { id: string; status: string }>(nodes: T[]): T | null {
  return nodes.find((node) => node.status !== "success") ?? null;
}

export function canMarkWorkflowComplete(status: WorkflowExecutionStatus, returnSyncComplete: boolean): boolean {
  return status === "synchronizing-results" && returnSyncComplete;
}
