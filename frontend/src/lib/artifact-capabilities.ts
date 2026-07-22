// ── Artifact Capability Resolver ─────────────────────────────────────────────
//
// Single source of truth for which file types each viewer can open AND what
// semantic role each artifact plays (anatomical intensity, segmentation, etc.).
//
// The UI never inspects filenames, pipeline identities, or BIDS entities
// directly — it only asks capability questions and acts on the answers.
//
// Adding support for a new pipeline or file format:
//   • If the new pipeline produces standard file types (NIfTI, MGZ), no
//     changes are required — existing rules already cover them.
//   • If the pipeline produces a new semantic suffix (e.g. "dwi2" for a
//     future modality), add one entry to the NIfTI suffix table in
//     classifyArtifactRole. No UI code needs to change.

import { classifyNeuroArtifact } from "./neuroArtifactView";

// ── Viewer capability ─────────────────────────────────────────────────────────

export type ViewerId = "freeview" | "mricrogl" | "neuravian-viewer";

export interface ArtifactCapabilities {
  /** Which viewers can open this artifact. */
  viewableIn: ViewerId[];
  /** True for NIfTI and MGZ/MGH spatial volumes. */
  isVolume: boolean;
  /** True for FreeSurfer-style mesh surfaces (.pial, .white, etc.). */
  isSurface: boolean;
  /** True for HTML/PDF reports. */
  isReport: boolean;
}

/**
 * Classify a single artifact's viewer compatibility by its relativePath.
 *
 * This is the only function in the codebase that maps file extensions to
 * viewer compatibility. All extension knowledge lives here.
 */
export function resolveArtifactCapabilities(relativePath: string): ArtifactCapabilities {
  const name = relativePath.split("/").pop() ?? relativePath;
  const artifact = classifyNeuroArtifact({ name, path: relativePath });
  if (artifact.kind === "volume") {
    return { viewableIn: ["freeview", "mricrogl", "neuravian-viewer"], isVolume: true, isSurface: false, isReport: false };
  }
  if (["surface", "surface-overlay", "annotation"].includes(artifact.kind)) {
    return { viewableIn: ["freeview"], isVolume: false, isSurface: true, isReport: false };
  }
  if (artifact.kind === "report") {
    return { viewableIn: [], isVolume: false, isSurface: false, isReport: true };
  }
  return { viewableIn: [], isVolume: false, isSurface: false, isReport: false };
}

// ── Run-level aggregation ─────────────────────────────────────────────────────

export interface RunViewerCapabilities {
  /** All artifacts compatible with FreeView (cached or not). Needed for the online-download path. */
  freeview: WorkspaceArtifact[];
  /** All artifacts compatible with MRIcroGL (cached or not). */
  mricrogl: WorkspaceArtifact[];
  /** All artifacts compatible with the Neuravian Viewer (cached or not). */
  neuravianViewer: WorkspaceArtifact[];

  /** Subset of freeview that are currently cached locally. */
  freeviewCached: WorkspaceArtifact[];
  /** Subset of mricrogl that are currently cached locally. */
  mricroglCached: WorkspaceArtifact[];
  /** Subset of neuravianViewer that are currently cached locally. */
  neuravianViewerCached: WorkspaceArtifact[];
}

/**
 * Given a run's full artifact manifest and its local cache state, return the
 * per-viewer lists that CloudRunDetail needs to determine viewer availability
 * and to build launch payloads.
 */
export function resolveRunViewerCapabilities(
  run: Pick<WorkspaceRun, "artifacts" | "cachedArtifacts">,
): RunViewerCapabilities {
  const cachedSet = new Set(run.cachedArtifacts);

  const freeview = run.artifacts.filter((a) =>
    resolveArtifactCapabilities(a.relativePath).viewableIn.includes("freeview"),
  );
  const mricrogl = run.artifacts.filter((a) =>
    resolveArtifactCapabilities(a.relativePath).viewableIn.includes("mricrogl"),
  );
  const neuravianViewer = run.artifacts.filter((a) =>
    resolveArtifactCapabilities(a.relativePath).viewableIn.includes("neuravian-viewer"),
  );

  return {
    freeview,
    mricrogl,
    neuravianViewer,
    freeviewCached:          freeview.filter((a) => cachedSet.has(a.relativePath)),
    mricroglCached:          mricrogl.filter((a) => cachedSet.has(a.relativePath)),
    neuravianViewerCached:  neuravianViewer.filter((a) => cachedSet.has(a.relativePath)),
  };
}

/**
 * Select one geometry-compatible volume stack for a viewer launch.
 * A synchronized run can contain native, template-space, anatomical, and
 * functional volumes; sending all of them together is invalid.
 */
export function selectGeometryCompatibleArtifacts(
  artifacts: WorkspaceArtifact[],
): WorkspaceArtifact[] {
  if (artifacts.length < 2) return artifacts;

  const volumeGroups = new Map<string, WorkspaceArtifact[]>();
  for (const artifact of artifacts) {
    const capability = resolveArtifactCapabilities(artifact.relativePath);
    if (!capability.isVolume) continue;
    const key = artifact.geometry ? JSON.stringify(artifact.geometry) : `single:${artifact.relativePath}`;
    const group = volumeGroups.get(key) ?? [];
    group.push(artifact);
    volumeGroups.set(key, group);
  }

  const groups = [...volumeGroups.values()];
  if (groups.length === 0) return artifacts;
  return groups.reduce((best, group) => group.length > best.length ? group : best);
}

// ── Semantic classification ───────────────────────────────────────────────────
//
// Assigns a semantic role to each artifact based on file naming conventions,
// BIDS entities, and well-known FreeSurfer/FastSurfer output patterns.
//
// Rules:
//   • No pipeline names. A T1w NIfTI is anatomical-intensity whether it came
//     from fMRIPrep, FastSurfer, or any future pipeline.
//   • No regex scattered across the UI. All extension and naming knowledge
//     lives here.
//   • BIDS suffix takes precedence for NIfTI files. MGZ files use a
//     separate table of FreeSurfer output conventions.

export type ArtifactSemanticRole =
  | "defaced-intensity"    // structural after face removal (defaced.nii.gz, *_defaced.nii.gz)
  | "anatomical-intensity" // preprocessed/native structural (T1w, T2w, FLAIR, MGZ anatomicals)
  | "functional-intensity" // BOLD reference or preprocessed BOLD
  | "diffusion-intensity"  // DWI/DTI intensity volume
  | "segmentation"         // discrete label map (dseg, aseg, aparc, parcellation)
  | "mask"                 // binary brain or tissue mask
  | "probability-map"      // tissue probability (probseg)
  | "statistical-map"      // stat/z/t/F contrast images
  | "surface"              // mesh surface file
  | "transform"            // spatial transform (h5, mat, lta, xfm)
  | "report"               // HTML/PDF quality report
  | "unknown-volume"       // NIfTI/MGZ we cannot classify further
  | "other";               // non-spatial, non-viewable

// ── Internal helpers ──────────────────────────────────────────────────────────

interface BidsEntities {
  /** Entity key→value map, e.g. { sub: "01", desc: "preproc", space: "MNI152NLin2009cAsym" } */
  values: Record<string, string>;
  /** The final underscore-delimited token that has no dash, e.g. "T1w", "bold", "dseg" */
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

/**
 * Returns true when the BIDS `space` entity represents the subject's native
 * (individual) space rather than a standard template space.
 */
function isNativeSpace(space: string | null | undefined): boolean {
  if (!space) return true;
  const s = space.toLowerCase();
  return s === "t1w" || s === "individual" || s === "native";
}

// BIDS anatomical suffixes that represent intensity volumes (structural MRI)
const ANATOMICAL_SUFFIXES = new Set([
  "T1w", "T2w", "T2star", "FLAIR", "PDw", "PDT2",
  "inplaneT1", "inplaneT2", "angio",
]);

// Well-known FreeSurfer/FastSurfer MGZ filenames that are anatomical intensity
const ANATOMICAL_MGZ_STEMS = new Set([
  "orig", "orig_nu", "nu", "t1", "brain", "wm", "filled",
  "rawavg", "norm",
]);

/**
 * Classify a single artifact's semantic role.
 *
 * The caller should never need to inspect pipeline identity or filenames
 * directly — ask the role instead.
 */
export function classifyArtifactRole(artifact: WorkspaceArtifact): ArtifactSemanticRole {
  const filename = artifact.relativePath.split("/").pop() ?? artifact.relativePath;
  const filenameLower = filename.toLowerCase();
  const pathLower = artifact.relativePath.toLowerCase();

  // ── 1. Spatial transforms (check before volume heuristics) ───────────────
  if (/\.(h5|mat|lta|xfm|tfm)$/i.test(filenameLower)) return "transform";

  // ── 2. Reports ────────────────────────────────────────────────────────────
  if (filenameLower.endsWith(".html")) return "report";

  // ── 3. Mesh surfaces ──────────────────────────────────────────────────────
  if (
    resolveArtifactCapabilities(artifact.relativePath).isSurface
  ) return "surface";

  // ── 4. Defaced intensity volumes ──────────────────────────────────────────
  // Matches: defaced.nii.gz  /  sub-01_T1w_defaced.nii.gz  /  any *defaced*.nii.gz
  if (/(?:^|\/)defaced\.nii(?:\.gz)?$/i.test(artifact.relativePath) ||
      /_defaced\.nii(?:\.gz)?$/i.test(artifact.relativePath)) {
    return "defaced-intensity";
  }

  // ── 5. NIfTI: BIDS entity–based classification ───────────────────────────
  if (/\.nii(?:\.gz)?$/i.test(filenameLower)) {
    const { values, suffix } = parseBidsEntities(filename);

    if (suffix !== null) {
      // Anatomical structural intensity
      if (ANATOMICAL_SUFFIXES.has(suffix)) return "anatomical-intensity";

      // Discrete segmentation / label map
      if (suffix === "dseg" || suffix === "aseg") return "segmentation";

      // Tissue probability maps
      if (suffix === "probseg") return "probability-map";

      // Binary masks
      if (suffix === "mask") return "mask";

      // Functional: BOLD reference or preprocessed BOLD
      if (suffix === "boldref" || suffix === "bold") return "functional-intensity";

      // Diffusion
      if (suffix === "dwi") return "diffusion-intensity";

      // Statistical maps
      if (["stat", "zstat", "tstat", "fstat", "zmap", "tmap"].includes(suffix)) {
        return "statistical-map";
      }
    }

    // Fallback path-based hints for unlabelled NIfTIs
    if (/\baseg\b/.test(pathLower) || /\baparc\b/.test(pathLower)) return "segmentation";
    if (/\bmask\b/.test(pathLower)) return "mask";

    void values; // parsed but not needed for the fallback
    return "unknown-volume";
  }

  // ── 6. MGZ/MGH: FreeSurfer/FastSurfer output conventions ─────────────────
  if (/\.(?:mgz|mgh)$/i.test(filenameLower)) {
    const stem = filenameLower.replace(/\.(?:mgz|mgh)$/, "").split("/").pop() ?? "";

    if (ANATOMICAL_MGZ_STEMS.has(stem)) return "anatomical-intensity";

    // aseg.auto → "aseg" prefix; aparc+aseg → "aparc" match
    if (/^aseg|aparc/.test(stem) || stem.includes("aseg") || stem.includes("aparc")) {
      return "segmentation";
    }

    if (stem.includes("mask") || stem.endsWith("brainmask")) return "mask";

    return "unknown-volume";
  }

  return "other";
}

// ── Default viewer scene selection ───────────────────────────────────────────
//
// Chooses the single best base image from a set of viewer-compatible artifacts.
// The ranking is data-driven: it uses the semantic role and native-space status
// of each artifact, never the pipeline that produced it.
//
// Priority table (lower number = selected first):
//   0  defaced-intensity          (de-identified structural — safest to share)
//   1  anatomical-intensity, native space
//   2  anatomical-intensity, template space
//   3  functional-intensity, native space
//   4  functional-intensity, template space
//   5  diffusion-intensity
//   6  unknown-volume
//   ∞  mask / segmentation / probability-map / statistical-map /
//      surface / transform / report / other
//      (these are NEVER auto-selected as the primary base image unless
//       no better option exists — see final fallback below)

function rolePriority(
  role: ArtifactSemanticRole,
  space: string | null | undefined,
): number {
  if (role === "defaced-intensity") return 0;
  if (role === "anatomical-intensity") return isNativeSpace(space) ? 1 : 2;
  if (role === "functional-intensity") return isNativeSpace(space) ? 3 : 4;
  if (role === "diffusion-intensity")  return 5;
  if (role === "unknown-volume")       return 6;
  return Infinity; // mask, segmentation, probability-map, etc.
}

/**
 * Select the single best base image artifact for a default viewer launch.
 *
 * Returns null only when `artifacts` is empty.
 * Returns `artifacts[0]` as a final fallback when every artifact has an
 * excluded role (mask, segmentation, etc.) and no intensity image exists.
 *
 * The caller is responsible for ensuring the returned artifact is locally
 * cached before launching a viewer.
 */
export function selectDefaultViewerScene(
  artifacts: WorkspaceArtifact[],
): WorkspaceArtifact | null {
  if (artifacts.length === 0) return null;
  if (artifacts.length === 1) return artifacts[0];

  let best: WorkspaceArtifact = artifacts[0];
  let bestPriority = Infinity;

  for (const artifact of artifacts) {
    // Phase 2: use pre-computed role from sync time when available.
    // Legacy artifacts (no semanticRole) fall back to filename inference.
    const role = artifact.semanticRole ?? classifyArtifactRole(artifact);
    const { values } = parseBidsEntities(
      artifact.relativePath.split("/").pop() ?? artifact.relativePath,
    );
    const priority = rolePriority(role, values["space"] ?? null);
    if (priority < bestPriority) {
      best = artifact;
      bestPriority = priority;
    }
  }

  return best;
}
