import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
import path from "node:path";
import { DesktopCompose } from "./compose.js";
import { formatDiagnostics } from "./diagnostics.js";
import { findRepositoryRoot } from "./paths.js";
import { DOCKER_INSTALL_URL, StartupController } from "./startup.js";
import type { StartupUpdate } from "./types.js";

let mainWindow: BrowserWindow | null = null;
let startup: StartupController | null = null;
let lastUpdate: StartupUpdate = { state: "checking-system", title: "Checking system", detail: "Preparing the desktop launcher." };

function assetPath(fileName: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "assets", fileName)
    : path.join(__dirname, "../../assets", fileName);
}

function publish(update: StartupUpdate): void {
  lastUpdate = update;
  mainWindow?.webContents.send("startup:update", update);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: "NeuroForge",
    width: 1180,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#090d18",
    icon: assetPath("neuroforge-logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  mainWindow.webContents.once("did-finish-load", () => {
    publish(lastUpdate);
    const repositoryRoot = findRepositoryRoot(__dirname);
    const compose = new DesktopCompose(repositoryRoot);
    startup = new StartupController(repositoryRoot, compose, publish);
    void startup.run();
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

ipcMain.handle("startup:retry", async () => await startup?.run());
ipcMain.handle("diagnostics:copy", () => {
  const diagnostics = formatDiagnostics({ update: lastUpdate, facts: startup?.facts, error: startup?.lastError });
  clipboard.writeText(diagnostics);
  return true;
});
ipcMain.handle("docker:install", async () => {
  await shell.openExternal(DOCKER_INSTALL_URL);
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
