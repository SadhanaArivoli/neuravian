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
    delete window.neuravianDesktop;
  });

  it("keeps the Neuravian Viewer as the browser default", () => {
    render(<OpenWithViewer runId={7} artifact={anatomy} candidates={[anatomy]} onOpenNeuravian={vi.fn()} />);
    const selector = screen.getByLabelText("Open orig_nu.mgz with viewer") as HTMLSelectElement;
    expect(selector.value).toBe("neuravian");
    expect(screen.getByRole("option", { name: "FreeView" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "MRIcroGL" })).toBeDisabled();
    expect(screen.getByText(/unavailable in the browser/i)).toBeInTheDocument();
  });

  it("opens the built-in viewer and persists the preference", () => {
    const open = vi.fn();
    render(<OpenWithViewer runId={7} artifact={anatomy} candidates={[anatomy]} onOpenNeuravian={open} />);
    fireEvent.change(screen.getByLabelText("Open orig_nu.mgz with viewer"), { target: { value: "neuravian" } });
    expect(open).toHaveBeenCalledOnce();
    expect(localStorage.getItem("neuravian.preferredViewer")).toBe("neuravian");
  });

  it("opens a desktop artifact directly from the local workspace", async () => {
    window.neuravianDesktop = {
      detectViewers: vi.fn(async () => [
        { viewerId: "freeview", displayName: "FreeView", installed: true, executable: "/freeview", reason: null },
      ]),
      getLocalWorkspaceIdentity: vi.fn(async () => ({
        schemaVersion: 1, workspaceId: "local-5df1dc24-a857-4adf-8908-1f8a7f36d058", createdAt: "2026-07-18T00:00:00Z",
      })),
      launchLocalViewer: vi.fn(async () => true),
    } as unknown as NeuravianDesktopBridge;
    render(<OpenWithViewer runId={109} artifact={anatomy} candidates={[anatomy]} onOpenNeuravian={vi.fn()} />);
    const option = await screen.findByRole("option", { name: "FreeView" });
    expect(option).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Open orig_nu.mgz with viewer"), { target: { value: "freeview" } });
    await screen.findByText(/opened directly from its existing local artifact/i);
    expect(window.neuravianDesktop.launchLocalViewer).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "local-5df1dc24-a857-4adf-8908-1f8a7f36d058",
      runId: 109,
    }));
  });
});
