import type { NiivueLayer } from "../components/domain/NeuroImageViewer";

export type FmriprepArtifactRole =
  | "anatomical-intensity"
  | "binary-mask"
  | "discrete-label"
  | "probability-map"
  | "functional-reference"
  | "functional-timeseries"
  | "transform"
  | "confounds"
  | "report"
  | "reportlet"
  | "other";

export type FmriprepVisualizationMode =
  | "intensity"
  | "mask-overlay"
  | "label-overlay"
  | "probability-overlay"
  | "timeseries"
  | "report"
  | "tabular"
  | "none";

export interface FmriprepFile {
  name: string;
  path: string;
  size?: number;
}

export interface FmriprepDerivative extends FmriprepFile {
  role: FmriprepArtifactRole;
  modality: "anatomical" | "functional" | "report" | "metadata" | "unknown";
  subject: string | null;
  session: string | null;
  task: string | null;
  run: string | null;
  space: string | null;
  suffix: string | null;
  descriptor: string | null;
  label: string | null;
  visualizationMode: FmriprepVisualizationMode;
  preferredBase: "anatomical" | "functional" | null;
  overlaySemantics: "binary" | "categorical" | "probability" | null;
  section:
    | "QC Report"
    | "Anatomical"
    | "Tissue Segmentation"
    | "Spatial Normalization"
    | "Functional References"
    | "Preprocessed BOLD"
    | "Confounds"
    | "Transforms"
    | "Other Files";
}

const NIFTI = /\.nii(?:\.gz)?$/i;

function stem(name: string) {
  return name.replace(/\.nii\.gz$/i, "").replace(/\.[^.]+$/i, "");
}

function entities(name: string) {
  const parts = stem(name).split("_");
  const values: Record<string, string> = {};
  let suffix: string | null = null;
  for (const part of parts) {
    const split = part.indexOf("-");
    if (split > 0) values[part.slice(0, split)] = part.slice(split + 1);
    else suffix = part;
  }
  return { values, suffix };
}

export function classifyFmriprepDerivative(file: FmriprepFile): FmriprepDerivative {
  const { values, suffix } = entities(file.name);
  const path = file.path.toLowerCase();
  const extension = file.name.toLowerCase();
  const anatomical = /(^|\/)anat\//.test(path) || suffix === "T1w" || suffix === "mask" || suffix === "dseg" || suffix === "probseg";
  const functional = /(^|\/)func\//.test(path) || suffix === "bold" || suffix === "boldref" || suffix === "timeseries";
  let role: FmriprepArtifactRole = "other";
  let visualizationMode: FmriprepVisualizationMode = "none";
  let preferredBase: FmriprepDerivative["preferredBase"] = null;
  let overlaySemantics: FmriprepDerivative["overlaySemantics"] = null;

  if (/\.html$/i.test(extension) && !path.includes("/")) {
    role = "report"; visualizationMode = "report";
  } else if (/\.svg$/i.test(extension) || /figures\/.*\.html$/i.test(path)) {
    role = "reportlet"; visualizationMode = "report";
  } else if (/\.(h5|mat|txt)$/i.test(extension) && /(^|[_/])from-|(^|[_/])to-|xfm|transform/.test(path)) {
    role = "transform";
  } else if (/desc-confounds_(timeseries\.)?(tsv|json)$/i.test(extension)) {
    role = "confounds"; visualizationMode = "tabular";
  } else if (NIFTI.test(extension) && suffix === "dseg") {
    role = "discrete-label"; visualizationMode = "label-overlay"; preferredBase = "anatomical"; overlaySemantics = "categorical";
  } else if (NIFTI.test(extension) && suffix === "probseg") {
    role = "probability-map"; visualizationMode = "probability-overlay"; preferredBase = "anatomical"; overlaySemantics = "probability";
  } else if (NIFTI.test(extension) && suffix === "mask") {
    role = "binary-mask"; visualizationMode = "mask-overlay"; preferredBase = functional ? "functional" : "anatomical"; overlaySemantics = "binary";
  } else if (NIFTI.test(extension) && suffix === "boldref") {
    role = "functional-reference"; visualizationMode = "intensity";
  } else if (NIFTI.test(extension) && suffix === "bold" && values.desc === "preproc") {
    role = "functional-timeseries"; visualizationMode = "timeseries";
  } else if (NIFTI.test(extension) && suffix === "T1w" && values.desc === "preproc") {
    role = "anatomical-intensity"; visualizationMode = "intensity";
  }

  let section: FmriprepDerivative["section"] = "Other Files";
  if (role === "report" || role === "reportlet") section = "QC Report";
  else if (role === "confounds") section = "Confounds";
  else if (role === "transform") section = "Transforms";
  else if (role === "discrete-label" || role === "probability-map") section = "Tissue Segmentation";
  else if (role === "functional-reference" || (role === "binary-mask" && functional)) section = "Functional References";
  else if (role === "functional-timeseries") section = "Preprocessed BOLD";
  else if (role === "anatomical-intensity" && values.space) section = "Spatial Normalization";
  else if (role === "anatomical-intensity" || (role === "binary-mask" && anatomical)) section = "Anatomical";

  return {
    ...file,
    role,
    modality: anatomical ? "anatomical" : functional ? "functional" : role === "report" || role === "reportlet" ? "report" : role === "confounds" || role === "transform" ? "metadata" : "unknown",
    subject: values.sub ?? null,
    session: values.ses ?? null,
    task: values.task ?? null,
    run: values.run ?? null,
    space: values.space ?? null,
    suffix,
    descriptor: values.desc ?? null,
    label: values.label ?? null,
    visualizationMode,
    preferredBase,
    overlaySemantics,
    section,
  };
}

function entityCompatible(a: FmriprepDerivative, b: FmriprepDerivative, key: "subject" | "session" | "task" | "run") {
  return !a[key] || !b[key] || a[key] === b[key];
}

export function bidsPairCompatible(base: FmriprepDerivative, overlay: FmriprepDerivative) {
  if (base.role !== "anatomical-intensity" && base.role !== "functional-reference") return false;
  if (base.space !== overlay.space) return false;
  if (!entityCompatible(base, overlay, "subject") || !entityCompatible(base, overlay, "session")) return false;
  if (overlay.preferredBase === "functional") {
    if (base.role !== "functional-reference") return false;
    return entityCompatible(base, overlay, "task") && entityCompatible(base, overlay, "run");
  }
  return overlay.preferredBase === "anatomical" && base.role === "anatomical-intensity";
}

export function preferredBaseFor(overlay: FmriprepDerivative, candidates: FmriprepDerivative[]) {
  return candidates.find((candidate) => bidsPairCompatible(candidate, overlay)) ?? null;
}

export function fmriprepLayer(file: FmriprepDerivative, runId: number): NiivueLayer {
  const artifactType = file.role === "anatomical-intensity" ? "fmriprep_anatomical"
    : file.role === "functional-reference" ? "fmriprep_boldref"
    : file.role === "functional-timeseries" ? "fmriprep_bold"
    : file.role === "binary-mask" ? "fmriprep_brain_mask"
    : file.role === "discrete-label" ? "fmriprep_dseg"
    : file.role === "probability-map" ? "fmriprep_probseg"
    : undefined;
  return {
    url: `/api/runs/${runId}/files/${file.path}`,
    name: file.name,
    artifactType,
    pipelineId: "fmriprep",
    isSegmentation: file.role === "discrete-label",
    opacity: file.role === "binary-mask" ? 0.4 : file.role === "discrete-label" ? 0.7 : file.role === "probability-map" ? 0.55 : 1,
    colormap: file.role === "binary-mask" ? "redyell" : file.role === "probability-map" ? "viridis" : undefined,
    metadata: {
      subject: file.subject, session: file.session, task: file.task, run: file.run,
      space: file.space, descriptor: file.descriptor, label: file.label, role: file.role,
    },
  };
}

export function fmriprepDisplayName(file: FmriprepDerivative) {
  const label = file.label ? `${file.label} ` : "";
  if (file.role === "anatomical-intensity") return `${file.space ? `${file.space} ` : "Native "}preprocessed T1w`;
  if (file.role === "binary-mask") return `${file.space ? `${file.space} ` : ""}${file.modality === "functional" ? "functional " : ""}brain mask`;
  if (file.role === "discrete-label") return `${file.space ? `${file.space} ` : ""}tissue segmentation`;
  if (file.role === "probability-map") return `${file.space ? `${file.space} ` : ""}${label}probability map`;
  if (file.role === "functional-reference") return `${file.descriptor ? `${file.descriptor} ` : ""}BOLD reference`;
  if (file.role === "functional-timeseries") return "Preprocessed BOLD time series";
  if (file.role === "confounds") return "Confounds";
  if (file.role === "transform") return "Spatial transform";
  if (file.role === "report") return "Official fMRIPrep participant report";
  return file.name;
}
