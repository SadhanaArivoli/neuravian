import { contextBridge, ipcRenderer } from "electron";
import type { StartupUpdate } from "../main/types.js";
import type {
  DefaultViewerSceneRequest,
  ReadArtifactRequest,
  ViewerRendererApi,
} from "./viewer-api-contract.js";

// Sandboxed Electron preloads cannot require sibling files in packaged asar
// builds. Keep this preload runtime self-contained; the types remain shared.
const VIEWER_RUNTIME_BUILD = "2026-07-19-viewer-contract-v1";
const VIEWER_CHANNELS = {
  readArtifact: "viewers:read-artifact",
  assertDefaultScene: "viewers:assert-default-scene",
} as const;

const viewerApi: ViewerRendererApi = {
  viewerRuntimeBuild: VIEWER_RUNTIME_BUILD,
  readArtifact: (input: ReadArtifactRequest) => ipcRenderer.invoke(VIEWER_CHANNELS.readArtifact, input),
  assertDefaultViewerScene: (input: DefaultViewerSceneRequest) =>
    ipcRenderer.invoke(VIEWER_CHANNELS.assertDefaultScene, input),
};

contextBridge.exposeInMainWorld("neuravianDesktop", {
  ...viewerApi,
  platform: process.platform,
  architecture: process.arch,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  onStartupUpdate: (callback: (update: StartupUpdate) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: StartupUpdate): void => callback(update);
    ipcRenderer.on("startup:update", listener);
    return () => ipcRenderer.removeListener("startup:update", listener);
  },
  getStartupState: () => ipcRenderer.invoke("startup:get-state"),
  reportStartupStateReceived: (update: StartupUpdate) => ipcRenderer.invoke("startup:renderer-received", update),
  retry: () => ipcRenderer.invoke("startup:retry"),
  copyDiagnostics: () => ipcRenderer.invoke("diagnostics:copy"),
  openLogs: () => ipcRenderer.invoke("logs:open"),
  openInBrowser: () => ipcRenderer.invoke("frontend:open-browser"),
  openDockerDesktop: () => ipcRenderer.invoke("docker:open-desktop"),
  openDockerInstall: () => ipcRenderer.invoke("docker:install"),
  detectViewers: (configured?: Record<string, string>) => ipcRenderer.invoke("viewers:detect", configured),
  listWorkspaces: () => ipcRenderer.invoke("workspaces:list"),
  getLocalWorkspaceIdentity: () => ipcRenderer.invoke("workspaces:local-identity"),
  saveWorkspace: (input: unknown) => ipcRenderer.invoke("workspaces:save", input),
  removeWorkspace: (profileId: string) => ipcRenderer.invoke("workspaces:remove", profileId),
  duplicateWorkspace: (profileId: string) => ipcRenderer.invoke("workspaces:duplicate", profileId),
  exportWorkspace: (profileId: string) => ipcRenderer.invoke("workspaces:export", profileId),
  importWorkspace: (input: unknown) => ipcRenderer.invoke("workspaces:import", input),
  resetWorkspaceCache: (workspaceId: string) => ipcRenderer.invoke("workspaces:reset-cache", workspaceId),
  clearWorkspaceCredentials: (profileId: string) => ipcRenderer.invoke("workspaces:clear-credentials", profileId),
  resolveInstanceUrl: (profileId: string) => ipcRenderer.invoke("workspaces:resolve-instance-url", profileId),
  getEc2State: (profileId: string) => ipcRenderer.invoke("workspaces:get-ec2-state", profileId),
  pullToLocal: (input: unknown) => ipcRenderer.invoke("workspaces:pull-to-local", input),
  syncWorkspace: (profileId: string) => ipcRenderer.invoke("workspaces:sync", profileId),
  testWorkspace: (profileId: string) => ipcRenderer.invoke("workspaces:test", profileId),
  inspectWorkspace: (input: unknown) => ipcRenderer.invoke("workspaces:inspect", input),
  openWorkspaceRun: (input: unknown) => ipcRenderer.invoke("workspaces:open-run", input),
  syncWorkspaceArtifacts: (input: unknown) => ipcRenderer.invoke("workspaces:sync-artifacts", input),
  syncAllRunArtifacts: (input: unknown) => ipcRenderer.invoke("workspaces:sync-all-run-artifacts", input),
  syncWorkflowInputs: (input: unknown) => ipcRenderer.invoke("workspaces:sync-workflow-inputs", input),
  prepareWorkflowHandoff: (input: unknown) => ipcRenderer.invoke("workspaces:prepare-workflow-handoff", input),
  updateWorkflowExecution: (input: unknown) => ipcRenderer.invoke("workspaces:update-workflow-execution", input),
  launchLocalViewer: (request: unknown) => ipcRenderer.invoke("viewers:launch-local", request),
  launchViewer: (request: unknown) => ipcRenderer.invoke("viewers:launch", request),
  browseForViewer: (viewerId: string) => ipcRenderer.invoke("viewers:browse-for-executable", viewerId),
  getDatasetsRoot: () => ipcRenderer.invoke("datasets:get-root") as Promise<string>,
  chooseDatasetsRoot: () => ipcRenderer.invoke("datasets:choose-root") as Promise<string | null>,
  browseForDatasetFolder: () => ipcRenderer.invoke("datasets:browse-for-folder") as Promise<{
    datasetPath: string; rootChanged: boolean; requiresRestart: boolean; datasetsRoot?: string;
  } | null>,
  saveViewerConfig: (input: { viewerId: string; executablePath: string | null }) => ipcRenderer.invoke("viewers:save-configured", input),
  pushCloudProject: (input: unknown) => ipcRenderer.invoke("workspaces:push-project", input),
  pushCloudWorkflow: (input: unknown) => ipcRenderer.invoke("workspaces:push-workflow", input),
  replicateObjects: (input: unknown) => ipcRenderer.invoke("workspaces:replicate-objects", input),
  shutdownFence: (input: unknown) => ipcRenderer.invoke("workspaces:shutdown-fence", input),
  launchEnvironment: (input: unknown) => ipcRenderer.invoke("workspaces:launch-environment", input),
  launchPipeline: (input: unknown) => ipcRenderer.invoke("workspaces:launch-pipeline", input),
  onCloudEvent: (callback: (event: Record<string, unknown>) => void) => {
    const listener = (_ipcEvent: Electron.IpcRendererEvent, event: Record<string, unknown>) => callback(event);
    ipcRenderer.on("cloud:event", listener);
    return () => ipcRenderer.removeListener("cloud:event", listener);
  },
  setAutoStop: (input: unknown) => ipcRenderer.invoke("workspaces:set-auto-stop", input),
  startEnvironment: (profileId: string) => ipcRenderer.invoke("workspaces:start-environment", profileId),
  stopEnvironment: (input: unknown) => ipcRenderer.invoke("workspaces:stop-environment", input),
  loadSession: (profileId: string) => ipcRenderer.invoke("workspaces:load-session", profileId),
  saveUiState: (input: { profileId: string; uiState: unknown }) => ipcRenderer.invoke("workspaces:save-ui-state", input),
  loadRunHistory: (input: unknown) => ipcRenderer.invoke("workspaces:run-history", input),
});

ipcRenderer.send("startup:trace", { stage: 3, name: "preload loaded" });
