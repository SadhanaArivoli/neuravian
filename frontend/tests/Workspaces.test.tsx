import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Workspaces from "../src/pages/Workspaces";

const profile: WorkspaceProfile = {
  id: "profile-1", name: "AWS EC2", serverUrl: "https://cloud.example",
  authenticationRef: "os-credential:profile-1", serverIdentity: "workspace-a",
  lastSync: "2026-07-18T00:00:00Z", connectionState: "connected",
};
const snapshot: WorkspaceSnapshot = {
  schemaVersion: 1, workspaceId: "workspace-a", profileId: profile.id,
  serverUrl: profile.serverUrl, synchronizedAt: "2026-07-18T00:00:00Z",
  projects: [{ id: 1, remoteKey: "workspace-a:project:1", title: "ASD Study", datasetIds: [1] }],
  datasets: [{ id: 1, remoteKey: "workspace-a:dataset:1", name: "Dataset 1" }],
  workflows: [{
    id: 3, remoteKey: "workspace-a:workflow:3", name: "Structural", dataset_id: 1,
    state: { nodes: [{ pipelineId: "fastsurfer" }] },
  }],
  reports: [],
  runs: [{
    id: 7, remoteKey: "workspace-a:run:7", dataset_id: 1, pipeline_manifest_id: "fastsurfer",
    pipeline_version: "1", status: "success", created_at: "2026-07-15T00:00:00Z",
    cacheState: "cloud-only", artifacts: [
      { artifactId: 1, relativePath: "sub-01/mri/orig_nu.mgz", url: "/one", sha256: "a", sizeBytes: 1 },
      { artifactId: 2, relativePath: "sub-01/mri/aseg.auto.mgz", url: "/two", sha256: "b", sizeBytes: 1 },
    ],
  }],
};

describe("unified desktop workspaces", () => {
  beforeEach(() => {
    window.neuroforgeDesktop = {
      detectViewers: vi.fn(async () => []),
      listWorkspaces: vi.fn(async () => [profile]),
      saveWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      syncWorkspace: vi.fn(async () => ({ online: true, profile, snapshot })),
      syncWorkspaceArtifacts: vi.fn(async () => ({ runId: 7, downloaded: ["one", "two"], reused: [] })),
      syncRun: vi.fn(),
      launchViewer: vi.fn(async () => true),
    };
  });

  it("shows cloud projects, workflow hierarchy, runs, and cache state automatically", async () => {
    render(<Workspaces />);
    expect(await screen.findByText("ASD Study")).toBeInTheDocument();
    expect(screen.getByText("Structural")).toBeInTheDocument();
    expect(screen.getAllByText("Run #7").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Cloud Only").length).toBeGreaterThan(0);
  });

  it("downloads only the FreeView preset artifacts and launches from cache", async () => {
    render(<Workspaces />);
    const buttons = await screen.findAllByRole("button", { name: "Open in FreeView" });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(window.neuroforgeDesktop!.syncWorkspaceArtifacts).toHaveBeenCalledWith({
      profileId: "profile-1",
      workspaceId: "workspace-a",
      runId: 7,
      relativePaths: ["sub-01/mri/orig_nu.mgz", "sub-01/mri/aseg.auto.mgz"],
    }));
    expect(window.neuroforgeDesktop!.launchViewer).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-a",
      runId: 7,
      viewerId: "freeview",
    }));
  });
});
