import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ValidationIssues } from "../src/api/client";
import {
  ValidationResults,
  ValidationStatusBanner,
} from "../src/components/domain/ValidationResults";

describe("ValidationStatusBanner", () => {
  it("shows valid state", () => {
    render(<ValidationStatusBanner status="valid" />);
    expect(screen.getByText(/valid bids dataset/i)).toBeInTheDocument();
  });

  it("shows invalid state", () => {
    render(<ValidationStatusBanner status="invalid" />);
    expect(screen.getByText(/validation errors/i)).toBeInTheDocument();
  });

  it("shows warning state", () => {
    render(<ValidationStatusBanner status="warning" />);
    expect(screen.getByText(/valid with warnings/i)).toBeInTheDocument();
  });
});

describe("ValidationResults", () => {
  it("shows no-issues message when empty", () => {
    const issues: ValidationIssues = { errors: [], warnings: [] };
    render(<ValidationResults issues={issues} />);
    expect(screen.getByText(/no issues found/i)).toBeInTheDocument();
  });

  it("renders errors with friendly message", () => {
    const issues: ValidationIssues = {
      errors: [
        {
          code: "MISSING_DATASET_DESCRIPTION",
          message: "raw message",
          friendly: "Your dataset is missing dataset_description.json",
          fix_hint: "Create the file",
          files: ["dataset_description.json"],
        },
      ],
      warnings: [],
    };
    render(<ValidationResults issues={issues} />);
    expect(screen.getByText(/missing dataset_description\.json/i)).toBeInTheDocument();
    expect(screen.getByText(/create the file/i)).toBeInTheDocument();
    expect(screen.getByText("MISSING_DATASET_DESCRIPTION")).toBeInTheDocument();
  });

  it("renders warnings separately from errors", () => {
    const issues: ValidationIssues = {
      errors: [],
      warnings: [
        {
          code: "MISSING_PARTICIPANTS_TSV",
          message: "raw",
          friendly: "Your dataset is missing participants.tsv",
          fix_hint: null,
          files: [],
        },
      ],
    };
    render(<ValidationResults issues={issues} />);
    expect(screen.getByText(/warnings \(1\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/errors/i)).not.toBeInTheDocument();
  });

  it("shows affected files count", () => {
    const issues: ValidationIssues = {
      errors: [],
      warnings: [
        {
          code: "MISSING_JSON_SIDECAR",
          message: "raw",
          friendly: "NIfTI without sidecar",
          fix_hint: null,
          files: ["sub-01/anat/sub-01_T1w.nii.gz", "sub-01/func/sub-01_task-rest_bold.nii.gz"],
        },
      ],
    };
    render(<ValidationResults issues={issues} />);
    expect(screen.getByText(/2 affected files/i)).toBeInTheDocument();
  });
});
