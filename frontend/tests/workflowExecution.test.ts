import { describe, expect, it } from "vitest";
import {
  canMarkWorkflowComplete, classifyExecutionRequirement, firstCloudHandoffIndex,
  nextIncompleteNode, planWorkflowExecution, requiredUpstreamTransfers,
} from "../src/lib/workflowExecution";

const nodes = [
  { id: "validator", pipelineId: "bids-validator", displayName: "BIDS Validator", computeProfile: "local-ok" as const, inputArtifactType: "bids_dataset" },
  { id: "bet", pipelineId: "fsl-bet", displayName: "BET", computeProfile: "local-ok" as const, inputArtifactType: "t1w" },
  { id: "fnirt", pipelineId: "fsl-fnirt", displayName: "FNIRT", computeProfile: "local-unsafe" as const, inputArtifactType: "brain" },
];

describe("mixed workflow execution planning", () => {
  it("classifies local, recommended, required, and unavailable nodes", () => {
    expect(classifyExecutionRequirement("local-ok")).toBe("local-capable");
    expect(classifyExecutionRequirement("local-slow")).toBe("cloud-recommended");
    expect(classifyExecutionRequirement("local-unsafe")).toBe("cloud-required");
    expect(classifyExecutionRequirement(null)).toBe("unavailable");
  });

  it("keeps one ordered plan with mixed locations", () => {
    expect(planWorkflowExecution(nodes).map((node) => node.executionLocation)).toEqual(["Local", "Local", "Cloud"]);
  });

  it("does not rerun completed local nodes when resuming", () => {
    expect(firstCloudHandoffIndex(planWorkflowExecution(nodes), new Set(["validator", "bet"]))).toBe(2);
    expect(nextIncompleteNode([{ id: "a", status: "success" }, { id: "b", status: "failed" }])?.id).toBe("b");
  });

  it("selects only the artifact type required by the cloud node", () => {
    const selected = requiredUpstreamTransfers([
      { type: "brain", label: "Brain", description: "", resolved: true, multiple: false, resolution_source: "run", paths: [], host_paths: ["/safe/brain.nii.gz"] },
      { type: "report", label: "Report", description: "", resolved: true, multiple: false, resolution_source: "run", paths: [], host_paths: ["/safe/report.html"] },
    ], "brain");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.relativePath).toBe("brain.nii.gz");
  });

  it("requires return synchronization before completion", () => {
    expect(canMarkWorkflowComplete("synchronizing-results", false)).toBe(false);
    expect(canMarkWorkflowComplete("synchronizing-results", true)).toBe(true);
    expect(canMarkWorkflowComplete("running-remote", true)).toBe(false);
  });
});
