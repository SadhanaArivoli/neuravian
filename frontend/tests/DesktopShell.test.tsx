import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";

vi.mock("../src/hooks/usePipelines", () => ({
  usePipelines: () => ({ data: [{ id: "one" }], isLoading: false, isError: false }),
}));
vi.mock("../src/hooks/useHealth", () => ({
  useHealth: () => ({ isSuccess: true, isLoading: false }),
}));

const profile: WorkspaceProfile = {
  id: "aws", name: "AWS NeuroForge", serverUrl: "https://cloud.example",
  authenticationRef: "os-credential:aws", serverIdentity: "workspace-a",
  lastSync: "2026-07-18T00:00:00Z", connectionState: "connected",
};

const snapshot: WorkspaceSnapshot = {
  schemaVersion: 1,
  workspaceId: "workspace-a",
  profileId: "aws",
  serverUrl: "https://cloud.example",
  synchronizedAt: "2026-07-18T00:00:00Z",
  projects: [],
  datasets: [{ id: 1, remoteKey: "workspace-a:dataset:1", name: "Cloud Dataset" }],
  workflows: [],
  reports: [],
  runs: Array.from({ length: 7 }, (_, index) => ({
    id: index + 1,
    remoteKey: `workspace-a:run:${index + 1}`,
    dataset_id: 1,
    pipeline_manifest_id: index === 6 ? "fastsurfer" : "bids-validator",
    pipeline_version: "1",
    status: "success",
    created_at: "2026-07-18T00:00:00Z",
    cacheState: index === 6 ? "partially-cached" as const : "cloud-only" as const,
    cachedArtifacts: [],
    artifacts: [],
  })),
};

const navigationLabels = [
  "Home", "Projects", "Datasets", "Pipelines", "Runs", "Workflows", "Library",
  "DICOM Wizard", "Plugins", "Remote Hosts", "Workspace", "Settings",
];

function renderApp(path = "/") {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

describe("restored desktop shell", () => {
  beforeEach(() => {
    localStorage.clear();
    window.neuroforgeDesktop = {
      detectViewers: vi.fn(async () => []),
      getLocalWorkspaceIdentity: vi.fn(async () => ({
        schemaVersion: 1 as const, workspaceId: "local-installation", createdAt: "2026-07-18T00:00:00Z",
      })),
      listWorkspaces: vi.fn(async () => [profile]),
      saveWorkspace: vi.fn(),
      removeWorkspace: vi.fn(),
      testWorkspace: vi.fn(),
      inspectWorkspace: vi.fn(async () => ({
        cacheSizeBytes: 0, cachedRuns: 0, cacheEntries: 0, legacyCacheEntries: [], viewers: [],
      })),
      openWorkspaceRun: vi.fn(async () => true),
      syncWorkspace: vi.fn(async () => ({ online: true, profile, snapshot })),
      syncWorkspaceArtifacts: vi.fn(),
      syncAllRunArtifacts: vi.fn().mockResolvedValue({ runId: 0, downloaded: [], reused: [] }),
      launchLocalViewer: vi.fn(async () => true),
      launchViewer: vi.fn(async () => true),
      pushCloudProject: vi.fn(async () => ({})),
      pushCloudWorkflow: vi.fn(async () => ({})),
      browseForViewer: vi.fn(async () => null),
      saveViewerConfig: vi.fn(async () => true),
      readArtifact: vi.fn(async () => new Uint8Array()),
      duplicateWorkspace: vi.fn(async () => ({} as WorkspaceProfile)),
      exportWorkspace: vi.fn(async () => ({})),
      importWorkspace: vi.fn(async () => ({} as WorkspaceProfile)),
      resetWorkspaceCache: vi.fn(async () => true),
      clearWorkspaceCredentials: vi.fn(async () => true),
      resolveInstanceUrl: vi.fn(async () => null),
      pullToLocal: vi.fn(async () => ({})),
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/api/projects")) return Response.json([{ id: 1, title: "Local" }]);
      if (path.endsWith("/api/datasets")) return Response.json(Array.from({ length: 10 }, (_, index) => ({ id: index + 1 })));
      if (path.endsWith("/api/workflows")) return Response.json(Array.from({ length: 3 }, (_, index) => ({ id: index + 1 })));
      if (path.endsWith("/api/runs")) return Response.json(Array.from({ length: 109 }, (_, index) => ({ id: index + 1 })));
      if (/\/api\/datasets\/\d+\/reports$/.test(path)) return Response.json([{ id: Number(path.match(/\d+/)?.[0]) }]);
      if (path.endsWith("/api/health")) return Response.json({ status: "ok" });
      return Response.json([]);
    }));
  });

  it("renders Home at desktop root with the switcher and complete original navigation", async () => {
    renderApp();
    expect(await screen.findByText("Neuroimaging pipelines")).toBeInTheDocument();
    expect(screen.queryByText("Workspace Home")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Workspaces")).toBeInTheDocument();
    const navigation = screen.getByRole("navigation");
    for (const label of navigationLabels) {
      expect(within(navigation).getByRole("link", { name: label })).toBeInTheDocument();
    }
    await waitFor(() => {
      expect(screen.getByText("109 runs")).toBeInTheDocument();
      expect(screen.getByText("10 reports")).toBeInTheDocument();
    });
  });

  it("keeps Home and every navigation destination while switching Local, AWS, and All", async () => {
    renderApp();
    const switcher = await screen.findByLabelText("Workspaces");
    await waitFor(() => expect(screen.getByTestId("home-workspace-context")).toHaveTextContent("Local NeuroForge"));
    for (const value of ["cloud:aws", "all", "local"]) {
      fireEvent.change(switcher, { target: { value } });
      expect(screen.getByText("Neuroimaging pipelines")).toBeInTheDocument();
      const navigation = screen.getByRole("navigation");
      for (const label of navigationLabels) {
        expect(within(navigation).getByRole("link", { name: label })).toBeInTheDocument();
      }
    }
    fireEvent.change(switcher, { target: { value: "cloud:aws" } });
    await waitFor(() => expect(screen.getByTestId("home-workspace-context")).toHaveTextContent("AWS NeuroForge"));
    expect(await screen.findByText("7 runs")).toBeInTheDocument();
    fireEvent.change(switcher, { target: { value: "all" } });
    await waitFor(() => expect(screen.getByText("116 runs")).toBeInTheDocument());
    expect(screen.getByText("Aggregated metadata only")).toBeInTheDocument();
  });

  it("keeps the Workspace dashboard available at /workspaces", async () => {
    renderApp("/workspaces?scope=cloud%3Aaws");
    expect(await screen.findByText("Workspace Home")).toBeInTheDocument();
    expect(screen.getByText("workspace-a")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  });
});
