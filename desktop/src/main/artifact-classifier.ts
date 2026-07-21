// Semantic artifact classifier for the desktop main process.
//
// This module mirrors the classification logic in
// frontend/src/lib/artifact-capabilities.ts. It runs at artifact
// sync time (write-once) so the renderer never has to re-derive roles
// from filenames at render time.
//
// When updating classification rules, update both files together.
// The two implementations are intentionally separate: the desktop runs
// in Node.js main and cannot import from the renderer bundle.

import type { ArtifactSemanticRole } from "./workspace-types.js";

interface BidsEntities {
  values: Record<string, string>;
  suffix: string | null;
}

function parseBidsEntities(filename: string): BidsEntities {
  const stem = filename.replace(/\.nii\.gz$/i, "").replace(/\.[^.]+$/i, "");
  const parts = stem.split("_");
  const values: Record<string, string> = {};
  let suffix: string | null = null;
  for (const part of parts) {
    const dashIdx = part.indexOf("-");
    if (dashIdx > 0) {
      values[part.slice(0, dashIdx)] = part.slice(dashIdx + 1);
    } else {
      suffix = part;
    }
  }
  return { values, suffix };
}

const SURFACE_EXTENSIONS = [
  ".pial", ".white", ".inflated", ".sphere",
  ".curv", ".sulc", ".thickness", ".area", ".label",
];

const ANATOMICAL_SUFFIXES = new Set([
  "T1w", "T2w", "T2star", "FLAIR", "PDw", "PDT2",
  "inplaneT1", "inplaneT2", "angio",
]);

const ANATOMICAL_MGZ_STEMS = new Set([
  "orig", "orig_nu", "nu", "t1", "brain", "wm", "filled", "rawavg", "norm",
]);

/**
 * Classify a single artifact's semantic role from its relativePath.
 *
 * Priority when called from sync:
 *   1. Use manifest-declared role if already set on the incoming artifact.
 *   2. Otherwise derive from filename conventions (this function).
 */
export function classifyArtifactRole(artifact: { relativePath: string }): ArtifactSemanticRole {
  const filename = artifact.relativePath.split("/").pop() ?? artifact.relativePath;
  const filenameLower = filename.toLowerCase();
  const pathLower = artifact.relativePath.toLowerCase();

  // Spatial transforms
  if (/\.(h5|mat|lta|xfm|tfm)$/i.test(filenameLower)) return "transform";

  // Reports
  if (filenameLower.endsWith(".html")) return "report";

  // Mesh surfaces
  if (SURFACE_EXTENSIONS.some((ext) => filenameLower.endsWith(ext))) return "surface";

  // Defaced intensity volumes
  if (/(?:^|\/)defaced\.nii(?:\.gz)?$/i.test(artifact.relativePath) ||
      /_defaced\.nii(?:\.gz)?$/i.test(artifact.relativePath)) {
    return "defaced-intensity";
  }

  // NIfTI: BIDS entity-based classification
  if (/\.nii(?:\.gz)?$/i.test(filenameLower)) {
    const { values, suffix } = parseBidsEntities(filename);
    if (suffix !== null) {
      if (ANATOMICAL_SUFFIXES.has(suffix)) return "anatomical-intensity";
      if (suffix === "dseg" || suffix === "aseg") return "segmentation";
      if (suffix === "probseg") return "probability-map";
      if (suffix === "mask") return "mask";
      if (suffix === "boldref" || suffix === "bold") return "functional-intensity";
      if (suffix === "dwi") return "diffusion-intensity";
      if (["stat", "zstat", "tstat", "fstat", "zmap", "tmap"].includes(suffix)) return "statistical-map";
    }
    if (/\baseg\b/.test(pathLower) || /\baparc\b/.test(pathLower)) return "segmentation";
    if (/\bmask\b/.test(pathLower)) return "mask";
    void values;
    return "unknown-volume";
  }

  // MGZ/MGH: FreeSurfer/FastSurfer output conventions
  if (/\.(?:mgz|mgh)$/i.test(filenameLower)) {
    const stem = filenameLower.replace(/\.(?:mgz|mgh)$/, "").split("/").pop() ?? "";
    if (ANATOMICAL_MGZ_STEMS.has(stem)) return "anatomical-intensity";
    if (/^aseg|aparc/.test(stem) || stem.includes("aseg") || stem.includes("aparc")) return "segmentation";
    if (stem.includes("mask") || stem.endsWith("brainmask")) return "mask";
    return "unknown-volume";
  }

  return "other";
}
