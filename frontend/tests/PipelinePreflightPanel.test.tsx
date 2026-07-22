import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { PipelinePreflightResult } from "../src/api/client";
import { PipelinePreflightPanel } from "../src/components/domain/PipelinePreflightPanel";

const result: PipelinePreflightResult = {
  pipeline_id: "fmriprep",
  empirical_status: "pending-x86_64",
  can_launch: false,
  checks: [
    {
      id: "architecture",
      label: "CPU architecture",
      status: "pass",
      message: "Linux x86_64 detected.",
      remediation: null,
      blocking: false,
      measured_value: "x86_64",
      required_value: "x86_64",
    },
    {
      id: "license",
      label: "FreeSurfer license",
      status: "fail",
      message: "The license file is missing.",
      remediation: "Select a readable license file.",
      blocking: true,
      measured_value: false,
      required_value: true,
    },
  ],
};

describe("PipelinePreflightPanel", () => {
  it("separates pending empirical verification from unsupported", () => {
    render(<PipelinePreflightPanel result={result} loading={false} error={null} remote={false} />);
    expect(screen.getByText(/pending empirical x86_64 verification/i)).toBeInTheDocument();
    expect(screen.getByText(/not the same as unsupported/i)).toBeInTheDocument();
  });

  it("shows blocking remediation and keeps passed checks collapsed", async () => {
    const user = userEvent.setup();
    render(<PipelinePreflightPanel result={result} loading={false} error={null} remote={false} />);
    expect(screen.getByText("Blocks launch")).toBeInTheDocument();
    expect(screen.getByText(/select a readable license file/i)).toBeInTheDocument();
    expect(screen.queryByText("Linux x86_64 detected.")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show 1 passed check/i }));
    expect(screen.getByText("Linux x86_64 detected.")).toBeInTheDocument();
  });

  it("does not apply local checks to a remote target", () => {
    render(<PipelinePreflightPanel result={null} loading={false} error={null} remote />);
    expect(screen.getByText(/checks describe only this computer/i)).toBeInTheDocument();
  });
});
