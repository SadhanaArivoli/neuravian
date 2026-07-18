import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import Workspaces, { combineWorkspaceRuns, type LocalWorkspaceData } from "../src/pages/Workspaces";
import { WorkspaceProvider } from "../src/context/WorkspaceContext";

function renderWorkspace(view = "home") {
  return render(<MemoryRouter initialEntries={[`/workspaces?scope=cloud%3Aprofile-1${view === "home" ? "" : `&view=${view}`}`]}>
    <WorkspaceProvider><Workspaces /></WorkspaceProvider>
  </MemoryRouter>);
}

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
    cacheState: "cloud-only", cachedArtifacts: [], artifacts: [
      { artifactId: 1, relativePath: "sub-01/mri/orig_nu.mgz", url: "/one", sha256: "a", sizeBytes: 1 },
      { artifactId: 2, relativePath: "sub-01/mri/aseg.auto.mgz", url: "/two", sha256: "b", sizeBytes: 1 },
    ],
  }],
};

describe("unified desktop workspaces", () => {
  beforeEach(() => {
    window.neuroforgeDesktop = {
      detectViewers: vi.fn(async () => []),
      getLocalWorkspaceIdentity: vi.fn(async () => ({
        schemaVersion: 1 as const, workspaceId: "local-5df1dc24-a857-4adf-8908-1f8a7f36d058", createdAt: "2026-07-18T00:00:00Z",
      })),
      listWorkspaces: vi.fn(async () => [profile]),
      saveWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      testWorkspace: vi.fn(async () => ({ workspaceId: "workspace-a", product: "NeuroForge", apiVersion: "1", serverVersion: "0.1.0" })),
      inspectWorkspace: vi.fn(async (): Promise<WorkspaceInspection> => ({
        cacheSizeBytes: 2, cachedRuns: 0, cacheEntries: 0, legacyCacheEntries: ["run-7"],
        viewers: [
          { viewerId: "freeview", displayName: "FreeView", installed: true, executable: "/Applications/Freeview.app", reason: null },
          { viewerId: "mricrogl", displayName: "MRIcroGL", installed: false, executable: null, reason: "Not installed" },
        ],
      })),
      openWorkspaceRun: vi.fn(async () => true),
      syncWorkspace: vi.fn(async () => ({ online: true, profile, snapshot })),
      syncWorkspaceArtifacts: vi.fn(async () => ({ runId: 7, downloaded: ["one", "two"], reused: [] })),
      launchLocalViewer: vi.fn(async () => true),
      launchViewer: vi.fn(async () => true),
      pushCloudProject: vi.fn(async () => ({})),
      pushCloudWorkflow: vi.fn(async () => ({})),
    };
  });

  it("shows cloud projects, workflow hierarchy, runs, and cache state automatically", async () => {
    renderWorkspace();
    expect(await screen.findByText("Workspace Home")).toBeInTheDocument();
    expect(screen.getByText("Workspace Inspector")).toBeInTheDocument();
    expect(screen.getByText("workspace-a")).toBeInTheDocument();
    expect(screen.getAllByText("Cloud Only").length).toBeGreaterThan(0);
  });

  it("shows server datasets and runs even when the server has no project records", async () => {
    vi.mocked(window.neuroforgeDesktop!.syncWorkspace).mockResolvedValue({
      online: true,
      profile,
      snapshot: { ...snapshot, projects: [], workflows: [] },
    });
    renderWorkspace("datasets");
    expect(await screen.findByText("Dataset 1")).toBeInTheDocument();
    expect(screen.getByText("1 runs")).toBeInTheDocument();
  });

  it("downloads only the FreeView preset artifacts and launches from cache", async () => {
    renderWorkspace("runs");
    fireEvent.click(await screen.findByText("Run #7"));
    fireEvent.click(await screen.findByRole("button", { name: /Open in FreeView/ }));
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

  it("launches verified required artifacts offline without a network download", async () => {
    const offlineSnapshot: WorkspaceSnapshot = {
      ...snapshot,
      runs: snapshot.runs.map((run) => ({
        ...run,
        cacheState: "offline-cached",
        cachedArtifacts: [
          "sub-01/mri/orig_nu.mgz",
          "sub-01/mri/aseg.auto.mgz",
        ],
      })),
    };
    vi.mocked(window.neuroforgeDesktop!.syncWorkspace).mockResolvedValue({
      online: false,
      profile: { ...profile, connectionState: "offline" },
      snapshot: offlineSnapshot,
    });

    renderWorkspace("runs");
    fireEvent.click(await screen.findByText("Run #7"));
    const button = await screen.findByRole("button", { name: /Open in FreeView/ });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(window.neuroforgeDesktop!.launchViewer).toHaveBeenCalled());
    expect(window.neuroforgeDesktop!.syncWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  it("keeps duplicate numeric run IDs collision-free in All Workspaces metadata", () => {
    const local: LocalWorkspaceData = {
      projects: [], datasets: [], workflows: [], reports: [],
      runs: [{ id: 7, pipeline_manifest_id: "local-pipeline", status: "success" }],
    };
    const combined = combineWorkspaceRuns(local, "local-installation", snapshot);
    expect(combined.filter((run) => run.id === 7)).toEqual([
      expect.objectContaining({ key: "local-installation:run:7", workspace: "Local NeuroForge" }),
      expect.objectContaining({ key: "workspace-a:run:7", workspace: "AWS NeuroForge" }),
    ]);
    expect(new Set(combined.map((run) => run.key)).size).toBe(combined.length);
  });

  it("keeps cloud metadata visible when the local API fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
    renderWorkspace("runs");
    expect(await screen.findByText("Run #7")).toBeInTheDocument();
    expect(window.neuroforgeDesktop!.syncWorkspace).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("shows cached cloud metadata when synchronization reports the server offline", async () => {
    vi.mocked(window.neuroforgeDesktop!.syncWorkspace).mockResolvedValue({
      online: false,
      profile: { ...profile, connectionState: "offline" },
      snapshot: {
        ...snapshot,
        runs: snapshot.runs.map((run) => ({ ...run, cacheState: "offline-cached" })),
      },
    });
    renderWorkspace("runs");
    expect(await screen.findByText("Offline Cached")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });
});
