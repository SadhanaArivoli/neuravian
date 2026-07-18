import { contextBridge, ipcRenderer } from "electron";
import type { StartupUpdate } from "../main/types.js";

contextBridge.exposeInMainWorld("neuroforgeDesktop", {
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
  syncWorkspace: (profileId: string) => ipcRenderer.invoke("workspaces:sync", profileId),
  testWorkspace: (profileId: string) => ipcRenderer.invoke("workspaces:test", profileId),
  inspectWorkspace: (input: unknown) => ipcRenderer.invoke("workspaces:inspect", input),
  openWorkspaceRun: (input: unknown) => ipcRenderer.invoke("workspaces:open-run", input),
  syncWorkspaceArtifacts: (input: unknown) => ipcRenderer.invoke("workspaces:sync-artifacts", input),
  syncAllRunArtifacts: (input: unknown) => ipcRenderer.invoke("workspaces:sync-all-run-artifacts", input),
  launchLocalViewer: (request: unknown) => ipcRenderer.invoke("viewers:launch-local", request),
  launchViewer: (request: unknown) => ipcRenderer.invoke("viewers:launch", request),
  pushCloudProject: (input: unknown) => ipcRenderer.invoke("workspaces:push-project", input),
  pushCloudWorkflow: (input: unknown) => ipcRenderer.invoke("workspaces:push-workflow", input),
});

ipcRenderer.send("startup:trace", { stage: 3, name: "preload loaded" });
