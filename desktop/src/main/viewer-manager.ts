import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

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
}

export interface ViewerLaunchRequest {
  viewerId: ExternalViewerId;
  runId: number;
  files: Array<{ relativePath: string; overlay?: boolean }>;
  opacity?: number;
  freesurferLut?: boolean;
}

const INSTALL_PATHS: Record<ExternalViewerId, Record<DesktopPlatform, string[]>> = {
  freeview: {
    darwin: ["/Applications/Freeview.app/Contents/MacOS/freeview", "/Applications/freesurfer/bin/freeview"],
    win32: ["C:\\Program Files\\FreeSurfer\\bin\\freeview.exe"],
    linux: ["/usr/local/freesurfer/bin/freeview", "/opt/freesurfer/bin/freeview", "/usr/bin/freeview"],
  },
  mricrogl: {
    darwin: ["/Applications/MRIcroGL.app/Contents/MacOS/MRIcroGL"],
    win32: ["C:\\Program Files\\MRIcroGL\\MRIcroGL.exe"],
    linux: ["/usr/bin/MRIcroGL", "/usr/local/bin/MRIcroGL"],
  },
};

const DISPLAY_NAMES: Record<ExternalViewerId, string> = {
  freeview: "FreeView",
  mricrogl: "MRIcroGL",
};

async function exists(candidate: string) {
  try { await access(candidate); return true; } catch { return false; }
}

export async function detectViewer(
  viewerId: ExternalViewerId,
  platform: DesktopPlatform,
  configuredPath?: string | null,
): Promise<ViewerDetection> {
  const candidates = configuredPath ? [configuredPath] : INSTALL_PATHS[viewerId][platform];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && await exists(candidate)) {
      return { viewerId, displayName: DISPLAY_NAMES[viewerId], installed: true, executable: candidate, reason: null };
    }
  }
  return {
    viewerId,
    displayName: DISPLAY_NAMES[viewerId],
    installed: false,
    executable: null,
    reason: configuredPath
      ? `${DISPLAY_NAMES[viewerId]} was not found at the configured path.`
      : `${DISPLAY_NAMES[viewerId]} was not found in a default installation location.`,
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
