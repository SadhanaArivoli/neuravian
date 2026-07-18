import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
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
import { DesktopLogger, type StartupTrace } from "./logger.js";
import { StartupStateStore } from "./state-store.js";
import { STARTUP_TIMEOUTS, withTimeout } from "./timeouts.js";
import { syncRun, type SyncManifest } from "./run-cache.js";
import {
  commandForPreset, detectViewer, launchViewer, validateVolumeGeometry,
  type DesktopPlatform, type ExternalViewerId, type ViewerLaunchRequest,
} from "./viewer-manager.js";

let mainWindow: BrowserWindow | null = null;
let startup: StartupController | null = null;
let compose: DesktopCompose | null = null;
let repositoryRoot = "";
let allowQuit = false;
let quitInProgress = false;
let applicationLoaded = false;
let applicationLoadStarted = false;
let logger: DesktopLogger | null = null;
let rendererReadyTimer: NodeJS.Timeout | undefined;
const startupState = new StartupStateStore({ state: "checking-system", title: "Checking system", detail: "Preparing the desktop launcher.", stage: "Electron app ready", elapsedMs: 0 });
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
  return formatDiagnostics({ update: startupState.get(), facts: startup?.facts, error: startup?.lastError });
}

function publish(update: StartupUpdate): void {
  startupState.set(update);
  mainWindow?.webContents.send("startup:update", update);
  installMenu();
  if (update.state === "ready") {
    if (rendererReadyTimer) clearTimeout(rendererReadyTimer);
    rendererReadyTimer = setTimeout(() => {
      if (!applicationLoadStarted) {
        publish({
          state: "failed", title: "Startup failed",
          detail: "The startup shell did not acknowledge the Ready state before the renderer timeout.",
          stage: "renderer ready acknowledgement", elapsedMs: STARTUP_TIMEOUTS.rendererLoadMs,
          recoverable: true, browserAvailable: true,
        });
      }
    }, STARTUP_TIMEOUTS.rendererLoadMs);
  }
  if (capturePath && captureState === update.state) {
    setTimeout(() => { void captureWindow(capturePath); }, update.state === "checking-system" ? 100 : 4_000);
  }
}

function trace(event: StartupTrace): void {
  void logger?.trace(event);
}

async function loadMainApplication(): Promise<void> {
  if (!mainWindow || applicationLoaded || applicationLoadStarted) return;
  applicationLoadStarted = true;
  if (rendererReadyTimer) clearTimeout(rendererReadyTimer);
  const attemptId = startupState.get().attemptId;
  const startedAt = Date.now();
  try {
    await withTimeout(mainWindow.loadURL(FRONTEND_URL), "Renderer load", STARTUP_TIMEOUTS.rendererLoadMs);
    applicationLoaded = true;
    trace({ attemptId, stage: 19, name: "app URL loaded into main window", detail: FRONTEND_URL, elapsedMs: Date.now() - startedAt });
    trace({ attemptId, stage: 20, name: "startup shell removed", elapsedMs: Date.now() - startedAt });
    const visible = await mainWindow.webContents.executeJavaScript("Boolean(document.body && document.body.innerText.includes('NeuroForge'))", true).catch(() => false) as boolean;
    if (!visible) throw new Error("The NeuroForge document loaded but its main UI was not visible.");
    trace({ attemptId, stage: 21, name: "main NeuroForge UI visible", elapsedMs: Date.now() - startedAt });
  } catch (error) {
    applicationLoadStarted = false;
    applicationLoaded = false;
    await mainWindow.loadFile(path.join(__dirname, "../renderer/index.html")).catch(() => undefined);
    publish({
      state: "failed", title: "Startup failed",
      detail: error instanceof Error ? error.message : String(error),
      stage: "main application load", elapsedMs: Date.now() - startedAt,
      recoverable: true, browserAvailable: true,
    });
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

async function openDesktopLogs(): Promise<void> {
  const error = await shell.openPath(logger?.directory ?? app.getPath("logs"));
  if (error) await dialog.showMessageBox({ type: "error", title: "Could not open logs", message: error });
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
  applicationLoadStarted = false;
  await mainWindow?.loadFile(path.join(__dirname, "../renderer/index.html"));
  publish({ state: "failed", title: "Services stopped", detail: "NeuroForge services are stopped. Select Retry to start them again.", recoverable: true });
}

async function restartServices(): Promise<void> {
  if (compose?.ownsServices && !(await confirmNoActiveRun("restart services"))) return;
  if (compose?.ownsServices) await compose.stop();
  applicationLoaded = false;
  applicationLoadStarted = false;
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
  const statusLabel = startupState.get().title;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "NeuroForge",
      submenu: [
        { label: "About NeuroForge", click: () => { void showAbout(); } },
        { type: "separator" },
        { label: `NeuroForge: ${statusLabel}`, enabled: false },
        { label: `Docker services: ${compose?.serviceOwnership ?? "none"}`, enabled: false },
        { type: "separator" },
        { label: "Open Data Folder", click: () => { void openFolder("data"); } },
        { label: "Open Derivatives Folder", click: () => { void openFolder("data/derivatives"); } },
        { label: "Open Logs", click: () => { void openDesktopLogs(); } },
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
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); return; }
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
  trace({ stage: 2, name: "BrowserWindow created", detail: `${bounds.width}x${bounds.height}` });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) trace({ stage: "renderer-console", name: level >= 3 ? "renderer error" : "renderer warning", detail: `${message} (${sourceId}:${line})` });
  });
  mainWindow.webContents.on("did-finish-load", () => {
    const url = mainWindow?.webContents.getURL() ?? "";
    if (url.startsWith("file:")) {
      trace({ attemptId: startupState.get().attemptId, stage: 4, name: "renderer startup shell loaded", detail: url });
      mainWindow?.webContents.send("startup:update", startupState.get());
    }
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
  publish(startupState.get());
  repositoryRoot = findRepositoryRoot(__dirname);
  compose = new DesktopCompose(repositoryRoot);
  startup = new StartupController(
    repositoryRoot,
    compose,
    publish,
    (stage, name, detail, attemptId, elapsedMs) => trace({ stage, name, detail, attemptId, elapsedMs }),
  );
  void startup.run();
}

ipcMain.handle("startup:retry", async () => {
  if (compose?.ownsServices) { await restartServices(); return true; }
  return await startup?.retry();
});
ipcMain.handle("startup:get-state", () => startupState.get());
ipcMain.handle("startup:renderer-received", async (_event, update: StartupUpdate) => {
  const current = startupState.get();
  if (update.attemptId && current.attemptId && update.attemptId !== current.attemptId) return false;
  if (update.state === "ready") {
    trace({ attemptId: current.attemptId, stage: 18, name: "ready event received by renderer", elapsedMs: current.elapsedMs });
    await loadMainApplication();
  }
  return true;
});
ipcMain.on("startup:trace", (_event, event: StartupTrace) => {
  if (event.stage === 3 && applicationLoadStarted) return;
  trace({ ...event, attemptId: startupState.get().attemptId });
});
ipcMain.handle("diagnostics:copy", () => { clipboard.writeText(diagnosticsText()); return true; });
ipcMain.handle("logs:open", async () => { await openDesktopLogs(); return true; });
ipcMain.handle("frontend:open-browser", async () => { await shell.openExternal(FRONTEND_URL); return true; });
ipcMain.handle("docker:open-desktop", async () => await shell.openPath("/Applications/Docker.app"));
ipcMain.handle("docker:install", async () => { await shell.openExternal(DOCKER_INSTALL_URL); return true; });
ipcMain.handle("viewers:detect", async (_event, configured: Partial<Record<ExternalViewerId, string>> = {}) => {
  if (!["darwin", "win32", "linux"].includes(process.platform)) return [];
  const platform = process.platform as DesktopPlatform;
  return await Promise.all((["freeview", "mricrogl"] as const).map(
    (viewerId) => detectViewer(viewerId, platform, configured[viewerId]),
  ));
});
ipcMain.handle("runs:sync", async (_event, runId: number) => {
  if (!Number.isInteger(runId) || runId < 1) throw new Error("A valid run ID is required.");
  const response = await fetch(`http://127.0.0.1:8000/api/runs/${runId}/sync-manifest`);
  if (!response.ok) throw new Error(`Run synchronization manifest failed with HTTP ${response.status}.`);
  const manifest = await response.json() as SyncManifest;
  manifest.artifacts = manifest.artifacts.map((artifact) => ({
    ...artifact,
    url: new URL(artifact.url, "http://127.0.0.1:8000").toString(),
  }));
  return await syncRun(path.join(app.getPath("userData"), "run-cache"), manifest);
});
ipcMain.handle("viewers:launch", async (_event, request: ViewerLaunchRequest) => {
  if (!["darwin", "win32", "linux"].includes(process.platform)) throw new Error("External viewers are unavailable on this platform.");
  const detection = await detectViewer(request.viewerId, process.platform as DesktopPlatform);
  if (!detection.installed || !detection.executable) throw new Error(detection.reason ?? "Viewer is not installed.");
  const cacheRoot = path.join(app.getPath("userData"), "run-cache");
  const metadata = JSON.parse(await readFile(
    path.join(cacheRoot, `run-${request.runId}`, "run-metadata.json"), "utf8",
  )) as { artifacts: Array<{ relativePath: string; geometry?: unknown }> };
  validateVolumeGeometry(request.files.map((file) => file.relativePath), metadata.artifacts);
  const command = commandForPreset(request, detection.executable, cacheRoot);
  await launchViewer(command, cacheRoot);
  return true;
});

app.whenReady().then(async () => {
  app.setAppLogsPath();
  logger = await DesktopLogger.create(app.getPath("logs"));
  trace({ stage: 1, name: "Electron app ready", detail: `version=${app.getVersion()} architecture=${process.arch}` });
  installMenu();
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});
app.on("before-quit", (event) => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
