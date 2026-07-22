import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SharedRunDetail, formatRunDuration, type SharedRunDetailModel } from "../src/components/domain/SharedRunDetail";

const base: SharedRunDetailModel = {
  id: 42,
  pipelineId: "fsl-bet",
  pipelineName: "FSL BET",
  pipelineVersion: "6.0.7",
  executionLocation: "Local",
  status: "success",
  createdAt: "2026-07-20T18:00:00Z",
  startedAt: "2026-07-20T18:00:00Z",
  finishedAt: "2026-07-20T18:02:05Z",
  command: "bet input.nii.gz output.nii.gz",
  containerImage: "fsl/fsl:6.0.7",
  containerDigest: "sha256:abc",
  parameters: { frac: 0.5 },
  dataset: { id: 3, name: "BET example" },
  metadata: { execution_type: "docker" },
  provenance: { host: "local" },
  artifactCount: 2,
  reportCount: 1,
};

describe("shared Run Detail", () => {
  it("renders the complete normalized local run summary", () => {
    render(<SharedRunDetail model={base} />);
    expect(screen.getByTestId("shared-run-detail")).toHaveTextContent("Run #42 — FSL BET");
    expect(screen.getAllByText("Local")).toHaveLength(2);
    expect(screen.getByText("2m 5s")).toBeInTheDocument();
    expect(screen.getByText("fsl/fsl:6.0.7")).toBeInTheDocument();
    expect(screen.getByText("sha256:abc")).toBeInTheDocument();
  });

  it("renders cloud execution as metadata through the same component", () => {
    render(<SharedRunDetail model={{ ...base, executionLocation: "EC2", executionTarget: "AWS Neuravian" }} />);
    expect(screen.getByTestId("shared-run-detail")).toHaveTextContent("EC2");
    expect(screen.getByText("AWS Neuravian")).toBeInTheDocument();
  });

  it("handles missing optional metadata without hiding core run state", () => {
    render(<SharedRunDetail model={{ id: 7, pipelineId: "unknown", executionLocation: "Cluster", status: "running" }} />);
    expect(screen.getByText("Run #7 — unknown")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByLabelText("Execution stages")).toBeInTheDocument();
  });

  it("exposes Duplicate Run and Export JSON actions", () => {
    const duplicate = vi.fn();
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const createObjectURL = vi.fn(() => "blob:run");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    render(<SharedRunDetail model={base} onDuplicate={duplicate} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Run" }));
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    expect(duplicate).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:run");
    clickSpy.mockRestore();
  });
});

describe("formatRunDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatRunDuration("2026-07-20T00:00:00Z", "2026-07-20T00:00:12Z")).toBe("12s");
    expect(formatRunDuration("2026-07-20T00:00:00Z", "2026-07-20T01:02:00Z")).toBe("1h 2m");
  });
});
