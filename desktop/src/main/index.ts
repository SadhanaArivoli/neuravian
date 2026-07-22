import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell } from "electron";
import {
  VIEWER_CHANNELS,
  type DefaultViewerSceneRequest,
  type ReadArtifactRequest,
} from "../preload/viewer-api-contract.js";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// ── viewer settings helpers ────────────────────────────────────────────────────

interface ViewerSettings { configured: Partial<Record<string, string>> }

async function loadViewerSettings(userData: string): Promise<Partial<Record<string, string>>> {
  try {
    const raw = JSON.parse(await readFile(path.join(userData, "viewer-settings.json"), "utf-8")) as ViewerSettings;
    return raw.configured ?? {};
  } catch { return {}; }
}

async function saveViewerSetting(userData: string, viewerId: string, executablePath: string | null): Promise<void> {
  const file = path.join(userData, "viewer-settings.json");
  let current: ViewerSettings = { configured: {} };
  try { current = JSON.parse(await readFile(file, "utf-8")) as ViewerSettings; } catch { /* first write */ }
  if (executablePath === null) {
    delete current.configured[viewerId];
  } else {
    current.configured[viewerId] = executablePath;
  }
  await writeFile(file, JSON.stringify(current, null, 2));
}

import { queryActiveRuns } from "./activity.js";
import { DesktopCompose } from "./compose.js";
import { formatDiagnostics } from "./diagnostics.js";
import { FRONTEND_URL } from "./health.js";
import { isInternalUrl, shouldOpenExternally } from "./navigation.js";
import { resolveRuntimePaths } from "./paths.js";
import { DOCKER_INSTALL_URL, StartupController } from "./startup.js";
import type { StartupUpdate } from "./types.js";
import { loadWindowBounds, saveWindowBounds } from "./window-state.js";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import { DesktopLogger, type StartupTrace } from "./logger.js";
import { StartupStateStore } from "./state-store.js";
import { STARTUP_TIMEOUTS, withTimeout } from "./timeouts.js";
import { detectLegacyRunCaches, type SyncManifest } from "./run-cache.js";
import {
  commandForLocalPreset, commandForPreset, detectViewer, launchViewer, validateVolumeGeometry,
  type DesktopPlatform, type ExternalViewerId, type LocalViewerLaunchRequest, type ViewerLaunchRequest,
} from "./viewer-manager.js";
import { ConnectionProfileStore, CredentialDecryptionError } from "./connection-profiles.js";
import { WorkspaceMetadataCache } from "./workspace-cache.js";
import { WorkspaceClient, resolveEc2State, startEc2Instance, stopEc2Instance } from "./workspace-client.js";
import { WorkspaceReplicationEngine } from "./workspace-replication.js";
import { ExecutionEnvironmentManager } from "./environment-manager.js";
import { startCloudStream, stopCloudStream, stopAllCloudStreams } from "./cloud-event-stream.js";
import type { WorkspaceProfile } from "./workspace-types.js";
import { WorkspaceSessionStore } from "./workspace-session-store.js";
import { RunHistoryStore } from "./workspace-run-history.js";
import type { SessionRunHistoryEntry } from "./workspace-types.js";
import { LocalWorkspaceStore } from "./local-workspace.js";
import { configureUserDataCompatibility } from "./user-data-compatibility.js";
import { rmdir, rm } from "node:fs/promises";

let mainWindow: BrowserWindow | null = null;
let startup: StartupController | null = null;
let compose: DesktopCompose | null = null;
let runtimeResourcesRoot = "";
let runtimeDataDir = "";
let allowQuit = false;
let quitInProgress = false;
let applicationLoaded = false;
let applicationLoadStarted = false;
let logger: DesktopLogger | null = null;
let rendererReadyTimer: NodeJS.Timeout | undefined;
let profileStore: ConnectionProfileStore | null = null;
let workspaceClient: WorkspaceClient | null = null;
let workspaceWre: WorkspaceReplicationEngine | null = null;
let workspaceEnvManager: ExecutionEnvironmentManager | null = null;
let workspaceSessionStore: WorkspaceSessionStore | null = null;
let workspaceRunHistoryStore: RunHistoryStore | null = null;
let localWorkspaceStore: LocalWorkspaceStore | null = null;
const startupState = new StartupStateStore({ state: "checking-system", title: "Checking system", detail: "Preparing the desktop launcher.", stage: "Electron app ready", elapsedMs: 0 });
const capturePath = process.env.NEURAVIAN_CAPTURE_PATH;
const captureState = process.env.NEURAVIAN_CAPTURE_STATE;
const userDataCompatibility = configureUserDataCompatibility(app);

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

function workspaceServices(): {
  profiles: ConnectionProfileStore;
  client: WorkspaceClient;
  wre: WorkspaceReplicationEngine;
  envManager: ExecutionEnvironmentManager;
  sessionStore: WorkspaceSessionStore;
  runHistory: RunHistoryStore;
} {
  if (!profileStore || !workspaceClient || !workspaceWre || !workspaceEnvManager
      || !workspaceSessionStore || !workspaceRunHistoryStore) {
    const userData = app.getPath("userData");
    profileStore = new ConnectionProfileStore(path.join(userData, "workspaces"), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    });
    workspaceClient = new WorkspaceClient(
      new WorkspaceMetadataCache(path.join(userData, "workspace-metadata")),
      path.join(userData, "run-cache"),
    );
    workspaceWre = new WorkspaceReplicationEngine({
      artifactCacheRoot: path.join(userData, "run-cache"),
      client: workspaceClient,
    });
    workspaceEnvManager = new ExecutionEnvironmentManager(profileStore, workspaceWre);
    workspaceSessionStore = new WorkspaceSessionStore(path.join(userData, "workspace-sessions"));
    workspaceRunHistoryStore = new RunHistoryStore(path.join(userData, "workspace-run-history"));
  }
  return {
    profiles: profileStore,
    client: workspaceClient,
    wre: workspaceWre,
    envManager: workspaceEnvManager,
    sessionStore: workspaceSessionStore,
    runHistory: workspaceRunHistoryStore,
  };
}

function localWorkspace(): LocalWorkspaceStore {
  if (!localWorkspaceStore) {
    localWorkspaceStore = new LocalWorkspaceStore(path.join(app.getPath("userData"), "workspaces"));
  }
  return localWorkspaceStore;
}

async function inspectWorkspaceCache(workspaceId: string): Promise<{
  cacheSizeBytes: number;
  cachedRuns: number;
  cacheEntries: number;
}> {
  if (!/^[a-f0-9-]{36}$/i.test(workspaceId)) throw new Error("Invalid workspace identity.");
  const root = path.join(app.getPath("userData"), "run-cache", workspaceId);
  let cacheSizeBytes = 0;
  let cacheEntries = 0;
  const runIds = new Set<string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (/^run-\d+$/.test(entry.name)) runIds.add(entry.name);
        await walk(target);
      } else if (entry.isFile()) {
        cacheEntries += 1;
        cacheSizeBytes += (await stat(target)).size;
      }
    }
  }
  await walk(root);
  return { cacheSizeBytes, cachedRuns: runIds.size, cacheEntries };
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
  const mainApplicationUrl = new URL("/", FRONTEND_URL);
  mainApplicationUrl.searchParams.set("desktop-launch", attemptId ?? "startup");
  let restoredEntryLoad: Promise<void> | null = null;
  const enforceDesktopHome = (
    _event: Electron.Event,
    url: string,
    isMainFrame: boolean,
  ) => {
    if (!mainWindow || !isMainFrame || restoredEntryLoad) return;
    const navigated = new URL(url);
    if (navigated.origin !== mainApplicationUrl.origin || navigated.pathname === "/") return;
    restoredEntryLoad = withTimeout(
      mainWindow.loadURL(mainApplicationUrl.toString()),
      "Renderer home restoration",
      STARTUP_TIMEOUTS.rendererLoadMs,
    ).then(() => { mainWindow?.webContents.navigationHistory.clear(); });
  };
  mainWindow.webContents.on("did-navigate-in-page", enforceDesktopHome);
  try {
    await withTimeout(mainWindow.loadURL(mainApplicationUrl.toString()), "Renderer load", STARTUP_TIMEOUTS.rendererLoadMs);
    mainWindow.webContents.navigationHistory.clear();
    // Chromium can restore an in-page history entry several seconds after the
    // root document finishes loading. Observe only the startup window, restore
    // Home once if needed, then remove the listener before normal navigation.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    if (restoredEntryLoad) await restoredEntryLoad;
    applicationLoaded = true;
    trace({ attemptId, stage: 19, name: "app URL loaded into main window", detail: FRONTEND_URL, elapsedMs: Date.now() - startedAt });
    trace({ attemptId, stage: 20, name: "startup shell removed", elapsedMs: Date.now() - startedAt });
    // Poll for the React app to hydrate (sidebar renders "Neuravian" once mounted).
    // A single check at 6 s is unreliable on cold starts; poll every 500 ms for up to 20 s.
    const visible = await mainWindow.webContents.executeJavaScript(`
      new Promise(resolve => {
        const deadline = Date.now() + 20_000;
        (function check() {
          if (document.title === 'Neuravian' || (document.body && document.body.innerText.includes('Neuravian'))) {
            return resolve(true);
          }
          if (Date.now() >= deadline) return resolve(false);
          setTimeout(check, 500);
        })();
      })
    `, true).catch(() => false) as boolean;
    if (!visible) throw new Error("The Neuravian document loaded but its main UI was not visible.");
    trace({ attemptId, stage: 21, name: "main Neuravian UI visible", elapsedMs: Date.now() - startedAt });
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
  } finally {
    mainWindow?.webContents.off("did-navigate-in-page", enforceDesktopHome);
  }
}

async function captureWindow(target: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const image = await mainWindow.webContents.capturePage();
  await writeFile(target, image.toPNG());
}

async function openFolder(relative: string): Promise<void> {
  const target = path.join(runtimeDataDir, relative);
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
      message: `Neuravian cannot ${action} while a scientific run is active.`,
      detail: `Active or queued run IDs: ${activity.runIds.join(", ")}. Return to Neuravian and let the run finish.`,
      buttons: ["Return to Neuravian"],
    });
    mainWindow?.show();
    return false;
  } catch (error) {
    await showMessage({
      type: "warning",
      title: "Run status unavailable",
      message: `Neuravian did not ${action} because it could not verify that pipeline execution is idle.`,
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["Return to Neuravian"],
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
  publish({ state: "failed", title: "Services stopped", detail: "Neuravian services are stopped. Select Retry to start them again.", recoverable: true });
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
  let detail = "Thin local desktop launcher for the existing Neuravian application.";
  try {
    const response = await fetch("http://127.0.0.1:8000/api/about", { signal: AbortSignal.timeout(4_000) });
    if (response.ok) {
      const about = await response.json() as { version?: string; backend_version?: string; git_commit?: string; license?: string };
      detail = `Version ${about.version ?? app.getVersion()}\nBackend ${about.backend_version ?? "unknown"}\nCommit ${about.git_commit ?? "unknown"}\n${about.license ?? "Apache 2.0"}`;
    }
  } catch { /* The launcher remains identifiable if services are stopped. */ }
  await showMessage({ title: "About Neuravian", message: "Neuravian", detail, icon: assetPath("neuravian-logo.png") });
}

function installMenu(): void {
  const statusLabel = startupState.get().title;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "Neuravian",
      submenu: [
        { label: "About Neuravian", click: () => { void showAbout(); } },
        { type: "separator" },
        { label: `Neuravian: ${statusLabel}`, enabled: false },
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
        { label: "Quit Neuravian", accelerator: "Command+Q", click: () => { void requestQuit(); } },
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
        message: "Neuravian will remain open because active-run status could not be verified.",
        detail: error instanceof Error ? error.message : String(error), buttons: ["Return to Neuravian"],
      });
      return;
    }
    if (activity.active) {
      const result = await showMessage({
        type: "warning", title: "Scientific run active",
        message: "A scientific run is active. Neuravian will not stop its services by default.",
        detail: `Active or queued run IDs: ${activity.runIds.join(", ")}`,
        buttons: ["Cancel", "Leave Neuravian services running", "Return to Neuravian"],
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
    title: "Neuravian", ...bounds, minWidth: 1024, minHeight: 700, show: false,
    backgroundColor: "#090d18", icon: assetPath("neuravian-logo.png"),
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

  // Resolve runtime paths and log the decision so startup failures are diagnosable.
  let runtimePaths: import("./paths.js").RuntimePaths;
  try {
    runtimePaths = resolveRuntimePaths({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath("userData"),
      dirname: __dirname,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[startup] Failed to resolve runtime paths:", message);
    publish({
      state: "failed",
      title: "Application resources missing",
      detail: message,
      stage: "path resolution",
      recoverable: false,
    });
    return;
  }

  runtimeResourcesRoot = runtimePaths.resourcesRoot;
  runtimeDataDir = runtimePaths.dataDir;

  console.log("[startup] packaged           :", runtimePaths.packaged);
  console.log("[startup] resourcesRoot      :", runtimeResourcesRoot);
  console.log("[startup] dataDir            :", runtimeDataDir);
  console.log("[startup] compose files from :", path.join(runtimeResourcesRoot, "docker-compose.yml"));

  const ctx = { resourcesRoot: runtimeResourcesRoot, dataDir: runtimeDataDir, packaged: runtimePaths.packaged };
  compose = new DesktopCompose(ctx);
  startup = new StartupController(
    ctx,
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
ipcMain.handle("viewers:detect", async (_event, overrides: Partial<Record<ExternalViewerId, string>> = {}) => {
  if (!["darwin", "win32", "linux"].includes(process.platform)) return [];
  const platform = process.platform as DesktopPlatform;
  const saved = await loadViewerSettings(app.getPath("userData"));
  return await Promise.all((["freeview", "mricrogl"] as const).map(
    (viewerId) => detectViewer(viewerId, platform, overrides[viewerId] ?? saved[viewerId]),
  ));
});
ipcMain.handle("viewers:browse-for-executable", async (_event, viewerId: string) => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
    title: `Locate ${viewerId === "mricrogl" ? "MRIcroGL" : viewerId} executable`,
    properties: ["openFile"],
    filters: process.platform === "win32" ? [{ name: "Executables", extensions: ["exe"] }] : [],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
ipcMain.handle("viewers:save-configured", async (
  _event,
  input: { viewerId: string; executablePath: string | null },
) => {
  await saveViewerSetting(app.getPath("userData"), input.viewerId, input.executablePath);
  return true;
});
ipcMain.handle(VIEWER_CHANNELS.readArtifact, async (
  _event,
  input: ReadArtifactRequest,
) => {
  const { workspaceId, runId, relativePath } = input;
  if (typeof workspaceId !== "string" || /[/\\]/.test(workspaceId) || !workspaceId) {
    throw new Error("Invalid workspaceId.");
  }
  if (!Number.isInteger(runId) || runId < 1) throw new Error("Invalid runId.");
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.includes("\0")) {
    throw new Error("Unsafe artifact path rejected.");
  }
  const root = path.resolve(app.getPath("userData"), "run-cache", workspaceId, `run-${runId}`, "artifacts");
  const file = path.resolve(root, normalized);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Artifact path escaped cache root.");
  return await readFile(file);
});
ipcMain.handle(VIEWER_CHANNELS.assertDefaultScene, async (
  _event,
  request: DefaultViewerSceneRequest,
) => {
  if (request.files.length !== 1 || request.files[0]?.intendedRole !== "base image") {
    throw new Error("Invalid viewer payload: a default launch requires exactly one semantic base image.");
  }
  const metadataPath = path.join(
    app.getPath("userData"), "run-cache", request.workspaceId, `run-${request.runId}`, "run-metadata.json",
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    artifacts: Array<{ relativePath: string }>;
  };
  if (!metadata.artifacts.some((artifact) => artifact.relativePath === request.files[0].relativePath)) {
    throw new Error("Invalid viewer payload: the selected base image is not present in the synchronized run cache.");
  }
  return true;
});
ipcMain.handle("workspaces:list", async () => await workspaceServices().profiles.list());
ipcMain.handle("workspaces:local-identity", async () => await localWorkspace().get());
ipcMain.handle("workspaces:save", async (
  _event,
  input: {
    id?: string; name: string; serverUrl: string; username?: string; password?: string;
    connectionMode?: "url" | "instance-id"; instanceId?: string | null; awsRegion?: string | null;
  },
) => await workspaceServices().profiles.save(input));
ipcMain.handle("workspaces:remove", async (_event, profileId: string) => {
  await workspaceServices().profiles.remove(profileId);
  return true;
});
ipcMain.handle("workspaces:sync", async (_event, profileId: string) => {
  const { profiles, wre, sessionStore, runHistory } = workspaceServices();
  let profile = (await profiles.list()).find((item) => item.id === profileId);
  if (!profile) throw new Error("Workspace profile not found.");

  // Retrieve the stored credential. If it was encrypted by a different application
  // identity (e.g. old bundle ID org.neuroforge.desktop), safeStorage will reject
  // decryption. We return the cached snapshot instead of crashing so the user still
  // sees their projects, runs, and datasets — only the credential needs re-entry.
  let credential: import("./workspace-types.js").WorkspaceCredential | null = null;
  let credentialFailed = false;
  try {
    credential = await profiles.credential(profileId);
  } catch (err) {
    if (err instanceof CredentialDecryptionError) {
      credentialFailed = true;
      const { WorkspaceMetadataCache } = await import("./workspace-cache.js");
      const cached = await new WorkspaceMetadataCache(
        path.join(app.getPath("userData"), "workspace-metadata"),
      ).read(profileId);
      const freshProfile = (await profiles.list()).find((item) => item.id === profileId) ?? profile;
      const updated: WorkspaceProfile = { ...freshProfile, connectionState: "offline" };
      await profiles.update(updated);
      console.warn(`[workspaces:sync] Credential decryption failed for profile ${profileId} — returning cached snapshot. User must re-enter credentials.`);
      return {
        online: false,
        profile: updated,
        credentialFailed: true,
        credentialFailedMessage: err.message,
        snapshot: cached ?? {
          schemaVersion: 1 as const,
          workspaceId: freshProfile.serverIdentity ?? "",
          profileId,
          serverUrl: freshProfile.serverUrl,
          synchronizedAt: freshProfile.lastSync ?? new Date().toISOString(),
          projects: [], datasets: [], workflows: [], runs: [], reports: [],
        },
      };
    }
    throw err;
  }

  // For EC2 instance-id workspaces, resolve state before attempting any connection.
  let ec2Health: import("./workspace-types.js").Ec2ConnectionHealth | null = null;
  if (profile.connectionMode === "instance-id") {
    ec2Health = await resolveEc2State(profile);

    if (ec2Health.resolvedServerUrl && ec2Health.resolvedServerUrl !== profile.serverUrl) {
      // IP changed — update the stored URL so subsequent syncs use the new address.
      profile = { ...profile, serverUrl: ec2Health.resolvedServerUrl, serverIdentity: null };
      await profiles.update(profile);
    }

    // If the instance is stopped or pending we cannot connect — return cached snapshot.
    if (ec2Health.instanceState === "stopped" || ec2Health.instanceState === "stopping"
      || ec2Health.instanceState === "pending" || !ec2Health.publicIp) {
      const { WorkspaceMetadataCache } = await import("./workspace-cache.js");
      const cached = await new WorkspaceMetadataCache(
        path.join(app.getPath("userData"), "workspace-metadata"),
      ).read(profileId);
      // Re-read to avoid clobbering concurrent user saves (same fix as the non-early-exit path).
      const freshProfile = (await profiles.list()).find((item) => item.id === profileId) ?? profile;
      const updated: WorkspaceProfile = { ...freshProfile, connectionState: "offline" };
      await profiles.update(updated);
      return {
        online: false,
        profile: updated,
        ec2Health,
        snapshot: cached ?? {
          schemaVersion: 1 as const,
          workspaceId: profile.serverIdentity ?? "",
          profileId,
          serverUrl: profile.serverUrl,
          synchronizedAt: profile.lastSync ?? new Date().toISOString(),
          projects: [], datasets: [], workflows: [], runs: [], reports: [],
        },
      };
    }
  }

  const result = await wre.synchronize({ ...profile, connectionState: "syncing" }, credential);
  // Re-read from disk before writing so we don't overwrite concurrent settings changes
  // (e.g. user changing region in the Connection tab while a sync is in flight).
  // We only own: serverIdentity, lastSync, connectionState.
  const freshProfile = (await profiles.list()).find((item) => item.id === profileId) ?? profile;
  const updated: WorkspaceProfile = {
    ...freshProfile,
    serverUrl: profile.serverUrl, // keep the resolved URL from this sync run
    serverIdentity: result.snapshot.workspaceId,
    lastSync: result.snapshot.synchronizedAt,
    connectionState: result.online ? "connected" : "offline",
  };
  await profiles.update(updated);

  // Build run history entries from this sync's snapshot.
  const incomingEntries: SessionRunHistoryEntry[] = result.snapshot.runs.map((r) => ({
    runId: r.id,
    remoteKey: r.remoteKey,
    pipelineId: r.pipeline_manifest_id,
    pipelineName: r.pipeline_manifest_id,
    datasetId: r.dataset_id,
    status: r.status,
    launchedAt: r.created_at,
    finishedAt: r.finished_at ?? null,
    cacheState: r.cacheState,
    artifactCount: r.artifacts.length,
    fenceComplete: false,
  }));

  // Persist to the durable run history index (append-only, never trimmed).
  // Persist to the session (recentRunHistory = last 50, display cache only).
  // Both awaited: the sync response is not returned until local persistence is complete.
  const recentHistory = await runHistory
    .append(profileId, incomingEntries)
    .then(() => runHistory.loadRecent(profileId, 50))
    .catch((err) => {
      console.error("[sync] Run history save failed:", err);
      return incomingEntries.slice(-50);  // degrade to in-memory slice on failure
    });

  await sessionStore
    .updateFromSnapshot(profileId, result.snapshot, result.online, recentHistory)
    .catch((err) => console.error("[sync] Session save failed:", err));

  return { ...result, profile: updated, ec2Health };
});

ipcMain.handle("workspaces:run-history", async (
  _event,
  input: { profileId: string; page?: number; pageSize?: number },
) => {
  const { runHistory } = workspaceServices();
  return runHistory.loadPage(input.profileId, input.page ?? 0, input.pageSize ?? 100);
});

ipcMain.handle("workspaces:load-session", async (_event, profileId: string) => {
  const { sessionStore } = workspaceServices();
  // Load both in parallel — both are fast local reads (< 10 ms each).
  const userData = app.getPath("userData");
  const [session, cachedSnapshot] = await Promise.all([
    sessionStore.load(profileId),
    new WorkspaceMetadataCache(path.join(userData, "workspace-metadata")).read(profileId),
  ]);
  return { session, cachedSnapshot: cachedSnapshot ?? null };
});

ipcMain.handle("workspaces:save-ui-state", async (
  _event,
  input: { profileId: string; uiState: unknown },
) => {
  const { sessionStore } = workspaceServices();
  await sessionStore.saveUiState(
    input.profileId,
    input.uiState as import("./workspace-types.js").SessionUIState,
  );
  return { ok: true };
});

ipcMain.handle("workspaces:test", async (_event, profileId: string) => {
  const { profiles, client } = workspaceServices();
  const profile = (await profiles.list()).find((item) => item.id === profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  return await client.testConnection(profile, await profiles.credential(profile.id));
});
ipcMain.handle("workspaces:inspect", async (
  _event,
  input: { profileId: string; workspaceId: string },
) => {
  const profiles = workspaceServices().profiles;
  const profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  if (profile.serverIdentity && profile.serverIdentity !== input.workspaceId) {
    throw new Error("Workspace identity mismatch.");
  }
  const userData = app.getPath("userData");
  const configured = await loadViewerSettings(userData);
  const [cache, viewers] = await Promise.all([
    inspectWorkspaceCache(input.workspaceId),
    Promise.all((["freeview", "mricrogl"] as const).map(
      (viewerId) => detectViewer(viewerId, process.platform as DesktopPlatform, configured[viewerId]),
    )),
  ]);
  const legacyCacheEntries = await detectLegacyRunCaches(path.join(app.getPath("userData"), "run-cache"));
  return { ...cache, viewers, legacyCacheEntries };
});
ipcMain.handle("workspaces:open-run", async (
  _event,
  input: { profileId: string; runId: number },
) => {
  if (!Number.isInteger(input.runId) || input.runId < 1) throw new Error("Invalid run ID.");
  const profile = (await workspaceServices().profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  await shell.openExternal(new URL(`/runs/${input.runId}`, `${profile.serverUrl}/`).toString());
  return true;
});
ipcMain.handle("workspaces:sync-artifacts", async (
  _event,
  input: { profileId: string; workspaceId: string; runId: number; relativePaths: string[] },
) => {
  const { profiles, wre } = workspaceServices();
  const profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  if (profile.serverIdentity && profile.serverIdentity !== input.workspaceId) {
    throw new Error("Workspace identity mismatch.");
  }
  return await wre.syncArtifacts(
    profile,
    await profiles.credential(profile.id),
    input.workspaceId,
    input.runId,
    input.relativePaths,
  );
});
ipcMain.handle("workspaces:sync-all-run-artifacts", async (
  _event,
  input: { profileId: string; workspaceId: string; runId: number },
) => {
  const { profiles, wre } = workspaceServices();
  const profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  if (profile.serverIdentity && profile.serverIdentity !== input.workspaceId) {
    throw new Error("Workspace identity mismatch.");
  }
  return await wre.syncAllRunArtifacts(
    profile,
    await profiles.credential(input.profileId),
    input.workspaceId,
    input.runId,
  );
});

ipcMain.handle("workspaces:sync-workflow-inputs", async (
  _event,
  input: { profileId: string; executionUuid: string; upstreamRunId: number; artifactType: string },
) => {
  if (!/^[0-9a-f-]{36}$/i.test(input.executionUuid)) throw new Error("Invalid workflow execution UUID.");
  if (!Number.isInteger(input.upstreamRunId) || input.upstreamRunId < 1) throw new Error("Invalid upstream run ID.");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.artifactType)) throw new Error("Invalid artifact type.");
  const { profiles, wre } = workspaceServices();
  const profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  return await wre.syncWorkflowInputs(
    profile,
    await profiles.credential(input.profileId),
    input.executionUuid,
    input.upstreamRunId,
    input.artifactType,
  );
});

ipcMain.handle("workspaces:prepare-workflow-handoff", async (
  _event,
  input: {
    profileId: string; workflowId: number; executionUuid: string; idempotencyKey: string;
    upstreamRunId: number; artifactType: string; state: Record<string, unknown>;
  },
) => {
  const { profiles, envManager, wre } = workspaceServices();
  let profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  const credential = await profiles.credential(input.profileId);
  if (profile.connectionMode === "instance-id") {
    const launched = await envManager.launch(input.profileId, credential);
    profile = launched.profile;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (credential) headers.Authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  const createExecution = (workflowId: number) => fetch(new URL(`/api/workflows/${workflowId}/executions`, `${profile.serverUrl}/`).toString(), {
    method: "POST", headers,
    body: JSON.stringify({
      execution_uuid: input.executionUuid,
      idempotency_key: input.idempotencyKey,
      remote_profile_id: input.profileId,
      state: input.state,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  let cloudWorkflowId = input.workflowId;
  let response = await createExecution(cloudWorkflowId);
  if (response.status === 404) {
    const workflowResponse = await fetch(new URL("/api/workflows", `${profile.serverUrl}/`).toString(), {
      method: "POST", headers,
      body: JSON.stringify({ name: "Mixed-location workflow", state: input.state }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!workflowResponse.ok) throw new Error(`Cloud workflow registration failed: HTTP ${workflowResponse.status}`);
    const cloudWorkflow = await workflowResponse.json() as { id: number };
    cloudWorkflowId = cloudWorkflow.id;
    response = await createExecution(cloudWorkflowId);
  }
  if (!response.ok) throw new Error(`Cloud workflow handoff failed: HTTP ${response.status}`);
  const execution = await response.json() as Record<string, unknown>;
  const persistedExecutionUuid = String(execution.execution_uuid ?? input.executionUuid);
  const sync = await wre.syncWorkflowInputs(
    profile, credential, persistedExecutionUuid, input.upstreamRunId, input.artifactType,
  );
  const localRunResponse = await fetch(`http://127.0.0.1:8000/api/runs/${input.upstreamRunId}`);
  if (!localRunResponse.ok) throw new Error(`Local run lookup failed: HTTP ${localRunResponse.status}`);
  const localRun = await localRunResponse.json() as { dataset_id: number };
  const localDatasetResponse = await fetch(`http://127.0.0.1:8000/api/datasets/${localRun.dataset_id}`);
  if (!localDatasetResponse.ok) throw new Error(`Local dataset lookup failed: HTTP ${localDatasetResponse.status}`);
  const localDataset = await localDatasetResponse.json() as { id: number; name?: string | null };
  const remoteDatasetResponse = await fetch(
    new URL(`/api/workflow-executions/${persistedExecutionUuid}/dataset`, `${profile.serverUrl}/`).toString(),
    {
      method: "POST",
      headers,
      body: JSON.stringify({ source_dataset_id: localDataset.id, name: localDataset.name ?? null }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!remoteDatasetResponse.ok) {
    const text = await remoteDatasetResponse.text().catch(() => remoteDatasetResponse.statusText);
    throw new Error(`Cloud dataset materialization failed: HTTP ${remoteDatasetResponse.status}: ${text}`);
  }
  const remoteDataset = await remoteDatasetResponse.json() as { id: number };
  return {
    execution,
    executionUuid: persistedExecutionUuid,
    cloudWorkflowId,
    remoteDatasetId: remoteDataset.id,
    sourceDatasetId: localDataset.id,
    ...sync,
  };
});

ipcMain.handle("workspaces:update-workflow-execution", async (
  _event,
  input: {
    profileId: string; executionUuid: string; expectedRevision: number; status: string;
    currentNodeId?: string | null; returnSyncComplete?: boolean; state: Record<string, unknown>;
  },
) => {
  const profiles = workspaceServices().profiles;
  const profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  const credential = await profiles.credential(input.profileId);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (credential) headers.Authorization = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
  const response = await fetch(new URL(`/api/workflow-executions/${input.executionUuid}`, `${profile.serverUrl}/`).toString(), {
    method: "PATCH", headers,
    body: JSON.stringify({
      expected_revision: input.expectedRevision, status: input.status,
      current_node_id: input.currentNodeId ?? null, remote_profile_id: input.profileId,
      return_sync_complete: input.returnSyncComplete ?? false, state: input.state,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Workflow state update failed: HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
});

ipcMain.handle("workspaces:push-project", async (
  _event,
  input: {
    profileId: string;
    // objectId and revision are optional for backward compatibility with callers
    // that pre-date WRE. When absent, WRE generates a deterministic objectId from
    // the project's server id so the same project always maps to the same object.
    objectId?: string;
    revision?: number;
    project: Record<string, unknown>;
    timestamps?: { createdAt?: string; modifiedAt?: string };
  },
) => {
  const { profiles, wre } = workspaceServices();
  const profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  const credential = await profiles.credential(input.profileId);
  const { randomUUID } = await import("node:crypto");
  const objectId = input.objectId ?? randomUUID();
  const revision  = input.revision ?? 1;
  const obj = wre.buildObject(objectId, "project", revision, input.project, input.timestamps);
  return await wre.pushObjects(profile, credential, [obj]);
});
ipcMain.handle("workspaces:push-workflow", async (
  _event,
  input: {
    profileId: string;
    objectId?: string;
    revision?: number;
    workflow: Record<string, unknown>;
    timestamps?: { createdAt?: string; modifiedAt?: string };
  },
) => {
  const { profiles, wre } = workspaceServices();
  const profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  const credential = await profiles.credential(input.profileId);
  const { randomUUID } = await import("node:crypto");
  const objectId = input.objectId ?? randomUUID();
  const revision  = input.revision ?? 1;
  const obj = wre.buildObject(objectId, "workflow", revision, input.workflow, input.timestamps);
  return await wre.pushObjects(profile, credential, [obj]);
});
ipcMain.handle("workspaces:replicate-objects", async (
  _event,
  input: { profileId: string; objects: unknown[] },
) => {
  const { profiles, wre } = workspaceServices();
  const profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  const credential = await profiles.credential(input.profileId);
  const { isNeuravianObject } = await import("./workspace-types.js");
  const valid = input.objects.filter(isNeuravianObject);
  if (valid.length !== input.objects.length) throw new Error("One or more objects failed NeuravianObject validation.");
  return await wre.pushObjects(profile, credential, valid);
});
ipcMain.handle("workspaces:launch-pipeline", async (
  _event,
  input: {
    profileId: string;
    pipelineId: string;
    datasetId: number;
    lineage?: {
      upstream_run_id: number;
      upstream_pipeline_id: string;
      upstream_pipeline_display_name?: string;
      artifact_type: string;
      artifact_label: string;
      injected_param?: string;
      injected_path?: string;
      external?: boolean;
      upstream_workspace_id?: string;
      workflow_execution_uuid?: string;
    };
    params?: Record<string, unknown>;
    autoStart?: boolean;
  },
) => {
  const { profiles, envManager } = workspaceServices();
  let profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  const credential = await profiles.credential(input.profileId);

  // Resolve the current public address even when EC2 is already running.
  // A stop/start can change its IP while leaving a stale saved gateway URL.
  if (profile.connectionMode === "instance-id") {
    const { resolveEc2State: getState } = await import("./workspace-client.js");
    const health = await getState(profile);
    if (input.autoStart && health.instanceState !== "running") {
      const launched = await envManager.launch(input.profileId, credential);
      profile = launched.profile;
    } else if (health.resolvedServerUrl && health.resolvedServerUrl !== profile.serverUrl) {
      profile = { ...profile, serverUrl: health.resolvedServerUrl, serverIdentity: null };
      await profiles.update(profile);
    }
  }

  // POST to the cloud VM's /api/runs
  const authHeader = credential
    ? `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`
    : null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader) headers["Authorization"] = authHeader;

  const runsUrl = new URL("/api/runs", `${profile.serverUrl}/`).toString();
  const response = await fetch(runsUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      pipeline_id: input.pipelineId,
      dataset_id: input.datasetId,
      lineage: input.lineage,
      params: input.params ?? {},
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Cloud VM returned HTTP ${response.status} when creating run: ${text}`);
  }
  const run = await response.json() as { id: number; status: string };

  // Start the SSE event stream so live progress flows to the renderer.
  startCloudStream(
    input.profileId,
    profile.serverUrl,
    authHeader,
    () => mainWindow,
  );

  // Auto-stop: if enabled, subscribe to WRE events and stop the environment
  // automatically when the run finishes (success or failure).
  if (profile.autoStopAfterRun && profile.connectionMode === "instance-id") {
    const { wre } = workspaceServices();
    const unsubscribe = wre.on(async (event) => {
      if (event.type !== "run:status-changed") return;
      if (event.status !== "success" && event.status !== "failed") return;
      unsubscribe();
      stopCloudStream(input.profileId);
      try {
        const freshProfile = (await profiles.list()).find((p) => p.id === input.profileId);
        if (!freshProfile) return;
        const freshCredential = await profiles.credential(input.profileId);
        const workspaceId = profile.serverIdentity ?? null;
        await envManager.stop(input.profileId, freshCredential, workspaceId);
        // Notify renderer that the environment is now offline.
        mainWindow?.webContents.send("cloud:event", {
          profileId: input.profileId,
          type: "vm:stopped-auto",
          runId: run.id,
        });
      } catch (err) {
        // Log but do not rethrow — run already finished, this is cleanup.
        console.error("[auto-stop] failed:", err);
      }
    });
  }

  return { runId: run.id, status: run.status, profileId: input.profileId };
});

ipcMain.handle("workspaces:set-auto-stop", async (
  _event,
  input: { profileId: string; enabled: boolean },
) => {
  const profiles = workspaceServices().profiles;
  const all = await profiles.list();
  const profile = all.find((p) => p.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  const updated = { ...profile, autoStopAfterRun: input.enabled };
  await profiles.update(updated);
  return updated;
});

ipcMain.handle("workspaces:shutdown-fence", async (
  _event,
  input: { profileId: string; workspaceId: string },
) => {
  const { profiles, wre } = workspaceServices();
  const profile = (await profiles.list()).find((item) => item.id === input.profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  const credential = await profiles.credential(input.profileId);
  return await wre.shutdownFence(profile, credential, input.workspaceId);
});
ipcMain.handle("workspaces:duplicate", async (_event, profileId: string) => {
  return await workspaceServices().profiles.duplicate(profileId);
});
ipcMain.handle("workspaces:export", async (_event, profileId: string) => {
  const profiles = workspaceServices().profiles;
  const profile = (await profiles.list()).find((item) => item.id === profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  return profiles.exportProfile(profile);
});
ipcMain.handle("workspaces:import", async (
  _event,
  input: { name?: string; serverUrl: string; username?: string; password?: string; connectionMode?: "url" | "instance-id"; instanceId?: string | null; awsRegion?: string | null },
) => {
  return await workspaceServices().profiles.save({
    name: input.name ?? "Imported Workspace",
    serverUrl: input.serverUrl,
    username: input.username,
    password: input.password,
    connectionMode: input.connectionMode,
    instanceId: input.instanceId,
    awsRegion: input.awsRegion,
  });
});
ipcMain.handle("workspaces:reset-cache", async (_event, workspaceId: string) => {
  if (!workspaceId || /[/\\]/.test(workspaceId)) throw new Error("Invalid workspaceId.");
  const cacheDir = path.join(app.getPath("userData"), "run-cache", workspaceId);
  try { await rm(cacheDir, { recursive: true, force: true }); } catch { /* already empty */ }
  return true;
});
ipcMain.handle("workspaces:clear-credentials", async (_event, profileId: string) => {
  await workspaceServices().profiles.clearCredential(profileId);
  return true;
});
ipcMain.handle("workspaces:resolve-instance-url", async (_event, profileId: string) => {
  const profiles = workspaceServices().profiles;
  const profile = (await profiles.list()).find((item) => item.id === profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  const health = await resolveEc2State(profile);
  if (!health.resolvedServerUrl) return null;
  const updated = { ...profile, serverUrl: health.resolvedServerUrl, serverIdentity: null };
  await profiles.update(updated);
  return updated;
});
ipcMain.handle("workspaces:get-ec2-state", async (_event, profileId: string) => {
  const profiles = workspaceServices().profiles;
  const profile = (await profiles.list()).find((item) => item.id === profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  if (profile.connectionMode !== "instance-id") {
    return null; // Not an EC2-managed workspace.
  }
  return await resolveEc2State(profile);
});
ipcMain.handle("workspaces:launch-environment", async (_event, input: { profileId: string }) => {
  const { profiles, envManager } = workspaceServices();
  const credential = await profiles.credential(input.profileId);
  const result = await envManager.launch(input.profileId, credential);
  return result;
});

ipcMain.handle("workspaces:start-environment", async (_event, profileId: string) => {
  // Thin alias: just issues start-instances and returns. Does not wait for healthy.
  // Use workspaces:launch-environment for the full orchestrated startup.
  const profiles = workspaceServices().profiles;
  const profile = (await profiles.list()).find((item) => item.id === profileId);
  if (!profile) throw new Error("Workspace profile not found.");
  if (profile.connectionMode !== "instance-id") {
    throw new Error("Start environment is only available for EC2 instance-id workspaces.");
  }
  await startEc2Instance(profile);
  return { started: true };
});

ipcMain.handle("workspaces:stop-environment", async (_event, input: { profileId: string; workspaceId?: string; runFence?: boolean }) => {
  const { envManager, profiles } = workspaceServices();
  const credential = await profiles.credential(input.profileId);
  stopCloudStream(input.profileId);
  return await envManager.stop(input.profileId, credential, input.workspaceId ?? null);
});

ipcMain.handle("workspaces:pull-to-local", async (
  _event,
  input: { type: "project" | "workflow"; data: Record<string, unknown> },
) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const route = input.type === "project" ? "/api/projects" : "/api/workflows";
  const response = await fetch(`http://127.0.0.1:8000${route}`, {
    method: "POST", headers, body: JSON.stringify(input.data),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Local Neuravian returned HTTP ${response.status}: ${text}`);
  }
  return response.json();
});

ipcMain.handle("viewers:launch-local", async (_event, request: LocalViewerLaunchRequest) => {
  const identity = await localWorkspace().get();
  if (request.workspaceId !== identity.workspaceId) throw new Error("Local workspace identity mismatch.");
  const [runResponse, manifestResponse] = await Promise.all([
    fetch(`http://127.0.0.1:8000/api/runs/${request.runId}`),
    fetch(`http://127.0.0.1:8000/api/runs/${request.runId}/sync-manifest`),
  ]);
  if (!runResponse.ok || !manifestResponse.ok) throw new Error("Local run metadata is unavailable.");
  const run = await runResponse.json() as { output_dir?: string | null };
  const manifest = await manifestResponse.json() as SyncManifest;
  const requested = new Set(request.files.map((file) => file.relativePath));
  if ([...requested].some((relative) => !manifest.artifacts.some((artifact) => artifact.relativePath === relative))) {
    throw new Error("Local viewer launch requested an unregistered artifact.");
  }
  validateVolumeGeometry([...requested], manifest.artifacts);
  const containerPrefix = "/app/data/";
  const outputRoot = run.output_dir?.startsWith(containerPrefix)
    ? path.join(runtimeDataDir, run.output_dir.slice(containerPrefix.length))
    : path.resolve(run.output_dir ?? "");
  const derivativesRoot = path.join(runtimeDataDir, "derivatives");
  if (!outputRoot.startsWith(`${derivativesRoot}${path.sep}`)) throw new Error("Local run output is outside Neuravian derivatives.");
  const detection = await detectViewer(request.viewerId, process.platform as DesktopPlatform);
  if (!detection.installed || !detection.executable) throw new Error(detection.reason ?? "Viewer is not installed.");
  const command = commandForLocalPreset(request, detection.executable, outputRoot);
  await launchViewer(command, outputRoot);
  return true;
});
ipcMain.handle(VIEWER_CHANNELS.launch, async (_event, request: ViewerLaunchRequest) => {
  if ((request.launchMode ?? "default") === "default" &&
      (request.files.length !== 1 || request.files[0]?.intendedRole !== "base image")) {
    throw new Error("Invalid viewer payload: a default launch requires exactly one semantic base image.");
  }
  if (!["darwin", "win32", "linux"].includes(process.platform)) throw new Error("External viewers are unavailable on this platform.");
  const detection = await detectViewer(request.viewerId, process.platform as DesktopPlatform);
  if (!detection.installed || !detection.executable) throw new Error(detection.reason ?? "Viewer is not installed.");
  const cacheRoot = request.workspaceId
    ? path.join(app.getPath("userData"), "run-cache", request.workspaceId)
    : path.join(app.getPath("userData"), "run-cache");
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
  await logger.trace({
    stage: "user-data",
    name: userDataCompatibility.mode === "canonical" ? "Neuravian user data selected" : "Legacy user data retained",
    detail: userDataCompatibility.mode === "canonical"
      ? `path=${userDataCompatibility.activePath}`
      : `legacy_path=${userDataCompatibility.activePath}; canonical_path=${userDataCompatibility.canonicalPath}`,
  });
  trace({ stage: 1, name: "Electron app ready", detail: `version=${app.getVersion()} architecture=${process.arch}` });
  installMenu();
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});
app.on("before-quit", (event) => { if (!allowQuit) { event.preventDefault(); void requestQuit(); } });
