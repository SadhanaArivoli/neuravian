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
  saveWorkspace: (input: unknown) => ipcRenderer.invoke("workspaces:save", input),
  removeWorkspace: (profileId: string) => ipcRenderer.invoke("workspaces:remove", profileId),
  syncWorkspace: (profileId: string) => ipcRenderer.invoke("workspaces:sync", profileId),
  syncWorkspaceArtifacts: (input: unknown) => ipcRenderer.invoke("workspaces:sync-artifacts", input),
  syncRun: (runId: number) => ipcRenderer.invoke("runs:sync", runId),
  launchViewer: (request: unknown) => ipcRenderer.invoke("viewers:launch", request),
});

ipcRenderer.send("startup:trace", { stage: 3, name: "preload loaded" });
