import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("neuroforgeDesktop", {
  platform: process.platform,
  architecture: process.arch,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
