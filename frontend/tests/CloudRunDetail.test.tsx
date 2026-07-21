import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CloudRunDetail } from "../src/components/domain/CloudRunDetail";

const profile: WorkspaceProfile = {
  id: "profile-1", name: "AWS EC2", serverUrl: "https://cloud.example",
  authenticationRef: "os-credential:profile-1", serverIdentity: "workspace-a",
  lastSync: "2026-07-19T00:00:00Z", connectionState: "connected",
};

const fastsurferArtifacts: WorkspaceRun["artifacts"] = [
  { artifactId: 1, relativePath: "sub-01/mri/orig_nu.mgz", url: "/one", sha256: "a", sizeBytes: 1 },
  { artifactId: 2, relativePath: "sub-01/mri/aseg.auto.mgz", url: "/two", sha256: "b", sizeBytes: 1 },
];

function makeRun(overrides: Partial<WorkspaceRun> = {}): WorkspaceRun {
  return {
    id: 7, remoteKey: "workspace-a:run:7", dataset_id: 1,
    pipeline_manifest_id: "fastsurfer", pipeline_version: "1",
    status: "success", created_at: "2026-07-19T00:00:00Z",
    cacheState: "cloud-only", cachedArtifacts: [], artifacts: fastsurferArtifacts,
    ...overrides,
  };
}

type ViewerDetection = WorkspaceInspection["viewers"][number];

const freeviewDetected: ViewerDetection = {
  viewerId: "freeview", displayName: "FreeView", installed: true,
  executable: "/Applications/Freeview.app/Contents/MacOS/freeview", reason: null,
};
const mricroglDetected: ViewerDetection = {
  viewerId: "mricrogl", displayName: "MRIcroGL", installed: true,
  executable: "/Applications/MRIcroGL.app/Contents/MacOS/MRIcroGL", reason: null,
};

const inspection = (viewers: ViewerDetection[]): WorkspaceInspection => ({
  cacheSizeBytes: 0, cachedRuns: 0, cacheEntries: 0, legacyCacheEntries: [], viewers,
});

function renderDetail(run: WorkspaceRun, insp: WorkspaceInspection, online = true) {
  return render(
    <MemoryRouter>
      <CloudRunDetail
        run={run}
        profile={profile}
        workspaceId="workspace-a"
        online={online}
        inspection={insp}
        onClose={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe("CloudRunDetail viewer priority", () => {
  beforeEach(() => {
    window.neuroforgeDesktop = {
      detectViewers: vi.fn(async () => []),
      getLocalWorkspaceIdentity: vi.fn(async () => ({ schemaVersion: 1 as const, workspaceId: "local", createdAt: "" })),
      listWorkspaces: vi.fn(async () => []),
      saveWorkspace: vi.fn(), removeWorkspace: vi.fn(), testWorkspace: vi.fn(),
      inspectWorkspace: vi.fn(async () => inspection([])),
      openWorkspaceRun: vi.fn(async () => true),
      syncWorkspace: vi.fn(),
      syncWorkspaceArtifacts: vi.fn(async () => ({ runId: 7, downloaded: [], reused: [] })),
      syncAllRunArtifacts: vi.fn().mockResolvedValue({ runId: 0, downloaded: [], reused: [] }),
      launchLocalViewer: vi.fn(async () => true),
      launchViewer: vi.fn(async () => true),
      viewerRuntimeBuild: "2026-07-19-viewer-contract-v1",
      assertDefaultViewerScene: vi.fn(async () => true),
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
      getEc2State: vi.fn(async () => null),
      replicateObjects: vi.fn(async () => ({ pushed: [], skipped: [], errors: [] })),
      shutdownFence: vi.fn(async () => ({ artifactsPulled: [], errors: [], fenceComplete: true })),
      launchPipeline: vi.fn(async () => ({ runId: 1, status: "queued", profileId: "p1" })),
      onCloudEvent: vi.fn(() => () => {}),
      setAutoStop: vi.fn(async () => ({} as WorkspaceProfile)),
      launchEnvironment: vi.fn(async () => ({ profile: { id: "p1", name: "Test", serverUrl: "https://test.example.com", authenticationRef: null, serverIdentity: null, lastSync: null, connectionState: "offline" as const, connectionMode: "url" as const }, workspaceId: null, elapsedMs: 1000 })),
      startEnvironment: vi.fn(async () => ({ started: true })),
      stopEnvironment: vi.fn(async () => ({ stopped: true, fenceResult: null })),
      loadSession: vi.fn(async () => ({ session: null, cachedSnapshot: null })),
      saveUiState: vi.fn(async () => ({ ok: true })),
      loadRunHistory: vi.fn(async () => ({ entries: [], totalCount: 0, hasMore: false })),
    };
  });

  it("picks NeuroForge Viewer as primary when FastSurfer artifacts are cached", () => {
    const run = makeRun({
      cacheState: "fully-cached",
      cachedArtifacts: ["sub-01/mri/orig_nu.mgz", "sub-01/mri/aseg.auto.mgz"],
    });
    renderDetail(run, inspection([freeviewDetected, mricroglDetected]));
    expect(screen.getByRole("button", { name: /Open in NeuroForge Viewer/ })).toBeInTheDocument();
    // Primary reasoning should mention NeuroForge Viewer
    expect(screen.getByText(/Primary action: Open in NeuroForge Viewer/)).toBeInTheDocument();
  });

  it("renders synchronized cloud progress instead of dropping it", () => {
    const run = makeRun({
      status: "running",
      started_at: "2026-07-19T00:01:00Z",
      progress: { percent: 21, current: 54, total: 256, eta_seconds: 203 },
    });
    renderDetail(run, inspection([]));
    expect(screen.getByText("Progress timeline")).toBeInTheDocument();
    expect(screen.getByText("21% complete")).toBeInTheDocument();
    expect(screen.getByText(/54 \/ 256 · ETA 4 min/)).toBeInTheDocument();
  });

  it("FreeView is accessible as secondary when NeuroForge Viewer is primary", () => {
    const run = makeRun({
      cacheState: "fully-cached",
      cachedArtifacts: ["sub-01/mri/orig_nu.mgz", "sub-01/mri/aseg.auto.mgz"],
    });
    renderDetail(run, inspection([freeviewDetected]));
    // Primary button should say NeuroForge Viewer
    expect(screen.getByRole("button", { name: /Open in NeuroForge Viewer/ })).toBeInTheDocument();
    // Secondary grid should also show FreeView as an option (not hidden)
    const freeviewButtons = screen.getAllByRole("button", { name: /FreeView/ });
    expect(freeviewButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("picks FreeView as primary when artifacts are cloud-only and FreeView is installed (online)", () => {
    const run = makeRun({ cacheState: "cloud-only", cachedArtifacts: [] });
    renderDetail(run, inspection([freeviewDetected]), true);
    expect(screen.getByRole("button", { name: /Open in FreeView/ })).toBeInTheDocument();
    expect(screen.getByText(/Primary action: Open in FreeView/)).toBeInTheDocument();
  });

  it("falls through to Cloud Browser when offline and artifacts are not cached", () => {
    const run = makeRun({ cacheState: "cloud-only", cachedArtifacts: [] });
    renderDetail(run, inspection([freeviewDetected]), false);
    expect(screen.getByRole("button", { name: /Open in Cloud Browser/ })).toBeInTheDocument();
    expect(screen.getByText(/Primary action: Open in Cloud Browser/)).toBeInTheDocument();
  });

  it("falls through to Cloud Browser for non-FastSurfer pipelines without compatible artifacts", () => {
    const run = makeRun({
      pipeline_manifest_id: "mriqc",
      cacheState: "fully-cached",
      cachedArtifacts: ["sub-01/mriqc_output.html"],
      artifacts: [{ artifactId: 1, relativePath: "sub-01/mriqc_output.html", url: "/r", sha256: "x", sizeBytes: 1 }],
    });
    renderDetail(run, inspection([freeviewDetected, mricroglDetected]));
    expect(screen.getByRole("button", { name: /Open in Cloud Browser/ })).toBeInTheDocument();
    expect(screen.getByText(/Primary action: Open in Cloud Browser/)).toBeInTheDocument();
  });

  it("MRIcroGL is secondary option and enabled when cached and installed", () => {
    const run = makeRun({
      cacheState: "fully-cached",
      cachedArtifacts: ["sub-01/mri/orig_nu.mgz", "sub-01/mri/aseg.auto.mgz"],
    });
    renderDetail(run, inspection([freeviewDetected, mricroglDetected]));
    const mricroglBtn = screen.getAllByRole("button").find(
      (btn) => btn.textContent?.includes("MRIcroGL"),
    );
    expect(mricroglBtn).toBeDefined();
  });

  it("shows Locate MRIcroGL button when MRIcroGL is not installed", () => {
    const run = makeRun({
      cacheState: "fully-cached",
      cachedArtifacts: ["sub-01/mri/orig_nu.mgz", "sub-01/mri/aseg.auto.mgz"],
    });
    renderDetail(run, inspection([freeviewDetected]));
    expect(screen.getByRole("button", { name: /Locate MRIcroGL/ })).toBeInTheDocument();
  });

  it("does not show Locate MRIcroGL when MRIcroGL is installed", () => {
    const run = makeRun({
      cacheState: "fully-cached",
      cachedArtifacts: ["sub-01/mri/orig_nu.mgz", "sub-01/mri/aseg.auto.mgz"],
    });
    renderDetail(run, inspection([mricroglDetected]));
    expect(screen.queryByRole("button", { name: /Locate MRIcroGL/ })).not.toBeInTheDocument();
  });

  it("enables local viewers for a cached pydeface NIfTI", () => {
    const run = makeRun({
      pipeline_manifest_id: "pydeface",
      cacheState: "fully-cached",
      cachedArtifacts: ["defaced.nii.gz"],
      artifacts: [{ artifactId: 1, relativePath: "defaced.nii.gz", url: "/defaced", sha256: "x", sizeBytes: 1 }],
    });
    renderDetail(run, inspection([freeviewDetected, mricroglDetected]));
    expect(screen.getByRole("button", { name: /Open in NeuroForge Viewer/ })).toBeInTheDocument();
  });

  it("shows synchronized fMRIPrep reports and local viewer actions", () => {
    const run = makeRun({
      pipeline_manifest_id: "fmriprep",
      cacheState: "fully-cached",
      reports: [{ name: "sub-01", path: "sub-01.html" }],
      cachedArtifacts: ["sub-01.html", "sub-01/anat/sub-01_desc-preproc_T1w.nii.gz"],
      artifacts: [
        { artifactId: 1, relativePath: "sub-01.html", url: "/report", sha256: "r", sizeBytes: 1 },
        { artifactId: 2, relativePath: "sub-01/anat/sub-01_desc-preproc_T1w.nii.gz", url: "/volume", sha256: "v", sizeBytes: 1 },
      ],
    });
    renderDetail(run, inspection([freeviewDetected, mricroglDetected]));
    expect(screen.getByRole("button", { name: /Open in NeuroForge Viewer/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "reports" }));
    expect(screen.getByRole("button", { name: "Open sub-01" })).toBeInTheDocument();
  });
});
