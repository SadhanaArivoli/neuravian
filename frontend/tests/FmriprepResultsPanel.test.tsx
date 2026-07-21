import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunResults } from "../src/api/client";
import FmriprepResultsPanel from "../src/components/domain/FmriprepResultsPanel";

const results = {
  reports: [{ name: "sub-01.html", path: "sub-01.html", size: 62000 }],
  metrics: [],
  niftis: [],
  artifacts: [],
  files: [
    { name: "sub-01.html", path: "sub-01.html", size: 62000 },
    { name: "sub-01_dseg.svg", path: "sub-01/figures/sub-01_dseg.svg", size: 1200 },
    { name: "sub-01_desc-preproc_T1w.nii.gz", path: "sub-01/anat/sub-01_desc-preproc_T1w.nii.gz", size: 1000000 },
    { name: "sub-01_dseg.nii.gz", path: "sub-01/anat/sub-01_dseg.nii.gz", size: 100000 },
    { name: "sub-01_from-T1w_to-MNI_mode-image_xfm.h5", path: "sub-01/anat/sub-01_from-T1w_to-MNI_mode-image_xfm.h5", size: 2000 },
  ],
} as RunResults;

describe("fMRIPrep results workspace", () => {
  it("separates the official report from the exploratory viewer and preserves relative report loading", () => {
    render(<FmriprepResultsPanel runId={5} results={results} />);
    expect(screen.getByText("Official fMRIPrep participant report")).toBeInTheDocument();
    expect(screen.queryByText(/MRIQC/)).not.toBeInTheDocument();
    const frame = screen.getByTitle("Official fMRIPrep participant report");
    expect(frame).toHaveAttribute("src", "/api/runs/5/files/sub-01.html");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-popups");

    fireEvent.click(screen.getByRole("tab", { name: "Interactive Viewer" }));
    expect(screen.getByText("Anatomical")).toBeInTheDocument();
    expect(screen.getByText("Tissue Segmentation")).toBeInTheDocument();
    expect(screen.getByText(/no implicit resampling/i)).toBeInTheDocument();
  });

  it("keeps transforms downloadable but does not offer image viewing", () => {
    render(<FmriprepResultsPanel runId={5} results={results} />);
    fireEvent.click(screen.getByRole("tab", { name: "All Outputs" }));
    const transform = screen.getByText("Spatial transform").closest("div.flex");
    expect(transform).toBeTruthy();
    expect(transform).not.toHaveTextContent("View");
    expect(transform).toHaveTextContent("Open");
  });
});
