export type NeuroArtifactKind =
  | "volume"
  | "surface"
  | "surface-overlay"
  | "annotation"
  | "statistics"
  | "table"
  | "transform"
  | "report"
  | "image"
  | "log"
  | "metadata"
  | "unsupported";

export type NeuroArtifactRole =
  | "structural"
  | "functional-reference"
  | "functional-timeseries"
  | "binary-mask"
  | "discrete-segmentation"
  | "probability-map"
  | "statistical-map"
  | "surface-geometry"
  | "surface-scalar"
  | "surface-annotation"
  | "segmentation-statistics"
  | "confounds"
  | "spatial-transform"
  | "quality-report"
  | "reportlet"
  | "execution-log"
  | "metadata"
  | "other";

export type DisplayProfileId =
  | "structural-intensity"
  | "functional-intensity"
  | "functional-timeseries"
  | "binary-mask"
  | "discrete-label"
  | "probability"
  | "signed-statistical"
  | "surface"
  | "metadata-only";

export type ArtifactSection =
  | "Official QC Report"
  | "Anatomical"
  | "Segmentation and Masks"
  | "Spatial Normalization"
  | "Functional References"
  | "Preprocessed BOLD"
  | "Confounds"
  | "Transforms"
  | "Figures and Reportlets"
  | "Conformed Anatomy"
  | "Brain and Tissue Segmentations"
  | "Cortical Parcellations"
  | "Cerebellar Segmentation"
  | "Hypothalamic Segmentation"
  | "Surfaces"
  | "Labels and Annotations"
  | "Statistics"
  | "Logs"
  | "Raw Inventory";

export interface ArtifactFileInput {
  name: string;
  path: string;
  size?: number;
  artifactId?: string | number;
}

export interface ArtifactViewModel extends ArtifactFileInput {
  kind: NeuroArtifactKind;
  role: NeuroArtifactRole;
  format: string;
  subject: string | null;
  session: string | null;
  task: string | null;
  run: string | null;
  space: string | null;
  hemisphere: "left" | "right" | null;
  suffix: string | null;
  descriptor: string | null;
  label: string | null;
  section: ArtifactSection;
  displayProfile: DisplayProfileId;
  canView: boolean;
  canOverlay: boolean;
  preferredBaseRole: "anatomical" | "functional" | null;
  requiresClientConversion: boolean;
  unsupportedReason: string | null;
}

const VOLUME_EXTENSIONS = [".nii.gz", ".nii", ".mgz", ".mgh"];
const SURFACE_GIFTI = [".surf.gii"];
const SURFACE_OVERLAY_GIFTI = [".shape.gii", ".func.gii", ".label.gii"];
const TEXT_TABLE_EXTENSIONS = [".tsv", ".csv"];
const TRANSFORM_EXTENSIONS = [".lta", ".xfm", ".mat", ".h5"];

function lowerExtension(name: string) {
  const lower = name.toLowerCase();
  return [
    ".nii.gz", ".surf.gii", ".shape.gii", ".func.gii", ".label.gii",
    ".mgz", ".mgh", ".nii", ".annot", ".label", ".ctab", ".stats",
    ".tsv", ".csv", ".json", ".txt", ".lta", ".xfm", ".mat", ".h5",
    ".html", ".svg", ".png", ".jpg", ".jpeg", ".log", ".w",
  ].find((extension) => lower.endsWith(extension)) ?? "unknown";
}

function stem(name: string) {
  const extension = lowerExtension(name);
  return extension === "unknown" ? name : name.slice(0, -extension.length);
}

function bidsEntities(name: string) {
  const values: Record<string, string> = {};
  let suffix: string | null = null;
  for (const part of stem(name).split("_")) {
    const divider = part.indexOf("-");
    if (divider > 0) values[part.slice(0, divider)] = part.slice(divider + 1);
    else suffix = part || suffix;
  }
  return { values, suffix };
}

function freesurferHemisphere(name: string): "left" | "right" | null {
  if (/^lh[._]/i.test(name)) return "left";
  if (/^rh[._]/i.test(name)) return "right";
  return null;
}

function isFreeSurferGeometry(name: string, path: string) {
  const basename = name.toLowerCase();
  if (SURFACE_GIFTI.some((extension) => basename.endsWith(extension))) return true;
  if (/(^|\/)surf\//i.test(path) && /\.surf$/i.test(basename)) return true;
  return /^(lh|rh)\.(white|pial|inflated|sphere|orig|smoothwm)$/i.test(basename);
}

function sectionFor(pipelineId: string | undefined, role: NeuroArtifactRole, path: string): ArtifactSection {
  const fastsurfer = pipelineId?.toLowerCase() === "fastsurfer" || /(^|\/)mri\//i.test(path)
    || /(^|\/)(surf|label|stats|scripts)\//i.test(path);
  if (fastsurfer) {
    if (role === "structural") return "Conformed Anatomy";
    if (role === "surface-geometry" || role === "surface-scalar") return "Surfaces";
    if (role === "surface-annotation") return "Labels and Annotations";
    if (role === "segmentation-statistics") return "Statistics";
    if (role === "execution-log") return "Logs";
    if (/cereb/i.test(path)) return "Cerebellar Segmentation";
    if (/hypothal/i.test(path)) return "Hypothalamic Segmentation";
    if (/aparc|wmparc|ribbon/i.test(path)) return "Cortical Parcellations";
    if (role === "discrete-segmentation" || role === "binary-mask") return "Brain and Tissue Segmentations";
    if (role === "spatial-transform") return "Transforms";
    return "Raw Inventory";
  }
  if (role === "quality-report") return "Official QC Report";
  if (role === "reportlet") return "Figures and Reportlets";
  if (role === "confounds") return "Confounds";
  if (role === "spatial-transform") return "Transforms";
  if (role === "functional-timeseries") return "Preprocessed BOLD";
  if (role === "functional-reference") return "Functional References";
  if (role === "discrete-segmentation" || role === "binary-mask" || role === "probability-map") return "Segmentation and Masks";
  if (role === "structural" && /space-/i.test(path)) return "Spatial Normalization";
  if (role === "structural") return "Anatomical";
  return "Raw Inventory";
}

export function classifyNeuroArtifact(
  file: ArtifactFileInput,
  pipelineId?: string,
): ArtifactViewModel {
  const path = file.path.replace(/\\/g, "/");
  const lowerPath = path.toLowerCase();
  const lowerName = file.name.toLowerCase();
  const format = lowerExtension(file.name);
  const { values, suffix } = bidsEntities(file.name);
  const inStatsDirectory = /(^|\/)stats\//.test(lowerPath);
  const inLogsDirectory = /(^|\/)(logs?|scripts)\//.test(lowerPath);

  let kind: NeuroArtifactKind = "unsupported";
  let role: NeuroArtifactRole = "other";
  let displayProfile: DisplayProfileId = "metadata-only";
  let preferredBaseRole: ArtifactViewModel["preferredBaseRole"] = null;

  if (inStatsDirectory && (format === ".stats" || format === ".txt" || format === ".mgz")) {
    kind = "statistics"; role = "segmentation-statistics";
  } else if (inLogsDirectory && [".log", ".txt"].includes(format)) {
    kind = "log"; role = "execution-log";
  } else if (isFreeSurferGeometry(file.name, path)) {
    kind = "surface"; role = "surface-geometry"; displayProfile = "surface";
  } else if (SURFACE_OVERLAY_GIFTI.some((extension) => lowerName.endsWith(extension))
      || format === ".w" || /^(lh|rh)\.(curv|sulc|thickness|area|volume)$/i.test(lowerName)) {
    kind = "surface-overlay"; role = "surface-scalar"; displayProfile = "surface";
  } else if ([".annot", ".label", ".ctab"].includes(format)) {
    kind = "annotation"; role = "surface-annotation"; displayProfile = "surface";
  } else if (VOLUME_EXTENSIONS.includes(format)) {
    kind = "volume";
    if (/mask|brainmask/.test(lowerName)) {
      role = "binary-mask"; displayProfile = "binary-mask";
    } else if (/probseg|probabilit/.test(lowerName)) {
      role = "probability-map"; displayProfile = "probability";
    } else if (/dseg|aseg|aparc|wmparc|ribbon|cereb|hypothal|segmentation/.test(lowerName)) {
      role = "discrete-segmentation"; displayProfile = "discrete-label";
    } else if (/boldref/.test(lowerName)) {
      role = "functional-reference"; displayProfile = "functional-intensity";
    } else if (/bold/.test(lowerName)) {
      role = "functional-timeseries"; displayProfile = "functional-timeseries";
    } else if (/zstat|tstat|stat[-_]?map|difference|z[-_]?map/.test(lowerName)) {
      role = "statistical-map"; displayProfile = "signed-statistical";
    } else {
      role = "structural"; displayProfile = "structural-intensity";
    }
    preferredBaseRole = role === "binary-mask" && /(^|\/)func\//.test(lowerPath)
      ? "functional"
      : ["binary-mask", "discrete-segmentation", "probability-map", "statistical-map"].includes(role)
        ? "anatomical"
        : null;
  } else if (format === ".html") {
    kind = "report";
    role = /figures\//.test(lowerPath) ? "reportlet" : "quality-report";
  } else if ([".svg", ".png", ".jpg", ".jpeg"].includes(format)) {
    kind = "image"; role = "reportlet";
  } else if (TEXT_TABLE_EXTENSIONS.includes(format)) {
    kind = "table";
    role = /confounds/.test(lowerName) ? "confounds" : "metadata";
  } else if (TRANSFORM_EXTENSIONS.includes(format) || /xfm|transform/.test(lowerName)) {
    kind = "transform"; role = "spatial-transform";
  } else if (format === ".json" || format === ".txt") {
    kind = "metadata"; role = "metadata";
  }

  const canView = kind === "volume" || kind === "surface" || kind === "report" || kind === "image" || kind === "table" || kind === "statistics" || kind === "log";
  const canOverlay = kind === "volume" && ["binary-mask", "discrete-segmentation", "probability-map", "statistical-map"].includes(role);
  const requiresClientConversion = kind === "volume" && (format === ".mgz" || format === ".mgh");
  const unsupportedReason = canView
    ? null
    : kind === "surface-overlay" || kind === "annotation"
      ? "Open with a compatible surface geometry; this file is not independently renderable."
      : kind === "transform"
        ? "Transform artifacts are metadata-only and are never treated as image volumes."
        : "This format is available for metadata inspection and download."

  return {
    ...file,
    kind,
    role,
    format,
    subject: values.sub ?? path.match(/(?:^|\/)sub-([^/]+)/i)?.[1] ?? null,
    session: values.ses ?? null,
    task: values.task ?? null,
    run: values.run ?? null,
    space: values.space ?? null,
    hemisphere: freesurferHemisphere(file.name),
    suffix,
    descriptor: values.desc ?? null,
    label: values.label ?? null,
    section: sectionFor(pipelineId, role, path),
    displayProfile,
    canView,
    canOverlay,
    preferredBaseRole,
    requiresClientConversion,
    unsupportedReason,
  };
}

export function artifactEntityCompatible(base: ArtifactViewModel, overlay: ArtifactViewModel) {
  if (base.kind !== "volume" || overlay.kind !== "volume") return false;
  if (overlay.preferredBaseRole === "anatomical" && base.role !== "structural") return false;
  if (overlay.preferredBaseRole === "functional" && base.role !== "functional-reference") return false;
  for (const key of ["subject", "session"] as const) {
    if (base[key] && overlay[key] && base[key] !== overlay[key]) return false;
  }
  if ((base.space ?? "native") !== (overlay.space ?? "native")) return false;
  if (overlay.preferredBaseRole === "functional") {
    for (const key of ["task", "run"] as const) {
      if (base[key] && overlay[key] && base[key] !== overlay[key]) return false;
    }
  }
  return true;
}

export function preferredArtifactBase(overlay: ArtifactViewModel, candidates: ArtifactViewModel[]) {
  return candidates.find((candidate) => artifactEntityCompatible(candidate, overlay)) ?? null;
}

export const VIEWER_SUPPORTED_FORMATS = {
  volumes: [".nii", ".nii.gz", ".mgz", ".mgh"],
  surfaces: ["FreeSurfer geometry", ".surf.gii"],
  surfaceOverlays: [".shape.gii", ".func.gii", ".label.gii", ".annot", ".label", ".w"],
} as const;
