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
  retry: () => ipcRenderer.invoke("startup:retry"),
  copyDiagnostics: () => ipcRenderer.invoke("diagnostics:copy"),
  openDockerInstall: () => ipcRenderer.invoke("docker:install"),
});
