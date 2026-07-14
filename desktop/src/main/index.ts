import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { queryActiveRuns } from "./activity.js";
import { DesktopCompose } from "./compose.js";
import { formatDiagnostics } from "./diagnostics.js";
import { FRONTEND_URL } from "./health.js";
import { isInternalUrl, shouldOpenExternally } from "./navigation.js";
import { findRepositoryRoot } from "./paths.js";
import { DOCKER_INSTALL_URL, StartupController } from "./startup.js";
import type { StartupUpdate } from "./types.js";
import { loadWindowBounds, saveWindowBounds } from "./window-state.js";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";

let mainWindow: BrowserWindow | null = null;
let startup: StartupController | null = null;
let compose: DesktopCompose | null = null;
let repositoryRoot = "";
let allowQuit = false;
let quitInProgress = false;
let applicationLoaded = false;
let lastUpdate: StartupUpdate = { state: "checking-system", title: "Checking system", detail: "Preparing the desktop launcher." };
const capturePath = process.env.NEUROFORGE_CAPTURE_PATH;
const captureState = process.env.NEUROFORGE_CAPTURE_STATE;

function showMessage(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

function assetPath(fileName: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "assets", fileName)
    : path.join(__dirname, "../../assets", fileName);
}

function diagnosticsText(): string {
  return formatDiagnostics({ update: lastUpdate, facts: startup?.facts, error: startup?.lastError });
}

function publish(update: StartupUpdate): void {
  lastUpdate = update;
  mainWindow?.webContents.send("startup:update", update);
  installMenu();
  if (update.state === "ready" && !applicationLoaded && mainWindow) {
    applicationLoaded = true;
    void mainWindow.loadURL(FRONTEND_URL);
  }
  if (capturePath && captureState === update.state) {
    setTimeout(() => { void captureWindow(capturePath); }, update.state === "checking-system" ? 100 : 800);
  }
}

async function captureWindow(target: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const image = await mainWindow.webContents.capturePage();
  await writeFile(target, image.toPNG());
}

async function openFolder(relative: string): Promise<void> {
  const target = path.join(repositoryRoot, relative);
  const error = await shell.openPath(target);
  if (error) await dialog.showMessageBox({ type: "error", title: "Could not open folder", message: error });
}

async function confirmNoActiveRun(action: string): Promise<boolean> {
  try {
    const activity = await queryActiveRuns();
    if (!activity.active) return true;
    await showMessage({
      type: "warning",
      title: "Scientific run active",
      message: `NeuroForge cannot ${action} while a scientific run is active.`,
      detail: `Active or queued run IDs: ${activity.runIds.join(", ")}. Return to NeuroForge and let the run finish.`,
      buttons: ["Return to NeuroForge"],
    });
    mainWindow?.show();
    return false;
  } catch (error) {
    await showMessage({
      type: "warning",
      title: "Run status unavailable",
      message: `NeuroForge did not ${action} because it could not verify that pipeline execution is idle.`,
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["Return to NeuroForge"],
    });
    return false;
  }
}

async function stopServices(): Promise<void> {
  if (!compose?.ownsServices || !(await confirmNoActiveRun("stop services"))) return;
  publish({ state: "shutting-down", title: "Shutting down", detail: "Stopping desktop-owned services without removing volumes or files." });
  await compose.stop();
  applicationLoaded = false;
  await mainWindow?.loadFile(path.join(__dirname, "../renderer/index.html"));
  publish({ state: "failed", title: "Services stopped", detail: "NeuroForge services are stopped. Select Retry to start them again.", recoverable: true });
}

async function restartServices(): Promise<void> {
  if (compose?.ownsServices && !(await confirmNoActiveRun("restart services"))) return;
  if (compose?.ownsServices) await compose.stop();
  applicationLoaded = false;
  await mainWindow?.loadFile(path.join(__dirname, "../renderer/index.html"));
  void startup?.run();
}

async function showAbout(): Promise<void> {
  let detail = "Thin local desktop launcher for the existing NeuroForge application.";
  try {
    const response = await fetch("http://127.0.0.1:8000/api/about", { signal: AbortSignal.timeout(4_000) });
    if (response.ok) {
      const about = await response.json() as { version?: string; backend_version?: string; git_commit?: string; license?: string };
      detail = `Version ${about.version ?? app.getVersion()}\nBackend ${about.backend_version ?? "unknown"}\nCommit ${about.git_commit ?? "unknown"}\n${about.license ?? "Apache 2.0"}`;
    }
  } catch { /* The launcher remains identifiable if services are stopped. */ }
  await showMessage({ title: "About NeuroForge", message: "NeuroForge", detail, icon: assetPath("neuroforge-logo.png") });
}

function installMenu(): void {
  const statusLabel = lastUpdate.title;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "NeuroForge",
      submenu: [
        { label: "About NeuroForge", click: () => { void showAbout(); } },
        { type: "separator" },
        { label: `NeuroForge: ${statusLabel}`, enabled: false },
        { label: `Docker services: ${compose?.ownsServices ? "desktop-owned" : "not owned"}`, enabled: false },
        { type: "separator" },
        { label: "Open Data Folder", click: () => { void openFolder("data"); } },
        { label: "Open Derivatives Folder", click: () => { void openFolder("data/derivatives"); } },
        { label: "Open Logs", click: () => { void openFolder("data/logs"); } },
        { type: "separator" },
        { label: "Copy Diagnostics", click: () => clipboard.writeText(diagnosticsText()) },
        { label: "Restart Services", click: () => { void restartServices(); } },
        { label: "Stop Services", click: () => { void stopServices(); } },
        { type: "separator" },
        { label: "Quit NeuroForge", accelerator: "Command+Q", click: () => { void requestQuit(); } },
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]), { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
  ]));
}

async function requestQuit(): Promise<void> {
  if (allowQuit || quitInProgress) return;
  quitInProgress = true;
  try {
    if (!compose?.ownsServices) {
      allowQuit = true;
      app.quit();
      return;
    }
    let activity;
    try { activity = await queryActiveRuns(); }
    catch (error) {
      await showMessage({
        type: "warning", title: "Run status unavailable",
        message: "NeuroForge will remain open because active-run status could not be verified.",
        detail: error instanceof Error ? error.message : String(error), buttons: ["Return to NeuroForge"],
      });
      return;
    }
    if (activity.active) {
      const result = await showMessage({
        type: "warning", title: "Scientific run active",
        message: "A scientific run is active. NeuroForge will not stop its services by default.",
        detail: `Active or queued run IDs: ${activity.runIds.join(", ")}`,
        buttons: ["Cancel", "Leave NeuroForge services running", "Return to NeuroForge"],
        defaultId: 0, cancelId: 0,
      });
      if (result.response !== 1) { mainWindow?.show(); return; }
      allowQuit = true;
      app.quit();
      return;
    }
    publish({ state: "shutting-down", title: "Shutting down", detail: "Stopping desktop-owned services without removing volumes or files." });
    await compose.stop();
    allowQuit = true;
    app.quit();
  } finally {
    quitInProgress = false;
  }
}

async function createWindow(): Promise<void> {
  const stateFile = path.join(app.getPath("userData"), "window-state.json");
  const bounds = await loadWindowBounds(stateFile);
  mainWindow = new BrowserWindow({
    title: "NeuroForge", ...bounds, minWidth: 1024, minHeight: 700, show: false,
    backgroundColor: "#090d18", icon: assetPath("neuroforge-logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, devTools: !app.isPackaged,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (!allowQuit) { event.preventDefault(); void requestQuit(); }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.on("resize", () => { if (mainWindow && !mainWindow.isMaximized()) void saveWindowBounds(stateFile, mainWindow.getBounds()); });
  mainWindow.on("move", () => { if (mainWindow && !mainWindow.isMaximized()) void saveWindowBounds(stateFile, mainWindow.getBounds()); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      if (shouldOpenExternally(url)) void shell.openExternal(url);
    }
  });
  await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  publish(lastUpdate);
  repositoryRoot = findRepositoryRoot(__dirname);
  compose = new DesktopCompose(repositoryRoot);
  startup = new StartupController(repositoryRoot, compose, publish);
  void startup.run();
}

ipcMain.handle("startup:retry", async () => {
  if (compose?.ownsServices) { await restartServices(); return true; }
  return await startup?.run();
});
ipcMain.handle("diagnostics:copy", () => { clipboard.writeText(diagnosticsText()); return true; });
ipcMain.handle("docker:install", async () => { await shell.openExternal(DOCKER_INSTALL_URL); return true; });

app.whenReady().then(() => {
  installMenu();
  void createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});
app.on("before-quit", (event) => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
