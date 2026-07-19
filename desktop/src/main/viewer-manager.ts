import { access, readdir } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type ExternalViewerId = "freeview" | "mricrogl";
export type DesktopPlatform = "darwin" | "win32" | "linux";

export interface ViewerDetection {
  viewerId: ExternalViewerId;
  displayName: string;
  installed: boolean;
  executable: string | null;
  reason: string | null;
}

export interface LaunchCommand {
  viewerId: ExternalViewerId;
  executable: string;
  args: string[];
  environment?: Record<string, string>;
}

export interface ViewerLaunchRequest {
  viewerId: ExternalViewerId;
  runId: number;
  workspaceId?: string;
  files: Array<{ relativePath: string; overlay?: boolean }>;
  opacity?: number;
  freesurferLut?: boolean;
}

export interface LocalViewerLaunchRequest extends ViewerLaunchRequest {
  workspaceId: string;
}

const FREEVIEW_PATHS: Record<DesktopPlatform, string[]> = {
  darwin: ["/Applications/Freeview.app/Contents/MacOS/freeview", "/Applications/freesurfer/bin/freeview"],
  win32: ["C:\\Program Files\\FreeSurfer\\bin\\freeview.exe"],
  linux: ["/usr/local/freesurfer/bin/freeview", "/opt/freesurfer/bin/freeview", "/usr/bin/freeview"],
};

const MRICROGL_PATHS: Record<DesktopPlatform, string[]> = {
  darwin: [],
  win32: ["C:\\Program Files\\MRIcroGL\\MRIcroGL.exe"],
  linux: ["/usr/bin/MRIcroGL", "/usr/local/bin/MRIcroGL"],
};

const DISPLAY_NAMES: Record<ExternalViewerId, string> = {
  freeview: "FreeView",
  mricrogl: "MRIcroGL",
};

async function exists(candidate: string) {
  try { await access(candidate); return true; } catch { return false; }
}

async function runCommandOutput(command: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: timeoutMs, env: process.env });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function findMRIcroGLDarwin(): Promise<{ executable: string | null; searched: string[] }> {
  const searched: string[] = [];

  // 1. PATH
  for (const cmd of ["MRIcroGL", "mricrogl"]) {
    const found = await runCommandOutput("which", [cmd]);
    if (found && path.isAbsolute(found) && await exists(found)) {
      return { executable: found, searched };
    }
  }
  searched.push("PATH (which MRIcroGL / mricrogl): not found");

  // 2. LaunchServices via osascript — finds apps registered with macOS including mounted DMGs
  const appPath = await runCommandOutput("osascript", ["-e", 'POSIX path of (path to application "MRIcroGL")']);
  if (appPath) {
    const bundlePath = appPath.replace(/\/$/, "");
    const exe = path.join(bundlePath, "Contents", "MacOS", "MRIcroGL");
    if (await exists(exe)) return { executable: exe, searched };
    searched.push(`LaunchServices: ${bundlePath} (executable not found at Contents/MacOS/MRIcroGL)`);
  } else {
    searched.push("LaunchServices (osascript): MRIcroGL not registered");
  }

  // 3. Filesystem search: /Applications, ~/Applications, /Volumes/*/
  const roots = ["/Applications", path.join(os.homedir(), "Applications")];
  try {
    const vols = await readdir("/Volumes");
    roots.push(...vols.map((v) => `/Volumes/${v}`));
  } catch { /* /Volumes not available */ }

  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase().startsWith("mricrogl")) {
          const exe = path.join(root, entry.name, "Contents", "MacOS", "MRIcroGL");
          if (await exists(exe)) return { executable: exe, searched };
        }
      }
    } catch { /* skip unreadable */ }
    searched.push(root);
  }

  return { executable: null, searched };
}

export async function versionedFreeViewCandidates(root = "/Applications/freesurfer"): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "Freeview.app", "Contents", "MacOS", "freeview"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

export async function detectViewer(
  viewerId: ExternalViewerId,
  platform: DesktopPlatform,
  configuredPath?: string | null,
): Promise<ViewerDetection> {
  const displayName = DISPLAY_NAMES[viewerId];

  // Configured path (set by user via "Locate…") always takes priority.
  if (configuredPath) {
    if (path.isAbsolute(configuredPath) && await exists(configuredPath)) {
      return { viewerId, displayName, installed: true, executable: configuredPath, reason: null };
    }
    return {
      viewerId, displayName, installed: false, executable: null,
      reason: `${displayName} was not found at the saved path: ${configuredPath}`,
    };
  }

  if (viewerId === "mricrogl" && platform === "darwin") {
    const { executable, searched } = await findMRIcroGLDarwin();
    if (executable) return { viewerId, displayName, installed: true, executable, reason: null };
    return {
      viewerId, displayName, installed: false, executable: null,
      reason: `MRIcroGL not found. Searched: ${searched.join("; ")}`,
    };
  }

  const candidates = viewerId === "freeview"
    ? [...FREEVIEW_PATHS[platform], ...(platform === "darwin" ? await versionedFreeViewCandidates() : [])]
    : MRICROGL_PATHS[platform];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && await exists(candidate)) {
      return { viewerId, displayName, installed: true, executable: candidate, reason: null };
    }
  }
  return {
    viewerId, displayName, installed: false, executable: null,
    reason: `${displayName} was not found in a default installation location.`,
  };
}

export function validateLaunchCommand(command: LaunchCommand, cacheRoot: string): LaunchCommand {
  if (!path.isAbsolute(command.executable)) throw new Error("Viewer executable must be an absolute path.");
  const resolvedRoot = path.resolve(cacheRoot);
  const args = command.args.map((argument) => {
    if (argument.startsWith("-") || !/[\\/]/.test(argument)) return argument;
    const value = argument.includes(":") && !/^[A-Za-z]:\\/.test(argument)
      ? argument.slice(0, argument.indexOf(":"))
      : argument;
    const resolved = path.resolve(value);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error("Viewer launch may only use files in the NeuroForge cache.");
    }
    return argument;
  });
  if (command.environment) {
    const keys = Object.keys(command.environment);
    if (keys.some((key) => key !== "FREESURFER_HOME")) {
      throw new Error("Viewer launch rejected an unsupported environment override.");
    }
    const home = command.environment.FREESURFER_HOME;
    if (!home || !path.isAbsolute(home) || !command.executable.startsWith(`${path.resolve(home)}${path.sep}`)) {
      throw new Error("FreeSurfer environment must contain the selected executable.");
    }
  }
  return { ...command, args };
}

export async function launchViewer(
  command: LaunchCommand,
  cacheRoot: string,
  spawnProcess = spawn,
): Promise<void> {
  const safe = validateLaunchCommand(command, cacheRoot);
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(safe.executable, safe.args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      env: safe.environment ? { ...process.env, ...safe.environment } : undefined,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export function commandForPreset(
  request: ViewerLaunchRequest,
  executable: string,
  cacheRoot: string,
): LaunchCommand {
  if (!Number.isInteger(request.runId) || request.runId < 1 || !request.files.length) {
    throw new Error("Viewer launch requires a synchronized run and at least one artifact.");
  }
  const runRoot = path.join(cacheRoot, `run-${request.runId}`, "artifacts");
  const resolved = request.files.map(({ relativePath, overlay }) => {
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.includes("\0")) {
      throw new Error("Viewer launch rejected an unsafe artifact path.");
    }
    return { path: path.join(runRoot, normalized), overlay };
  });
  if (request.viewerId === "mricrogl") {
    return { viewerId: request.viewerId, executable, args: resolved.map((file) => file.path) };
  }
  return {
    viewerId: request.viewerId,
    executable,
    args: ["-v", ...resolved.map((file) => {
      if (!file.overlay) return file.path;
      const options = [file.path, `opacity=${request.opacity ?? 0.7}`];
      if (request.freesurferLut) options.push("colormap=lut");
      return options.join(":");
    })],
    environment: executable.includes(`${path.sep}Freeview.app${path.sep}`)
      ? { FREESURFER_HOME: executable.slice(0, executable.indexOf(`${path.sep}Freeview.app${path.sep}`)) }
      : undefined,
  };
}

export function commandForLocalPreset(
  request: LocalViewerLaunchRequest,
  executable: string,
  outputRoot: string,
): LaunchCommand {
  if (!request.workspaceId.startsWith("local-") || !Number.isInteger(request.runId) ||
      request.runId < 1 || !request.files.length) {
    throw new Error("Local viewer launch requires a local workspace, run, and artifact.");
  }
  const root = path.resolve(outputRoot);
  const resolved = request.files.map(({ relativePath, overlay }) => {
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.includes("\0")) {
      throw new Error("Viewer launch rejected an unsafe local artifact path.");
    }
    const file = path.resolve(root, normalized);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Local artifact escaped the run output directory.");
    return { path: file, overlay };
  });
  if (request.viewerId === "mricrogl") {
    return { viewerId: request.viewerId, executable, args: resolved.map((file) => file.path) };
  }
  return {
    viewerId: request.viewerId,
    executable,
    args: ["-v", ...resolved.map((file) => {
      if (!file.overlay) return file.path;
      const options = [file.path, `opacity=${request.opacity ?? 0.7}`];
      if (request.freesurferLut) options.push("colormap=lut");
      return options.join(":");
    })],
    environment: executable.includes(`${path.sep}Freeview.app${path.sep}`)
      ? { FREESURFER_HOME: executable.slice(0, executable.indexOf(`${path.sep}Freeview.app${path.sep}`)) }
      : undefined,
  };
}

export function validateVolumeGeometry(
  relativePaths: string[],
  metadataArtifacts: Array<{ relativePath: string; geometry?: unknown }>,
): void {
  const volumes = relativePaths.filter((relativePath) => /\.(nii(?:\.gz)?|mgz|mgh)$/i.test(relativePath));
  if (volumes.length < 2) return;
  const geometries = volumes.map((relativePath) =>
    metadataArtifacts.find((artifact) => artifact.relativePath === relativePath)?.geometry);
  if (geometries.some((geometry) => !geometry)) {
    throw new Error("Multi-volume launch requires recorded affine, shape, orientation, and voxel-size metadata.");
  }
  const expected = JSON.stringify(geometries[0]);
  if (geometries.slice(1).some((geometry) => JSON.stringify(geometry) !== expected)) {
    throw new Error("Viewer launch blocked because the selected volumes do not share identical geometry.");
  }
}
