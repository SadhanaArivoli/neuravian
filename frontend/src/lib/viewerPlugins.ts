import type { ArtifactViewModel, NeuroArtifactRole } from "./neuroArtifactView";

export type ViewerId = "neuroforge" | "freeview" | "mricrogl";
export type ViewerPlatform = "browser" | "darwin" | "win32" | "linux";
export type ViewerAvailability = "available" | "not-installed" | "browser-unavailable" | "unsupported";

export interface ViewerInstallation {
  viewerId: ViewerId;
  availability: ViewerAvailability;
  executable: string | null;
  reason: string | null;
}

export interface ViewerLaunchFile {
  artifactId?: string | number;
  path: string;
  role: NeuroArtifactRole;
  format: string;
  subject: string | null;
  space: string | null;
}

export interface ViewerLaunchPreset {
  id: string;
  displayName: string;
  files: ViewerLaunchFile[];
  opacity?: number;
  interpolation?: "nearest" | "linear";
  lut?: "freesurfer";
}

export interface ViewerCommand {
  executable: string;
  args: string[];
}

export interface ViewerPlugin {
  id: ViewerId;
  displayName: string;
  platforms: ViewerPlatform[];
  roles: NeuroArtifactRole[];
  formats: string[];
  localOnly: boolean;
  defaultInstallPaths: Partial<Record<Exclude<ViewerPlatform, "browser">, string[]>>;
  supports(artifact: ArtifactViewModel): boolean;
  buildCommand(installation: ViewerInstallation, preset: ViewerLaunchPreset): ViewerCommand;
}

const VOLUME_ROLES: NeuroArtifactRole[] = [
  "structural", "functional-reference", "functional-timeseries", "binary-mask",
  "discrete-segmentation", "probability-map", "statistical-map",
];
const SURFACE_ROLES: NeuroArtifactRole[] = [
  "surface-geometry", "surface-scalar", "surface-annotation", "segmentation-statistics",
];
const VOLUME_FORMATS = [".nii", ".nii.gz", ".mgz", ".mgh"];

function supports(plugin: Pick<ViewerPlugin, "roles" | "formats">, artifact: ArtifactViewModel) {
  return plugin.roles.includes(artifact.role) && plugin.formats.includes(artifact.format);
}

function requireExecutable(installation: ViewerInstallation) {
  if (installation.availability !== "available" || !installation.executable) {
    throw new Error(installation.reason ?? `${installation.viewerId} is not available.`);
  }
  return installation.executable;
}

function rejectUnsafePath(path: string) {
  if (!path || path.includes("\0") || path.replace(/\\/g, "/").split("/").includes("..")) {
    throw new Error("Viewer launch rejected an unsafe artifact path.");
  }
  return path;
}

const neuroforge: ViewerPlugin = {
  id: "neuroforge",
  displayName: "NeuroForge Viewer",
  platforms: ["browser", "darwin", "win32", "linux"],
  roles: [...VOLUME_ROLES, ...SURFACE_ROLES, "quality-report", "reportlet"],
  formats: [...VOLUME_FORMATS, ".surf", ".surf.gii", ".html", ".svg", ".png", ".jpg", ".jpeg", ".stats"],
  localOnly: false,
  defaultInstallPaths: {},
  supports(artifact) { return artifact.canView; },
  buildCommand() { throw new Error("The built-in NeuroForge Viewer does not launch an external command."); },
};

const freeview: ViewerPlugin = {
  id: "freeview",
  displayName: "FreeView",
  platforms: ["darwin", "win32", "linux"],
  roles: [...VOLUME_ROLES, ...SURFACE_ROLES],
  formats: [...VOLUME_FORMATS, "unknown", ".surf", ".surf.gii", ".annot", ".label", ".stats"],
  localOnly: true,
  defaultInstallPaths: {
    darwin: ["/Applications/Freeview.app/Contents/MacOS/freeview", "/Applications/freesurfer/bin/freeview"],
    win32: ["C:\\Program Files\\FreeSurfer\\bin\\freeview.exe"],
    linux: ["/usr/local/freesurfer/bin/freeview", "/opt/freesurfer/bin/freeview", "/usr/bin/freeview"],
  },
  supports(artifact) { return supports(this, artifact); },
  buildCommand(installation, preset) {
    const args: string[] = [];
    const volumes = preset.files.filter((file) => VOLUME_ROLES.includes(file.role));
    const surfaces = preset.files.filter((file) => SURFACE_ROLES.includes(file.role));
    if (volumes.length) {
      args.push("-v", ...volumes.map((file, index) => {
        const options = [rejectUnsafePath(file.path)];
        if (index > 0 && preset.opacity != null) options.push(`opacity=${preset.opacity}`);
        if (index > 0 && preset.lut === "freesurfer") options.push("colormap=lut");
        return options.join(":");
      }));
    }
    for (const surface of surfaces) args.push("-f", rejectUnsafePath(surface.path));
    return { executable: requireExecutable(installation), args };
  },
};

const mricrogl: ViewerPlugin = {
  id: "mricrogl",
  displayName: "MRIcroGL",
  platforms: ["darwin", "win32", "linux"],
  roles: VOLUME_ROLES,
  formats: VOLUME_FORMATS,
  localOnly: true,
  defaultInstallPaths: {
    darwin: ["/Applications/MRIcroGL.app/Contents/MacOS/MRIcroGL"],
    win32: ["C:\\Program Files\\MRIcroGL\\MRIcroGL.exe"],
    linux: ["/usr/bin/MRIcroGL", "/usr/local/bin/MRIcroGL"],
  },
  supports(artifact) { return supports(this, artifact); },
  buildCommand(installation, preset) {
    return {
      executable: requireExecutable(installation),
      args: preset.files.map((file) => rejectUnsafePath(file.path)),
    };
  },
};

export const VIEWER_REGISTRY: readonly ViewerPlugin[] = [neuroforge, freeview, mricrogl];

export function viewerPlugin(id: ViewerId) {
  const plugin = VIEWER_REGISTRY.find((candidate) => candidate.id === id);
  if (!plugin) throw new Error(`Unknown viewer plugin: ${id}`);
  return plugin;
}

export function browserViewerAvailability(plugin: ViewerPlugin): ViewerInstallation {
  return plugin.localOnly
    ? {
        viewerId: plugin.id,
        availability: "browser-unavailable",
        executable: null,
        reason: `${plugin.displayName} is a desktop application. Sync this run to NeuroForge Desktop to open it.`,
      }
    : { viewerId: plugin.id, availability: "available", executable: null, reason: null };
}

function sameScientificFrame(base: ArtifactViewModel, overlay: ArtifactViewModel) {
  return base.subject === overlay.subject
    && (base.space === overlay.space || !base.space || !overlay.space);
}

export function createLaunchPreset(
  selected: ArtifactViewModel,
  candidates: ArtifactViewModel[],
): ViewerLaunchPreset {
  const overlay = selected.canOverlay;
  const base = overlay
    ? candidates.find((candidate) =>
        candidate.role === (selected.preferredBaseRole === "functional" ? "functional-reference" : "structural")
        && sameScientificFrame(candidate, selected))
    : null;
  const files = [base, selected].filter((item): item is ArtifactViewModel => Boolean(item)).map((artifact) => ({
    artifactId: artifact.artifactId,
    path: artifact.path,
    role: artifact.role,
    format: artifact.format,
    subject: artifact.subject,
    space: artifact.space,
  }));
  return {
    id: selected.section.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    displayName: selected.section,
    files,
    opacity: overlay ? (selected.role === "binary-mask" ? 0.5 : 0.7) : 1,
    interpolation: ["binary-mask", "discrete-segmentation"].includes(selected.role) ? "nearest" : "linear",
    lut: selected.role === "discrete-segmentation" ? "freesurfer" : undefined,
  };
}

export function compatibleViewers(artifact: ArtifactViewModel) {
  return VIEWER_REGISTRY.filter((plugin) => plugin.supports(artifact));
}
