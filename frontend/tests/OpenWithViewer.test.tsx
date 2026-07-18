import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OpenWithViewer from "../src/components/domain/OpenWithViewer";
import { classifyNeuroArtifact } from "../src/lib/neuroArtifactView";

describe("Open With viewer selector", () => {
  const anatomy = classifyNeuroArtifact(
    { name: "orig_nu.mgz", path: "mri/orig_nu.mgz" },
    "fastsurfer",
  );

  beforeEach(() => {
    localStorage.clear();
    delete window.neuroforgeDesktop;
  });

  it("keeps the NeuroForge Viewer as the browser default", () => {
    render(<OpenWithViewer runId={7} artifact={anatomy} candidates={[anatomy]} onOpenNeuroForge={vi.fn()} />);
    const selector = screen.getByLabelText("Open orig_nu.mgz with viewer") as HTMLSelectElement;
    expect(selector.value).toBe("neuroforge");
    expect(screen.getByRole("option", { name: "FreeView" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "MRIcroGL" })).toBeDisabled();
    expect(screen.getByText(/unavailable in the browser/i)).toBeInTheDocument();
  });

  it("opens the built-in viewer and persists the preference", () => {
    const open = vi.fn();
    render(<OpenWithViewer runId={7} artifact={anatomy} candidates={[anatomy]} onOpenNeuroForge={open} />);
    fireEvent.change(screen.getByLabelText("Open orig_nu.mgz with viewer"), { target: { value: "neuroforge" } });
    expect(open).toHaveBeenCalledOnce();
    expect(localStorage.getItem("neuroforge.preferredViewer")).toBe("neuroforge");
  });
});
