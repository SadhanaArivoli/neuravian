import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunResults } from "../src/api/client";
import FastSurferResultsPanel from "../src/components/domain/FastSurferResultsPanel";

vi.mock("../src/components/domain/NiivueViewer", () => ({
  default: ({ layers, onClose }: { layers: Array<{ name: string; isSegmentation?: boolean }>; onClose: () => void }) => <div data-testid="viewer"><span>{layers.map((layer) => layer.name).join(" + ")}</span><span>{layers[layers.length - 1]?.isSegmentation ? "nearest labels" : "intensity"}</span><button onClick={onClose}>Close</button></div>,
}));

const files = [
  "subject/mri/orig.mgz",
  "subject/mri/orig_nu.mgz",
  "subject/mri/aseg.auto.mgz",
  "subject/mri/aparc.DKTatlas+aseg.deep.mgz",
  "subject/mri/cerebellum.CerebNet.nii.gz",
  "subject/mri/hypothalamus.HypVINN.nii.gz",
  "subject/stats/aseg.auto.mgz",
  "subject/surf/callosum.surf",
  "subject/surf/callosum.thickness.w",
  "subject/scripts/deep-seg.log",
  "subject/mri/transforms/orient_volume.lta",
].map((path) => ({ path, name: path.split("/").pop()!, size: 2048 }));

const results = { files, niftis: files.filter((file) => /\.(nii\.gz|mgz)$/.test(file.name)), reports: [], metrics: [], artifacts: [] } as RunResults;

describe("FastSurfer artifact workspace", () => {
  it("groups real segmentation-only output without offering broken surface/transform view actions", () => {
    render(<FastSurferResultsPanel runId={7} results={results} />);
    expect(screen.getByTestId("fastsurfer-results-workspace")).toBeInTheDocument();
    expect(screen.getAllByText("Conformed Anatomy")).not.toHaveLength(0);
    expect(screen.getAllByText("Cortical Parcellations")).not.toHaveLength(0);
    expect(screen.getAllByText("Surfaces")).not.toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "View" })).toHaveLength(6);
    expect(screen.getByText(/Transform artifacts are metadata-only/)).toBeInTheDocument();
  });

  it("opens a segmentation with the preferred orig_nu base and label semantics", () => {
    render(<FastSurferResultsPanel runId={7} results={results} />);
    fireEvent.click(screen.getByRole("button", { name: "Aseg over anatomy" }));
    expect(screen.getByTestId("viewer")).toHaveTextContent("orig_nu.mgz + aseg.auto.mgz");
    expect(screen.getByTestId("viewer")).toHaveTextContent("nearest labels");
  });

  it("disables presets when the output does not contain the artifact", () => {
    render(<FastSurferResultsPanel runId={7} results={results} />);
    expect(screen.getByRole("button", { name: "White-matter parcellation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cortical ribbon" })).toBeDisabled();
  });

  it("filters by text and output group", () => {
    render(<FastSurferResultsPanel runId={7} results={results} />);
    fireEvent.change(screen.getByLabelText("Search FastSurfer outputs"), { target: { value: "hypothalamus" } });
    expect(screen.getAllByText("Hypothalamic segmentation")).not.toHaveLength(0);
    expect(screen.queryByText("Bias-corrected conformed anatomy")).not.toBeInTheDocument();
  });
});
