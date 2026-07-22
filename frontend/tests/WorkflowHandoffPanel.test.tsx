import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowHandoffPanel } from "../src/components/domain/WorkflowHandoffPanel";

describe("WorkflowHandoffPanel", () => {
  it("shows required disclosure without fabricating estimates", () => {
    render(<WorkflowHandoffPanel pipelineNames={["FNIRT", "fMRIPrep"]} artifactType="warped_t1" profiles={[{ id: "aws", name: "AWS Neuravian" }]} selectedProfileId="aws" busy={false} onSelectProfile={() => {}} onContinue={() => {}} />);
    expect(screen.getByText("This workflow now requires cloud execution.")).toBeInTheDocument();
    expect(screen.getByText("FNIRT, fMRIPrep")).toBeInTheDocument();
    expect(screen.getByText("No reliable estimate available")).toBeInTheDocument();
    expect(screen.getByText("AWS Neuravian")).toBeInTheDocument();
  });

  it("exposes one primary Continue in Cloud action", () => {
    const onContinue = vi.fn();
    render(<WorkflowHandoffPanel pipelineNames={["FNIRT"]} artifactType="brain" profiles={[{ id: "aws", name: "AWS" }]} selectedProfileId="aws" busy={false} onSelectProfile={() => {}} onContinue={onContinue} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue in Cloud" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
